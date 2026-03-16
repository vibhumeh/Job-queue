import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";

// ── Load IDL and program ───────────────────────────────────────────────────
// Adjust this path to point to your generated IDL
import { JobQue } from "../target/types/job_que"; // adjust path as needed
const IDL_PATH = path.resolve(__dirname, "../target/idl/job_que.json");
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
const PROGRAM_ID = new anchor.web3.PublicKey("AuQKj9mgG8ZJ54UZS5ahh3jivZig5vzKGffQ8qv4N2Yy");

// ── Job status enum mapping (matches your Rust enum order) ────────────────
export const JobStatus = {
  Pending:   { pending: {} },
  Active:    { active: {} },
  Completed: { completed: {} },
  Failed:    { failed: {} },
  Timeout:   { timeout: {} },
} as const;

export const statusLabel = (status: any): string => {
  if (status.pending)   return "Pending";
  if (status.active)    return "Active";
  if (status.completed) return "Completed";
  if (status.failed)    return "Failed";
  if (status.timeout)   return "Timeout";
  return "Unknown";
};


// ── PDA helpers ────────────────────────────────────────────────────────────
export const jobPda = (jobId: anchor.BN, programId: anchor.web3.PublicKey) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("job"), jobId.toArrayLike(Buffer, "le", 8)],
    programId
  )[0];

export const counterPda = (programId: anchor.web3.PublicKey) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("counter")],
    programId
  )[0];

export const approvedWorkerPda = (
  ownerKey: anchor.web3.PublicKey,
  workerKey: anchor.web3.PublicKey,
  programId: anchor.web3.PublicKey
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("approved_worker"), ownerKey.toBuffer(), workerKey.toBuffer()],
    programId
  )[0];

// ── Setup provider and program from a keypair file ────────────────────────
export const setupProgram = (keypairPath: string) => {
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const keypair = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(raw));

  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",//"http://127.0.0.1:8899",  // local validator
    "confirmed"
  );
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  //const program = new Program(idl, provider) as Program<any>;
  const program = new Program<JobQue>(idl, provider);
  return { keypair, provider, program, connection };
};

// ── Fetch all jobs for a given owner ──────────────────────────────────────
export const fetchAllJobs = async (
  program: Program<JobQue>,
  ownerKey: anchor.web3.PublicKey
) => {
  const allJobs = await program.account.job.all();
  return allJobs
    .filter(j => j.account.jobOwner.toBase58() === ownerKey.toBase58())
    .map(j => ({
      pubkey: j.publicKey,
      jobId: j.account.jobId as anchor.BN,
      status: j.account.jobStatus,
      claimer: j.account.jobClaimer as anchor.web3.PublicKey,
      timeout: j.account.jobTimeout as anchor.BN,
      creationTime: j.account.jobCreationTime as anchor.BN,
    }));
};

// ── Pretty print job list ─────────────────────────────────────────────────
export const printJobs = (jobs: Awaited<ReturnType<typeof fetchAllJobs>>) => {
  if (jobs.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const j of jobs) {
    console.log(
      `  Job #${j.jobId.toString().padEnd(4)} | ${statusLabel(j.status).padEnd(10)} | claimer: ${
        j.claimer.toBase58() === anchor.web3.PublicKey.default.toBase58()
          ? "none"
          : j.claimer.toBase58().slice(0, 8) + "..."
      }`
    );
  }
};

// ── Sleep helper ──────────────────────────────────────────────────────────
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));