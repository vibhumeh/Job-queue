/**
 * cli.ts
 *
 * Interactive owner CLI for the on-chain job queue.
 * Run this in one terminal while worker.ts runs in another.
 *
 * Usage:
 *   ts-node scripts/cli.ts keys/owner.json
 */

import * as anchor from "@coral-xyz/anchor";
import * as readline from "readline";
import { JobQue } from "../target/types/job_que"; // adjust path as needed
import {
  setupProgram,
  fetchAllJobs,
  printJobs,
  statusLabel,
  counterPda,
  sleep,
} from "./common";

const KEYPAIR_PATH = process.argv[2] ?? "./keys/owner.json";

// ── readline setup ────────────────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const prompt = (q: string): Promise<string> =>
  new Promise(resolve => rl.question(q, resolve));

const pressEnter = () => prompt("\nPress Enter to continue...");

// ── helpers ───────────────────────────────────────────────────────────────────
const divider = () => console.log("─".repeat(60));

const header = (ownerKey: anchor.web3.PublicKey) => {
  console.clear();
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║           🔗 On-Chain Job Queue — Owner CLI               ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network : Devnet`);
  console.log(`  Owner   : ${ownerKey.toBase58()}`);
  divider();
};

// ── setup ─────────────────────────────────────────────────────────────────────
const runSetup = async (
  program: anchor.Program<JobQue>,
  ownerKey: anchor.web3.PublicKey
) => {
  console.log("\nRunning one-time setup...\n");

  try {
    await program.methods.initialize().rpc();
    console.log("Global counter initialized");
  } catch (_) {
    console.log("Counter already initialized");
  }

  try {
    await program.methods.initializeOwner().rpc();
    console.log("Owner registered:", ownerKey.toBase58().slice(0, 8) + "...");
  } catch (_) {
    console.log("Owner already registered");
  }
};

// ── commands ──────────────────────────────────────────────────────────────────
const approveWorker = async (
  program: anchor.Program<JobQue>,
  ownerKey: anchor.web3.PublicKey
) => {
  console.log("\nApprove a Worker");
  divider();
  console.log("Tip: a wallet can approve itself to act as both owner and worker for testing purposes.\n");

  const input = await prompt("Enter worker public key: ");
  let workerKey: anchor.web3.PublicKey;

  try {
    workerKey = new anchor.web3.PublicKey(input.trim());
  } catch (_) {
    console.log("Invalid public key.");
    await pressEnter();
    return;
  }

  try {
    const tx = await program.methods.approveWorker(workerKey).rpc();
    console.log("\n Worker approved!");
    console.log(`   Worker : ${workerKey.toBase58()}`);
    console.log(`   Tx     : https://explorer.solana.com/tx/${tx}?cluster=devnet`);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("Worker already approved.");
    } else {
      console.log("Error:", e.message);
    }
  }

  await pressEnter();
};

const addJob = async (
  program: anchor.Program<JobQue>,
) => {
  console.log("\nAdd a New Job");
  divider();

  // get current counter
  let nextId: number;
  try {
    const counter = await program.account.counter.fetch(
      counterPda(program.programId)
    );
    nextId = (counter.jobIdCounter as anchor.BN).toNumber();
    console.log(`Next job ID will be: #${nextId}\n`);
  } catch (_) {
    console.log("Could not fetch counter. Is the program initialized?");
    await pressEnter();
    return;
  }

  const timeoutInput = await prompt("Timeout in seconds (default 30): ");
  const timeout = parseInt(timeoutInput.trim()) || 30;

  try {
    const tx = await program.methods
      .addJob(new anchor.BN(nextId), new anchor.BN(timeout))
      .rpc();
    console.log(`\nJob #${nextId} added!`);
    console.log(`   Timeout : ${timeout}s`);
    console.log(`   Tx      : https://explorer.solana.com/tx/${tx}?cluster=devnet`);
  } catch (e: any) {
    console.log("Error:", e.message);
  }

  await pressEnter();
};

const viewDashboard = async (
  program: anchor.Program<JobQue>,
  ownerKey: anchor.web3.PublicKey
) => {
  console.log("\n📊 Job Dashboard");
  divider();

  const jobs = await fetchAllJobs(program, ownerKey);

  if (jobs.length === 0) {
    console.log("  No jobs found. Add a job first.");
    await pressEnter();
    return;
  }

  const pending   = jobs.filter(j => statusLabel(j.status) === "Pending");
  const active    = jobs.filter(j => statusLabel(j.status) === "Active");
  const timedOut  = jobs.filter(j => statusLabel(j.status) === "Timeout");
  const completed = jobs.filter(j => statusLabel(j.status) === "Completed");
  const failed    = jobs.filter(j => statusLabel(j.status) === "Failed");

  console.log(`  Total: ${jobs.length} jobs\n`);
  console.log(`  ⏳ Pending   : ${pending.length}`);
  console.log(`  ⚡ Active    : ${active.length}`);
  console.log(`  ⏰ Timed out : ${timedOut.length}`);
  console.log(`  ✅ Completed : ${completed.length}`);
  console.log(`  ❌ Failed    : ${failed.length}`);
  divider();

  if (pending.length > 0) {
    console.log("⏳ Pending:");
    printJobs(pending);
  }
  if (active.length > 0) {
    console.log("\n⚡ Active:");
    printJobs(active);
  }
  if (timedOut.length > 0) {
    console.log("\n⏰ Timed out:");
    printJobs(timedOut);
  }
  if (completed.length > 0) {
    console.log("\n✅ Completed:");
    printJobs(completed);
  }
  if (failed.length > 0) {
    console.log("\n❌ Failed:");
    printJobs(failed);
  }

  await pressEnter();
};

const closeJobs = async (
  program: anchor.Program<JobQue>,
  ownerKey: anchor.web3.PublicKey
) => {
  console.log("\nClose Finalized Jobs");
  divider();

  const jobs = await fetchAllJobs(program, ownerKey);
  const closeable = jobs.filter(
    j => statusLabel(j.status) === "Completed" || statusLabel(j.status) === "Failed"
  );

  if (closeable.length === 0) {
    console.log("  No completed or failed jobs to close.");
    await pressEnter();
    return;
  }

  console.log(`Found ${closeable.length} closeable job(s):\n`);
  printJobs(closeable);

  const confirm = await prompt("\nClose all of these and reclaim rent? (y/n): ");
  if (confirm.trim().toLowerCase() !== "y") {
    console.log("Cancelled.");
    await pressEnter();
    return;
  }

  let closed = 0;
  for (const job of closeable) {
    try {
      await program.methods.closeJob(job.jobId).rpc();
      console.log(`✅ Closed job #${job.jobId.toString()}`);
      closed++;
    } catch (e: any) {
      console.log(`Failed to close job #${job.jobId.toString()}:`, e.message);
    }
    await sleep(500); // small delay between closes
  }

  console.log(`\n🎉 Closed ${closed}/${closeable.length} jobs. Rent reclaimed.`);
  await pressEnter();
};

const addMultipleJobs = async (
  program: anchor.Program<JobQue>,
) => {
  console.log("\nAdd Multiple Jobs");
  divider();

  const countInput = await prompt("How many jobs to add? ");
  const count = parseInt(countInput.trim());

  if (isNaN(count) || count < 1) {
    console.log("Invalid number.");
    await pressEnter();
    return;
  }

  const timeoutInput = await prompt("Timeout in seconds for each (default 30): ");
  const timeout = parseInt(timeoutInput.trim()) || 30;

  let counter = await program.account.counter.fetch(counterPda(program.programId));
  let nextId = (counter.jobIdCounter as anchor.BN).toNumber();

  console.log(`\nAdding ${count} jobs starting from #${nextId}...\n`);

  let added = 0;
  for (let i = 0; i < count; i++) {
    try {
      await program.methods
        .addJob(new anchor.BN(nextId), new anchor.BN(timeout))
        .rpc();
      console.log(` Job #${nextId} added`);
      nextId++;
      added++;
    } catch (e: any) {
      console.log(` Job #${nextId} failed:`, e.message);
    }
    await sleep(500);
  }

  console.log(`\n🎉 Added ${added}/${count} jobs.`);
  await pressEnter();
};

// ── main menu ─────────────────────────────────────────────────────────────────
const mainMenu = async (
  program: anchor.Program<JobQue>,
  ownerKey: anchor.web3.PublicKey
) => {
  while (true) {
    header(ownerKey);
    console.log("  1. Approve a worker");
    console.log("  2. Add a job");
    console.log("  3. Add multiple jobs");
    console.log("  4. View dashboard");
    console.log("  5. Close finalized jobs (reclaim rent)");
    console.log("  6. Exit");
    divider();

    const choice = await prompt("Select an option: ");

    switch (choice.trim()) {
      case "1": await approveWorker(program, ownerKey); break;
      case "2": await addJob(program); break;
      case "3": await addMultipleJobs(program); break;
      case "4": await viewDashboard(program, ownerKey); break;
      case "5": await closeJobs(program, ownerKey); break;
      case "6":
        console.log("\nGoodbye!\n");
        rl.close();
        process.exit(0);
      default:
        console.log("Invalid option.");
        await sleep(800);
    }
  }
};

// ── entry point ───────────────────────────────────────────────────────────────
async function main() {
  const { keypair, program } = setupProgram(KEYPAIR_PATH);
  const ownerKey = keypair.publicKey;

  header(ownerKey);
  console.log("  Connecting to devnet...\n");

  await runSetup(program, ownerKey);
  await sleep(1000);

  await mainMenu(program, ownerKey);
}

main().catch(e => {
  console.error("Fatal error:", e);
  rl.close();
  process.exit(1);
});