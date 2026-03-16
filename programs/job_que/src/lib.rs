use anchor_lang::prelude::*;

declare_id!("AuQKj9mgG8ZJ54UZS5ahh3jivZig5vzKGffQ8qv4N2Yy");

// ── State Enums ───────────────────────────────────────────────────────────────

/// Represents the lifecycle state of a job in the queue.
/// Transitions: Pending → Active → Completed | Failed
///              Active  → Timeout (if worker stalls past deadline)
///              Timeout → Active  (reclaimed by a different worker)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum JobStatus {
    Pending,
    Active,
    Completed,
    Failed,
    Timeout,
}

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod job_que {
    use super::*;

    /// Initializes the global job ID counter. Must be called once before any jobs
    /// can be added. The counter starts at 1 and increments monotonically.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.counter.job_id_counter = 1;
        Ok(())
    }

    /// Registers a new owner. The owner PDA is derived from their public key,
    /// ensuring each wallet can only register once.
    pub fn initialize_owner(ctx: Context<InitializeOwner>) -> Result<()> {
        ctx.accounts.owner.owner = ctx.accounts.signer.key();
        Ok(())
    }

    /// Approves a worker to claim jobs posted by this owner.
    /// Creates an ApprovedWorker PDA — its existence is the approval.
    /// Revocation is handled by closing this account (not yet implemented).
    pub fn approve_worker(ctx: Context<ApproveWorker>, worker: Pubkey) -> Result<()> {
        let approved_worker = &mut ctx.accounts.approved_worker;
        approved_worker.worker = worker;
        approved_worker.owner = ctx.accounts.signer.key();
        Ok(())
    }

    /// Adds a new job to the queue. Job ID must match the current counter value,
    /// enforcing strictly sequential, globally unique job IDs (analogous to
    /// an auto-increment primary key in a traditional database).
    pub fn add_job(ctx: Context<AddJob>, job_id: u64, timeout: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        require!(job_id == counter.job_id_counter, JobQueueError::InvalidJobId);
        counter.job_id_counter = counter.job_id_counter.checked_add(1)
            .ok_or(JobQueueError::CounterOverflow)?;

        let job = &mut ctx.accounts.job;
        job.job_id = job_id;
        job.job_timeout = timeout;
        job.job_status = JobStatus::Pending;
        job.job_owner = ctx.accounts.signer.key();
        job.job_claimer = Pubkey::default();
        job.job_creation_time = 0; // set on claim, not on creation

        Ok(())
    }

    /// Claims a pending (or timed-out) job for processing.
    /// The worker must be pre-approved by the job's owner.
    /// If the job is currently Active but has exceeded its timeout,
    /// it is automatically transitioned to Timeout before being reclaimed.
    pub fn claim_job(ctx: Context<ClaimJob>, _job_id: u64, owner: Pubkey) -> Result<()> {
        let job = &mut ctx.accounts.job;

        require!(job.job_owner == owner, JobQueueError::OwnerMismatch);

        // Lazily evaluate timeout: if job is active and deadline has passed,
        // transition it to Timeout so it becomes reclaimable.
        if job.job_status == JobStatus::Active {
            let elapsed = Clock::get()?.unix_timestamp as u64 - job.job_creation_time;
            if elapsed >= job.job_timeout {
                require!(
                    job.job_claimer != ctx.accounts.signer.key(),
                    JobQueueError::SelfReclaimNotAllowed
                );
                job.job_status = JobStatus::Timeout;
            }
        }

        require!(
            job.job_status == JobStatus::Pending || job.job_status == JobStatus::Timeout,
            JobQueueError::JobNotClaimable
        );

        job.job_creation_time = Clock::get()?.unix_timestamp as u64;
        job.job_status = JobStatus::Active;
        job.job_claimer = ctx.accounts.signer.key();

        Ok(())
    }

    /// Marks an active job as completed. Only callable by the worker who claimed it.
    pub fn complete_job(ctx: Context<UpdateJobStatus>, _job_id: u64) -> Result<()> {
        let job = &mut ctx.accounts.job;

        require!(job.job_status == JobStatus::Active, JobQueueError::JobNotActive);
        require!(
            job.job_claimer == ctx.accounts.signer.key(),
            JobQueueError::UnauthorizedClaimer
        );

        job.job_status = JobStatus::Completed;
        Ok(())
    }

    /// Marks an active job as failed. Only callable by the worker who claimed it.
    /// Failed jobs remain on-chain for inspection. Re-queuing is an owner decision.
    pub fn fail_job(ctx: Context<UpdateJobStatus>, _job_id: u64) -> Result<()> {
        let job = &mut ctx.accounts.job;

        require!(job.job_status == JobStatus::Active, JobQueueError::JobNotActive);
        require!(
            job.job_claimer == ctx.accounts.signer.key(),
            JobQueueError::UnauthorizedClaimer
        );

        job.job_status = JobStatus::Failed;
        Ok(())
    }

    /// Reclaims a job that has exceeded its timeout from a stalled worker.
    /// The original claimer cannot reclaim their own job, a different approved
    /// worker must step in. This prevents a worker from gaming the timeout system.
    pub fn reclaim_timeout_job(
        ctx: Context<ClaimJob>,
        _job_id: u64,
        owner: Pubkey,
    ) -> Result<()> {
        let job = &mut ctx.accounts.job;

        require!(job.job_owner == owner, JobQueueError::OwnerMismatch);
        require!(job.job_status == JobStatus::Active, JobQueueError::JobNotActive);

        let elapsed = Clock::get()?.unix_timestamp as u64 - job.job_creation_time;
        require!(elapsed >= job.job_timeout, JobQueueError::TimeoutNotExpired);
        require!(
            job.job_claimer != ctx.accounts.signer.key(),
            JobQueueError::SelfReclaimNotAllowed
        );

        job.job_creation_time = Clock::get()?.unix_timestamp as u64;
        job.job_status = JobStatus::Active;
        job.job_claimer = ctx.accounts.signer.key();

        Ok(())
    }

    /// Closes a completed or failed job account, returning rent to the owner.
    /// Only the job owner can close their own jobs.
    /// Prevents closing active jobs — work in progress must finish first.
    pub fn close_job(ctx: Context<CloseJob>, _job_id: u64) -> Result<()> {
        require!(
            ctx.accounts.job.job_status == JobStatus::Completed
                || ctx.accounts.job.job_status == JobStatus::Failed,
            JobQueueError::JobNotCloseable
        );
        require!(
            ctx.accounts.job.job_owner == ctx.accounts.signer.key(),
            JobQueueError::UnauthorizedClaimer
        );
        Ok(())
    }





}




// ── Account Contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        init,
        payer = signer,
        space = 8 + Counter::INIT_SPACE,
        seeds = [b"counter"],
        bump
    )]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeOwner<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        init,
        payer = signer,
        space = 8 + Owner::INIT_SPACE,
        seeds = [b"owner", signer.key().as_ref()],
        bump
    )]
    pub owner: Account<'info, Owner>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(worker: Pubkey)]
pub struct ApproveWorker<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        init,
        payer = signer,
        space = 8 + ApprovedWorker::INIT_SPACE,
        seeds = [b"approved_worker", signer.key().as_ref(), worker.key().as_ref()],
        bump
    )]
    pub approved_worker: Account<'info, ApprovedWorker>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(job_id: u64)]
pub struct AddJob<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        init,
        payer = signer,
        space = 8 + Job::INIT_SPACE,
        seeds = [b"job", job_id.to_le_bytes().as_ref()],
        bump
    )]
    pub job: Account<'info, Job>,
    #[account(
        mut,
        seeds = [b"counter"],
        bump
    )]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(job_id: u64, owner: Pubkey)]
pub struct ClaimJob<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"job", job_id.to_le_bytes().as_ref()],
        bump
    )]
    pub job: Account<'info, Job>,
    /// Verified by PDA existence — if this account resolves, the worker is approved.
    #[account(
        seeds = [b"approved_worker", owner.key().as_ref(), signer.key().as_ref()],
        bump
    )]
    pub approved_worker: Account<'info, ApprovedWorker>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(job_id: u64)]
pub struct UpdateJobStatus<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"job", job_id.to_le_bytes().as_ref()],
        bump
    )]
    pub job: Account<'info, Job>,
    /// Authorization is enforced in the instruction body by checking
    /// job.job_claimer == signer. No separate worker PDA needed here
    /// since a valid claimer could only have been set by an approved worker.
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(job_id: u64)]
pub struct CloseJob<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        mut,
        close = signer,  // closes account, returns rent lamports to signer
        seeds = [b"job", job_id.to_le_bytes().as_ref()],
        bump,
        constraint = job.job_owner == signer.key() @ JobQueueError::UnauthorizedClaimer
    )]
    pub job: Account<'info, Job>,
    pub system_program: Program<'info, System>,
}

// ── Account Structs ───────────────────────────────────────────────────────────

/// Global counter ensuring monotonically increasing, unique job IDs.
/// Analogous to an auto-increment primary key in a traditional database.
#[account]
#[derive(InitSpace)]
pub struct Counter {
    pub job_id_counter: u64,
}

/// Represents a registered job queue owner.
/// Derived from the owner's public key — one per wallet.
#[account]
#[derive(InitSpace)]
pub struct Owner {
    pub owner: Pubkey,
}

/// Represents an approved worker under a specific owner.
/// The existence of this PDA is the authorization — no boolean flag needed.
/// Revoke approval by closing this account.
#[account]
#[derive(InitSpace)]
pub struct ApprovedWorker {
    pub worker: Pubkey,
    pub owner: Pubkey,
}

/// A single job in the queue.
#[account]
#[derive(InitSpace)]
pub struct Job {
    pub job_id: u64,
    pub job_timeout: u64,
    pub job_creation_time: u64,
    pub job_status: JobStatus,
    pub job_owner: Pubkey,
    pub job_claimer: Pubkey,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum JobQueueError {
    #[msg("Job ID must match the current counter value")]
    InvalidJobId,

    #[msg("Job is not in Pending or Timeout status and cannot be claimed")]
    JobNotClaimable,

    #[msg("Job is not Active")]
    JobNotActive,

    #[msg("Only the job claimer can update this job")]
    UnauthorizedClaimer,

    #[msg("Job owner does not match the provided owner pubkey")]
    OwnerMismatch,

    #[msg("Job timeout has not elapsed yet")]
    TimeoutNotExpired,

    #[msg("The current claimer cannot reclaim their own timed-out job")]
    SelfReclaimNotAllowed,

    #[msg("Job ID counter overflow")]
    CounterOverflow,

    #[msg("Only Completed or Failed jobs can be closed")]
    JobNotCloseable,
}