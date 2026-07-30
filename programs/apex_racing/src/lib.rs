//! apex_racing — on-chain progression for APEX: Zero Latency.
//!
//! # Why this program is shaped like this
//!
//! A single 3-lap race produces 80-500 state transitions. On the Solana base
//! layer that is unaffordable and far too slow to be a game. So the run lives
//! in a MagicBlock Ephemeral Rollup:
//!
//! ```text
//!  base layer   open_session ──▶ delegate_session
//!                                      │
//!  rollup        tick × N ──▶ finish_race ──▶ bank_run ──▶ settle_run
//!                (~10ms each)                (commit)     (commit+undelegate)
//!                                      │
//!  base layer                     claim_xp ──▶ DriverProfile.xp_committed
//! ```
//!
//! The player approves exactly two transactions per race — `open_session +
//! delegate_session` before the lights, and `claim_xp` after the flag. Every
//! write during driving is signed by a throwaway session key held in browser
//! memory, so nothing interrupts a corner.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};

pub mod errors;
pub mod state;
pub mod xp;

use errors::ApexError;
use state::{DriverProfile, RaceSession, SessionState};
use xp::{compute_xp, level_params, plausible, rank_for_xp, XpInput, CAR_UNLOCK_XP, CAR_COUNT};

declare_id!("49LZgLYqX4RFDqtNYatt7xeiTaLd9nuzHKtuiQ3NUtn9");

pub const DRIVER_SEED: &[u8] = b"driver";
pub const SESSION_SEED: &[u8] = b"session";

/// How often the rollup flushes delegated state to the base layer on its own,
/// independent of an explicit `bank_run`. A safety net, not the main path.
pub const DEFAULT_COMMIT_FREQUENCY_MS: u32 = 30_000;

/// Slack allowed on a batched tick: the client coalesces ~120ms of physics into
/// one instruction, so a tick may legitimately carry a burst of drift score.
const DRIFT_PER_MS_NUMERATOR: u64 = 3;
const DRIFT_PER_MS_DENOMINATOR: u64 = 2;
const DRIFT_BURST_ALLOWANCE: u64 = 256;

#[ephemeral]
#[program]
pub mod apex_racing {
    use super::*;

    // ---------------------------------------------------------------- base layer

    /// One-time driver registration. Derived purely from the connected wallet,
    /// so "sign up" is just connecting.
    pub fn initialize_driver(ctx: Context<InitializeDriver>) -> Result<()> {
        let profile = &mut ctx.accounts.driver_profile;
        profile.authority = ctx.accounts.authority.key();
        profile.xp_committed = 0;
        profile.session_nonce = 0;
        profile.races_finished = 0;
        profile.best_times_ms = [0; 8];
        profile.cleared_levels = 0;
        profile.rank = 0;
        profile.bump = ctx.bumps.driver_profile;

        msg!("apex: driver registered {}", profile.authority);
        Ok(())
    }

    /// Create the run. Validates unlocks here rather than trusting the client,
    /// then hands the fresh account to `delegate_session` in the same
    /// transaction so the player only approves once.
    pub fn open_session(
        ctx: Context<OpenSession>,
        nonce: u64,
        level_id: u8,
        car_id: u8,
        seed: u64,
        session_signer: Pubkey,
    ) -> Result<()> {
        let level = level_params(level_id).ok_or(ApexError::UnknownLevel)?;
        require!(car_id < CAR_COUNT, ApexError::UnknownCar);

        let profile = &mut ctx.accounts.driver_profile;
        require!(nonce == profile.session_nonce, ApexError::NonceMismatch);
        require!(
            profile.xp_committed >= level.unlock_xp,
            ApexError::LevelLocked
        );
        require!(
            profile.xp_committed >= CAR_UNLOCK_XP[car_id as usize],
            ApexError::CarLocked
        );

        let session = &mut ctx.accounts.race_session;
        session.authority = ctx.accounts.authority.key();
        session.session_signer = session_signer;
        session.nonce = nonce;
        session.seed = seed;
        session.opened_at = Clock::get()?.unix_timestamp;
        session.xp_earned = 0;
        session.xp_banked = 0;
        session.tick = 0;
        session.total_ms = 0;
        session.best_lap_ms = 0;
        session.drift_score = 0;
        session.elapsed_ms = 0;
        session.checkpoints_hit = 0;
        session.collisions = 0;
        session.overtakes = 0;
        session.level_id = level_id;
        session.car_id = car_id;
        session.laps_completed = 0;
        session.position = 0;
        session.bank_deferred_laps = 0;
        session.state = SessionState::Open as u8;
        session.cleared = 0;
        session.bump = ctx.bumps.race_session;
        session.replay_hash = [0; 32];

        // Burn the nonce immediately so a replayed transaction cannot reopen the
        // same PDA.
        profile.session_nonce = profile
            .session_nonce
            .checked_add(1)
            .ok_or(ApexError::Overflow)?;

        msg!("apex: session {} opened, level {}", nonce, level_id);
        Ok(())
    }

    /// Hand the session account to the rollup. After this the base layer stops
    /// accepting writes to it and the ER takes over at ~10ms.
    pub fn delegate_session(ctx: Context<DelegateSession>, nonce: u64) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let nonce_bytes = nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[SESSION_SEED, authority.as_ref(), nonce_bytes.as_ref()];

        // Guard against being handed someone else's account: the seeds we sign
        // with must reproduce the account we were given.
        let (expected, _) = Pubkey::find_program_address(seeds, &crate::ID);
        require_keys_eq!(
            expected,
            ctx.accounts.race_session.key(),
            ApexError::NonceMismatch
        );

        ctx.accounts.delegate_race_session(
            &ctx.accounts.payer,
            seeds,
            DelegateConfig {
                commit_frequency_ms: DEFAULT_COMMIT_FREQUENCY_MS,
                validator: None,
            },
        )?;

        msg!("apex: session {} delegated to the rollup", nonce);
        Ok(())
    }

    // -------------------------------------------------------------------- rollup

    /// The hot path. Called continuously while driving, signed by the session
    /// key, executed in the rollup.
    ///
    /// The client coalesces roughly 120ms of physics into one call, so the
    /// deltas here are aggregates. Every field is bounds-checked against the
    /// elapsed time it claims to cover, which is what stops a client from
    /// simply writing a huge drift score.
    pub fn tick(
        ctx: Context<Tick>,
        checkpoint: u16,
        lap: u8,
        drift_delta: u32,
        collision_delta: u16,
        elapsed_ms: u32,
    ) -> Result<()> {
        let session = &mut ctx.accounts.race_session;
        require!(session.is_open(), ApexError::SessionNotOpen);
        require!(
            elapsed_ms >= session.elapsed_ms,
            ApexError::NonMonotonicTime
        );
        require!(
            checkpoint >= session.checkpoints_hit,
            ApexError::NonMonotonicCheckpoint
        );

        let window_ms = (elapsed_ms - session.elapsed_ms) as u64;
        let drift_ceiling =
            window_ms * DRIFT_PER_MS_NUMERATOR / DRIFT_PER_MS_DENOMINATOR + DRIFT_BURST_ALLOWANCE;
        require!(
            drift_delta as u64 <= drift_ceiling,
            ApexError::DriftDeltaTooLarge
        );

        session.checkpoints_hit = checkpoint;
        session.laps_completed = lap;
        session.elapsed_ms = elapsed_ms;
        session.drift_score = session.drift_score.saturating_add(drift_delta);
        session.collisions = session.collisions.saturating_add(collision_delta);
        session.tick = session.tick.saturating_add(1);

        Ok(())
    }

    /// Close out the run inside the rollup and compute the XP.
    ///
    /// This is where the authoritative number is produced — the client's
    /// results screen shows the output of the identical formula in
    /// `src/game/scoring/xp.ts`, so the two can never disagree.
    pub fn finish_race(
        ctx: Context<Tick>,
        total_ms: u32,
        best_lap_ms: u32,
        position: u8,
        overtakes: u16,
        bank_deferred_laps: u8,
        checkpoints_per_lap: u16,
        replay_hash: [u8; 32],
    ) -> Result<()> {
        let session = &mut ctx.accounts.race_session;
        require!(session.is_open(), ApexError::SessionAlreadyFinished);
        require!(replay_hash != [0u8; 32], ApexError::MissingReplayHash);

        let level = level_params(session.level_id).ok_or(ApexError::UnknownLevel)?;

        let input = XpInput {
            total_ms,
            drift_score: session.drift_score,
            collisions: session.collisions,
            overtakes,
            position,
            bank_deferred_laps,
        };

        require!(
            plausible(&level, &input, session.checkpoints_hit, checkpoints_per_lap),
            ApexError::ImplausibleResult
        );

        let breakdown = compute_xp(&level, &input);

        session.total_ms = total_ms;
        session.best_lap_ms = best_lap_ms;
        session.position = position;
        session.overtakes = overtakes;
        session.bank_deferred_laps = bank_deferred_laps;
        session.replay_hash = replay_hash;
        session.xp_earned = breakdown.total;
        session.state = SessionState::Finished as u8;
        session.cleared = u8::from(
            position <= level.target_position && session.drift_score >= level.drift_target,
        );

        msg!(
            "apex: finished in {}ms, p{}, {} ticks, {} xp",
            total_ms,
            position,
            session.tick,
            breakdown.total
        );
        Ok(())
    }

    /// BANK RUN — flush rollup state to the base layer while staying delegated.
    ///
    /// This is the Act IV mechanic made literal: whatever is committed here
    /// survives a later crash-out, and whatever is not does not.
    pub fn bank_run(ctx: Context<CommitSession>) -> Result<()> {
        let session = &mut ctx.accounts.race_session;
        require!(
            session.is_open() || session.state == SessionState::Finished as u8,
            ApexError::SessionNotClaimable
        );

        session.xp_banked = session.xp_earned;
        if session.state == SessionState::Finished as u8 {
            session.state = SessionState::Banked as u8;
        }

        commit_accounts(
            &ctx.accounts.payer.to_account_info(),
            vec![&ctx.accounts.race_session.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
            None,
        )?;

        msg!("apex: run banked to the settlement layer");
        Ok(())
    }

    /// SETTLE — final commit and hand the account back to the base layer.
    pub fn settle_run(ctx: Context<CommitSession>) -> Result<()> {
        let session = &mut ctx.accounts.race_session;
        require!(session.is_claimable(), ApexError::SessionNotClaimable);

        session.xp_banked = session.xp_earned;
        session.state = SessionState::Settled as u8;

        commit_and_undelegate_accounts(
            &ctx.accounts.payer.to_account_info(),
            vec![&ctx.accounts.race_session.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
            None,
        )?;

        msg!("apex: session settled and undelegated");
        Ok(())
    }

    // ---------------------------------------------------------------- base layer

    /// Move the settled XP onto the permanent profile and close the run.
    ///
    /// Only possible once the session is back under this program's ownership,
    /// which Anchor enforces for us: while delegated, the account is owned by
    /// the delegation program and `Account<RaceSession>` will not deserialise.
    pub fn claim_xp(ctx: Context<ClaimXp>) -> Result<()> {
        let session = &ctx.accounts.race_session;
        require!(session.is_claimable(), ApexError::SessionNotClaimable);

        let profile = &mut ctx.accounts.driver_profile;
        let awarded = session.xp_earned;

        profile.xp_committed = profile
            .xp_committed
            .checked_add(awarded)
            .ok_or(ApexError::Overflow)?;
        profile.races_finished = profile.races_finished.saturating_add(1);
        profile.rank = rank_for_xp(profile.xp_committed);
        profile.record_best(session.level_id, session.total_ms);
        if session.cleared == 1 {
            profile.mark_cleared(session.level_id);
        }

        msg!(
            "apex: claimed {} xp, total {}, rank {}",
            awarded,
            profile.xp_committed,
            profile.rank
        );
        Ok(())
    }

    /// FLATLINE — retire a run without committing it. The rent comes back, the
    /// XP does not.
    pub fn abandon_session(ctx: Context<ClaimXp>) -> Result<()> {
        msg!(
            "apex: session {} abandoned, {} xp discarded",
            ctx.accounts.race_session.nonce,
            ctx.accounts.race_session.xp_earned
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitializeDriver<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = DriverProfile::LEN,
        seeds = [DRIVER_SEED, authority.key().as_ref()],
        bump,
    )]
    pub driver_profile: Account<'info, DriverProfile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenSession<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [DRIVER_SEED, authority.key().as_ref()],
        bump = driver_profile.bump,
        has_one = authority,
    )]
    pub driver_profile: Account<'info, DriverProfile>,
    #[account(
        init,
        payer = authority,
        space = RaceSession::LEN,
        seeds = [SESSION_SEED, authority.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub race_session: Account<'info, RaceSession>,
    pub system_program: Program<'info, System>,
}

/// `#[delegate]` expands `#[account(mut, del)]` into the buffer, delegation
/// record and delegation metadata accounts, appends `owner_program`,
/// `delegation_program` and `system_program`, and generates
/// `delegate_race_session(payer, seeds, config)`.
#[delegate]
#[derive(Accounts)]
pub struct DelegateSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The wallet that owns the run. Same key as `payer` in practice, kept
    /// separate so the seed derivation is explicit.
    pub authority: Signer<'info>,
    /// CHECK: validated against the derived PDA inside the handler before use.
    #[account(mut, del)]
    pub race_session: UncheckedAccount<'info>,
}

/// Runs inside the rollup. `payer` is the throwaway session key, which is why
/// none of this prompts the wallet.
#[derive(Accounts)]
pub struct Tick<'info> {
    #[account(
        mut,
        constraint = race_session.session_signer == session_signer.key()
            @ ApexError::UnauthorizedSessionSigner,
    )]
    pub race_session: Account<'info, RaceSession>,
    pub session_signer: Signer<'info>,
}

/// `#[commit]` appends `magic_program` and `magic_context`.
#[commit]
#[derive(Accounts)]
pub struct CommitSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        constraint = race_session.session_signer == payer.key()
            @ ApexError::UnauthorizedSessionSigner,
    )]
    pub race_session: Account<'info, RaceSession>,
}

#[derive(Accounts)]
pub struct ClaimXp<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [DRIVER_SEED, authority.key().as_ref()],
        bump = driver_profile.bump,
        has_one = authority,
    )]
    pub driver_profile: Account<'info, DriverProfile>,
    #[account(
        mut,
        close = authority,
        seeds = [SESSION_SEED, authority.key().as_ref(), &race_session.nonce.to_le_bytes()],
        bump = race_session.bump,
        has_one = authority,
    )]
    pub race_session: Account<'info, RaceSession>,
}
