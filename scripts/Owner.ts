/**
 * owner.ts
 * 
 * Simulates an owner who:
 * 1. Initializes the counter (once)
 * 2. Registers themselves as an owner
 * 3. Approves a worker (pass worker pubkey as CLI arg)
 * 4. Keeps posting new jobs every N seconds
 * 5. Periodically prints a dashboard of all their jobs
 * 
 * Usage:
 *   ts-node owner.ts <owner-keypair.json> <worker-pubkey>
 * 
 * Example:
 *   ts-node owner.ts ./keys/owner.json 9zwF...NhCh
 */

import * as anchor from "@coral-xyz/anchor";
import {
  setupProgram,
  fetchAllJobs,
  printJobs,
  statusLabel,
  sleep,
  counterPda,
} from "./common";

const KEYPAIR_PATH = process.argv[2] ?? "./keys/owner.json";
const WORKER_PUBKEY = process.argv[3];
const JOB_INTERVAL_MS  = 8000;   // post a new job every 8 seconds
const DASHBOARD_INTERVAL_MS = 5000; // print dashboard every 5 seconds

if (!WORKER_PUBKEY) {
  console.error("Usage: ts-node owner.ts <keypair.json> <worker-pubkey>");
  process.exit(1);
}

async function main() {
  const { keypair, program } = setupProgram(KEYPAIR_PATH);
  const ownerKey = keypair.publicKey;
  const workerKey = new anchor.web3.PublicKey(WORKER_PUBKEY);

  console.log("👤 Owner:", ownerKey.toBase58());
  console.log("🔧 Approving worker:", workerKey.toBase58());
  console.log("─".repeat(60));

  // ── One-time setup ───────────────────────────────────────────────────────

  // Initialize counter (will fail gracefully if already done)
  try {
    await program.methods.initialize().rpc();
    console.log("✅ Counter initialized");
  } catch (_) {
    console.log("ℹ️  Counter already initialized, skipping");
  }

  // Register owner (will fail gracefully if already done)
  try {
    await program.methods.initializeOwner().rpc();
    console.log("✅ Owner registered");
  } catch (_) {
    console.log("ℹ️  Owner already registered, skipping");
  }

  // Approve worker (will fail gracefully if already approved)
const WORKER_PUBKEYS = process.argv.slice(3);

if (WORKER_PUBKEYS.length === 0) {
  console.error("Usage: ts-node owner.ts <keypair.json> <worker-pubkey1> [worker-pubkey2] ...");
  process.exit(1);
}
for (const workerPubkeyStr of WORKER_PUBKEYS) {
  const workerKey = new anchor.web3.PublicKey(workerPubkeyStr);
  try {
    await program.methods.approveWorker(workerKey).rpc();
    console.log("✅ Worker approved:", workerKey.toBase58().slice(0, 8) + "...");
  } catch (_) {
    console.log("ℹ️  Worker already approved, skipping");
  }
}

  // ── Get current counter to know what job ID to start from ────────────────
  let nextJobId: number;
  try {
    const counter = await program.account.counter.fetch(
      counterPda(program.programId)
    );
    nextJobId = counter.jobIdCounter.toNumber();
  } catch (_) {
    nextJobId = 1;
  }

  console.log(`\n🚀 Starting job queue from ID ${nextJobId}...\n`);

  // ── Dashboard printer ─────────────────────────────────────────────────────
  const printDashboard = async () => {
    const jobs = await fetchAllJobs(program, ownerKey);
    const pending   = jobs.filter(j => statusLabel(j.status) === "Pending");
    const active    = jobs.filter(j => statusLabel(j.status) === "Active");
    const timedOut  = jobs.filter(j => statusLabel(j.status) === "Timeout");
    const completed = jobs.filter(j => statusLabel(j.status) === "Completed");
    const failed    = jobs.filter(j => statusLabel(j.status) === "Failed");

    console.log("\n📊 DASHBOARD ─────────────────────────────────────────");
    console.log(`  Total: ${jobs.length} | ⏳ Pending: ${pending.length} | ⚡ Active: ${active.length} | ⏰ Timed out: ${timedOut.length} | ✅ Completed: ${completed.length} | ❌ Failed: ${failed.length}`);

    if (pending.length > 0) {
      console.log("\n  ⏳ Pending:");
      printJobs(pending);
    }
    if (active.length > 0) {
      console.log("\n  ⚡ Active:");
      printJobs(active);
    }
    if (timedOut.length > 0) {
      console.log("\n  ⏰ Timed out:");
      printJobs(timedOut);
    }
    console.log("─".repeat(60));
  };

  // ── Job posting loop ──────────────────────────────────────────────────────
  let jobCounter = nextJobId;
  let dashboardTimer = 0;

  while (true) {
    // Post a new job
    const jobId = new anchor.BN(jobCounter);
    const timeout = new anchor.BN(30); // 30 second timeout for simulation

    try {
      await program.methods
        .addJob(jobId, timeout)
        .rpc();
      console.log(`📝 Posted job #${jobCounter} (timeout: ${timeout}s)`);
      jobCounter++;
    } catch (e: any) {
      console.error(`❌ Failed to post job #${jobCounter}:`, e.message);
    }

    dashboardTimer += JOB_INTERVAL_MS;
    if (dashboardTimer >= DASHBOARD_INTERVAL_MS) {
      await printDashboard();
      dashboardTimer = 0;
    }

    await sleep(JOB_INTERVAL_MS);
  }
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});