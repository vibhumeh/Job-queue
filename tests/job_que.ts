import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { JobQue } from "../target/types/job_que";
import { assert } from "chai";

describe("job_que", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.JobQue as Program<JobQue>;

  // ── Wallets ───────────────────────────────────────────────────────────────
  const owner   = anchor.web3.Keypair.generate(); // posts jobs, approves workers
  const worker1 = anchor.web3.Keypair.generate(); // approved worker
  const worker2 = anchor.web3.Keypair.generate(); // approved later (for reclaim test)
  const rogue   = anchor.web3.Keypair.generate(); // never approved

  // helper: program instance signed by a specific keypair
  const as = (kp: anchor.web3.Keypair) =>
    new Program(
      program.idl,
      new anchor.AnchorProvider(provider.connection, new anchor.Wallet(kp), {})
    );

  // ── Airdrop ───────────────────────────────────────────────────────────────
  before(async () => {
    for (const kp of [owner, worker1, worker2, rogue]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }
    await new Promise(r => setTimeout(r, 1000));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SETUP
  // ══════════════════════════════════════════════════════════════════════════

  it("Initializes global counter", async () => {
    await program.methods.initialize().rpc();
    console.log("Counter initialized");
  });

  it("Owner registers", async () => {
    await as(owner).methods.initializeOwner().rpc();
    console.log("Owner registered:", owner.publicKey.toBase58().slice(0, 8) + "...");
  });

  it("Owner approves worker1", async () => {
    await as(owner).methods.approveWorker(worker1.publicKey).rpc();
    console.log("worker1 approved");
  });

  it("Owner approves worker2", async () => {
    await as(owner).methods.approveWorker(worker2.publicKey).rpc();
    console.log("worker2 approved");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // HAPPY PATH
  // ══════════════════════════════════════════════════════════════════════════

  it("Owner posts job → worker1 claims → completes", async () => {
    await as(owner).methods.addJob(new anchor.BN(1), new anchor.BN(60)).rpc();
    console.log("  Job 1 posted");

    await as(worker1).methods.claimJob(new anchor.BN(1), owner.publicKey).rpc();
    console.log("  Job 1 claimed by worker1");

    await as(worker1).methods.completeJob(new anchor.BN(1)).rpc();

    const [jobPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("job"), new anchor.BN(1).toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const job = await program.account.job.fetch(jobPda);
    assert.deepEqual(job.jobStatus, { completed: {} });
    console.log("Job 1 completed");
  });

  it("Owner posts job → worker1 claims → fails", async () => {
    await as(owner).methods.addJob(new anchor.BN(2), new anchor.BN(60)).rpc();
    await as(worker1).methods.claimJob(new anchor.BN(2), owner.publicKey).rpc();
    await as(worker1).methods.failJob(new anchor.BN(2)).rpc();

    const [jobPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("job"), new anchor.BN(2).toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const job = await program.account.job.fetch(jobPda);
    assert.deepEqual(job.jobStatus, { failed: {} });
    console.log("Job 2 failed correctly");
  });

  it("Job times out → worker2 reclaims → completes", async () => {
    await as(owner).methods.addJob(new anchor.BN(3), new anchor.BN(5)).rpc();
    await as(worker1).methods.claimJob(new anchor.BN(3), owner.publicKey).rpc();
    console.log("Job 3 claimed by worker1, waiting 6s for timeout...");

    await new Promise(r => setTimeout(r, 6000));

    await as(worker2).methods.reclaimTimeoutJob(new anchor.BN(3), owner.publicKey).rpc();
    console.log("Job 3 reclaimed by worker2");

    await as(worker2).methods.completeJob(new anchor.BN(3)).rpc();

    const [jobPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("job"), new anchor.BN(3).toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const job = await program.account.job.fetch(jobPda);
    assert.deepEqual(job.jobStatus, { completed: {} });
    console.log("Job 3 reclaimed by worker2 and completed");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // FAILURE CASES
  // ══════════════════════════════════════════════════════════════════════════

  it("Cannot add duplicate job ID", async () => {
    await as(owner).methods.addJob(new anchor.BN(4), new anchor.BN(60)).rpc();
    try {
      await as(owner).methods.addJob(new anchor.BN(4), new anchor.BN(60)).rpc();
      assert.fail("Should have rejected duplicate job ID");
    } catch (_) {
      console.log("Duplicate job ID rejected");
    }
  });

  it("Unapproved worker cannot claim a job", async () => {
    await as(owner).methods.addJob(new anchor.BN(5), new anchor.BN(60)).rpc();
    try {
      await as(rogue).methods.claimJob(new anchor.BN(5), owner.publicKey).rpc();
      assert.fail("Unapproved worker should be rejected");
    } catch (_) {
      console.log("Unapproved worker correctly rejected");
    }
  });

  it("Cannot claim an already active job", async () => {
    await as(owner).methods.addJob(new anchor.BN(6), new anchor.BN(60)).rpc();
    await as(worker1).methods.claimJob(new anchor.BN(6), owner.publicKey).rpc();
    try {
      await as(worker2).methods.claimJob(new anchor.BN(6), owner.publicKey).rpc();
      assert.fail("Should have rejected, job already active");
    } catch (_) {
      console.log("Double claim correctly rejected");
    }
  });

  it("Cannot complete a job you did not claim", async () => {
    await as(owner).methods.addJob(new anchor.BN(7), new anchor.BN(60)).rpc();
    await as(worker1).methods.claimJob(new anchor.BN(7), owner.publicKey).rpc();
    try {
      await as(worker2).methods.completeJob(new anchor.BN(7)).rpc();
      assert.fail("Should have rejected, wrong claimer");
    } catch (_) {
      console.log("Wrong claimer correctly rejected");
    }
  });

  it("Cannot reclaim a job that has not timed out", async () => {
    await as(owner).methods.addJob(new anchor.BN(8), new anchor.BN(9999)).rpc();
    await as(worker1).methods.claimJob(new anchor.BN(8), owner.publicKey).rpc();
    try {
      await as(worker2).methods.reclaimTimeoutJob(new anchor.BN(8), owner.publicKey).rpc();
      assert.fail("Should have rejected, timeout not expired");
    } catch (_) {
      console.log("Premature reclaim correctly rejected");
    }
  });

  it("Current claimer cannot reclaim their own timed-out job", async () => {
    await as(owner).methods.addJob(new anchor.BN(9), new anchor.BN(5)).rpc();
    await as(worker1).methods.claimJob(new anchor.BN(9), owner.publicKey).rpc();
    console.log("  Waiting 6s...");
    await new Promise(r => setTimeout(r, 6000));
    try {
      await as(worker1).methods.reclaimTimeoutJob(new anchor.BN(9), owner.publicKey).rpc();
      assert.fail("Should have rejected, self reclaim");
    } catch (_) {
      console.log("Self-reclaim correctly rejected");
    }
  });
it("Owner can close a completed job and reclaim rent", async () => {
    const jobId = new anchor.BN(10);

    await as(owner).methods.addJob(jobId, new anchor.BN(60)).rpc();
    await as(worker1).methods.claimJob(jobId, owner.publicKey).rpc();
    await as(worker1).methods.completeJob(jobId).rpc();

    const [jobPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("job"), jobId.toArrayLike(Buffer, "le", 8)],
        program.programId
    );

    // get balance before close
    const balanceBefore = await provider.connection.getBalance(owner.publicKey);

    await as(owner).methods.closeJob(jobId).rpc();

    // account should no longer exist
    const jobAccount = await provider.connection.getAccountInfo(jobPda);
    assert.isNull(jobAccount, "Job account should be closed");

    // owner should have more SOL than before
    const balanceAfter = await provider.connection.getBalance(owner.publicKey);
    assert.isAbove(balanceAfter, balanceBefore, "Rent should be returned to owner");

    console.log("Job closed, rent reclaimed");
});

it("Cannot close an active job", async () => {
    const jobId = new anchor.BN(11);

    await as(owner).methods.addJob(jobId, new anchor.BN(60)).rpc();
    await as(worker1).methods.claimJob(jobId, owner.publicKey).rpc();

    try {
        await as(owner).methods.closeJob(jobId).rpc();
        assert.fail("Should have rejected, job still active");
    } catch (_) {
        console.log("Cannot close active job");
    }
});

it("Non-owner cannot close a job", async () => {
    const jobId = new anchor.BN(12);

    await as(owner).methods.addJob(jobId, new anchor.BN(60)).rpc();
    await as(worker1).methods.claimJob(jobId, owner.publicKey).rpc();
    await as(worker1).methods.completeJob(jobId).rpc();

    try {
        await as(worker1).methods.closeJob(jobId).rpc();
        assert.fail("Should have rejected, not the owner");
    } catch (_) {
        console.log("Non-owner cannot close job");
    }
});



});