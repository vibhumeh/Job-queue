/**
 * worker.ts
 *
 * Simulates a worker who:
 * 1. Polls for all pending/timed-out jobs belonging to a given owner
 * 2. Proactively checks if any active jobs held by OTHER workers have timed out
 * 3. Claims the first available job (FIFO)
 * 4. Simulates doing work (sleep)
 * 5. Marks it complete (or randomly fails to simulate failures)
 * 6. Loops forever
 *
 * Usage:
 *   ts-node worker.ts <worker-keypair.json> <owner-pubkey>
 *
 * Example:
 *   ts-node worker.ts ./keys/worker.json 4xKp...AbcD
 */

import * as anchor from "@coral-xyz/anchor";
import {
  setupProgram,
  fetchAllJobs,
  statusLabel,
  sleep,
} from "./common";

const KEYPAIR_PATH     = process.argv[2] ?? "./keys/worker.json";
const OWNER_PUBKEY     = process.argv[3];
const POLL_INTERVAL_MS = 3000;  // check for jobs every 3 seconds
const WORK_DURATION_MS = 8000;  // simulate doing work for 8 seconds
const FAIL_RATE        = 0.2;   // 20% chance of randomly failing a job

if (!OWNER_PUBKEY) {
  console.error("Usage: ts-node worker.ts <keypair.json> <owner-pubkey>");
  process.exit(1);
}

// ── Timeout tracking ──────────────────────────────────────────────────────────
// Tracks active jobs claimed by OTHER workers so we can detect when they stall.
// Map of jobId (string) → { claimedAt: unix seconds, timeout: seconds }
const trackedActiveJobs = new Map<string, { claimedAt: number; timeout: number }>();

const isTimedOut = (jobId: string): boolean => {
  const entry = trackedActiveJobs.get(jobId);
  if (!entry) return false;
  const now = Math.floor(Date.now() / 1000);
  return now - entry.claimedAt >= entry.timeout;
};

const trackJob = (
  jobId: anchor.BN,
  claimedAt: anchor.BN,
  timeout: anchor.BN
) => {
  const key = jobId.toString();
  if (!trackedActiveJobs.has(key)) {
    trackedActiveJobs.set(key, {
      claimedAt: claimedAt.toNumber(),
      timeout: timeout.toNumber(),
    });
  }
};

const untrackJob = (jobId: anchor.BN) => {
  trackedActiveJobs.delete(jobId.toString());
};

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { keypair, program } = setupProgram(KEYPAIR_PATH);
  const workerKey = keypair.publicKey;
  const ownerKey  = new anchor.web3.PublicKey(OWNER_PUBKEY);

  console.log("🔧 Worker :", workerKey.toBase58());
  console.log("👤 Owner  :", ownerKey.toBase58());
  console.log("─".repeat(60));

  let jobsProcessed = 0;
  let jobsFailed    = 0;
  let jobsReclaimed = 0;

  while (true) {
    try {
      const jobs = await fetchAllJobs(program, ownerKey);
      const now  = Math.floor(Date.now() / 1000);

      // ── Step 1: update our local timeout tracker ────────────────────────────
      // For every active job held by someone else, start tracking it.
      // For jobs no longer active, stop tracking them.
      for (const job of jobs) {
        const key = job.jobId.toString();
        const s   = statusLabel(job.status);
        const isOtherWorker = job.claimer.toBase58() !== workerKey.toBase58();

        if (s === "Active" && isOtherWorker) {
          trackJob(job.jobId, job.creationTime, job.timeout);
        } else if (s !== "Active") {
          untrackJob(job.jobId);
        }
      }

      // ── Step 2: check if I currently hold an active job ─────────────────────
      const myActiveJob = jobs.find(
        j =>
          statusLabel(j.status) === "Active" &&
          j.claimer.toBase58() === workerKey.toBase58()
      );

      if (myActiveJob) {
        // I have a job — finish it
        const elapsed = now - myActiveJob.creationTime.toNumber();
        const remaining = myActiveJob.timeout.toNumber() - elapsed;

        console.log(
          `⚙️  Working on job #${myActiveJob.jobId.toString()} ` +
          `(${remaining}s until timeout)...`
        );
        await sleep(WORK_DURATION_MS);

        const shouldFail = Math.random() < FAIL_RATE;
        try {
          if (shouldFail) {
            await program.methods.failJob(myActiveJob.jobId).rpc();
            jobsFailed++;
            console.log(
              `❌ Job #${myActiveJob.jobId.toString()} failed (simulated) | ` +
              `processed: ${++jobsProcessed} | failed: ${jobsFailed} | reclaimed: ${jobsReclaimed}`
            );
          } else {
            await program.methods.completeJob(myActiveJob.jobId).rpc();
            console.log(
              `✅ Job #${myActiveJob.jobId.toString()} completed | ` +
              `processed: ${++jobsProcessed} | failed: ${jobsFailed} | reclaimed: ${jobsReclaimed}`
            );
          }
          untrackJob(myActiveJob.jobId);
        } catch (e: any) {
          console.log(`⚠️  Could not update job #${myActiveJob.jobId.toString()}:`, e.message?.slice(0, 60));
        }

      } else {
        // ── Step 3: check if any OTHER worker's job has timed out ─────────────
        const stalled = jobs.find(j => {
          if (statusLabel(j.status) !== "Active") return false;
          if (j.claimer.toBase58() === workerKey.toBase58()) return false;
          return isTimedOut(j.jobId.toString());
        });

        if (stalled) {
          console.log(
            `⏰ Job #${stalled.jobId.toString()} has timed out ` +
            `(held by ${stalled.claimer.toBase58().slice(0, 8)}...) — reclaiming...`
          );
          try {
            await program.methods
              .reclaimTimeoutJob(stalled.jobId, ownerKey)
              .rpc();
            jobsReclaimed++;
            untrackJob(stalled.jobId);
            console.log(`🔄 Reclaimed job #${stalled.jobId.toString()} | reclaimed: ${jobsReclaimed}`);
          } catch (e: any) {
            console.log(`⚠️  Reclaim failed for job #${stalled.jobId.toString()}:`, e.message?.slice(0, 60));
          }

        } else {
          // ── Step 4: claim a pending job ──────────────────────────────────────
          const claimable = jobs
            .filter(j => {
              const s = statusLabel(j.status);
              return s === "Pending" || s === "Timeout";
            })
            .sort((a, b) => a.jobId.toNumber() - b.jobId.toNumber());

          if (claimable.length > 0) {
            const target = claimable[0];
            console.log(
              `👋 Claiming job #${target.jobId.toString()} ` +
              `(status: ${statusLabel(target.status)})...`
            );
            try {
              await program.methods
                .claimJob(target.jobId, ownerKey)
                .rpc();
              console.log(`⚡ Claimed job #${target.jobId.toString()}`);
            } catch (e: any) {
              // Lost the race to another worker — that's fine, demonstrates atomicity
              console.log(
                `⚠️  Lost race for job #${target.jobId.toString()} — ` +
                `another worker got it:`, e.message?.slice(0, 60)
              );
            }

          } else {
            const activeElsewhere = jobs.filter(
              j => statusLabel(j.status) === "Active" &&
                   j.claimer.toBase58() !== workerKey.toBase58()
            );
            if (activeElsewhere.length > 0) {
              const soonest = activeElsewhere
                .map(j => {
                  const entry = trackedActiveJobs.get(j.jobId.toString());
                  if (!entry) return { job: j, remaining: Infinity };
                  const remaining = entry.timeout - (now - entry.claimedAt);
                  return { job: j, remaining };
                })
                .sort((a, b) => a.remaining - b.remaining)[0];

              console.log(
                `💤 No claimable jobs | ` +
                `watching job #${soonest.job.jobId.toString()} — ` +
                `times out in ~${Math.max(0, Math.ceil(soonest.remaining))}s`
              );
            } else {
              console.log(`💤 No jobs available — polling...`);
            }
          }
        }
      }

    } catch (e: any) {
      console.error("❌ Poll error:", e.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});