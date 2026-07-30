//! Account layouts.
//!
//! Field order is a wire format: `src/chain/program/state.ts` decodes these
//! byte-for-byte with a hand-rolled Borsh reader instead of shipping an IDL.
//! Append new fields at the end, never reorder.

use anchor_lang::prelude::*;

/// Permanent, one per wallet. Never delegated — this is the settled record.
#[account]
pub struct DriverProfile {
    pub authority: Pubkey,
    /// XP settled on the base layer.
    pub xp_committed: u64,
    /// Monotonic counter that derives the next `RaceSession` PDA.
    pub session_nonce: u64,
    pub races_finished: u32,
    /// Best time per level index, ms. 0 means unset.
    pub best_times_ms: [u32; 8],
    /// Bitmask of cleared level indices.
    pub cleared_levels: u16,
    pub rank: u8,
    pub bump: u8,
}

impl DriverProfile {
    pub const LEN: usize = 8   // discriminator
        + 32                    // authority
        + 8                     // xp_committed
        + 8                     // session_nonce
        + 4                     // races_finished
        + 4 * 8                 // best_times_ms
        + 2                     // cleared_levels
        + 1                     // rank
        + 1; // bump

    pub fn mark_cleared(&mut self, level_id: u8) {
        if level_id < 16 {
            self.cleared_levels |= 1u16 << level_id;
        }
    }

    pub fn record_best(&mut self, level_id: u8, total_ms: u32) {
        let idx = level_id as usize;
        if idx < self.best_times_ms.len() {
            let current = self.best_times_ms[idx];
            if current == 0 || total_ms < current {
                self.best_times_ms[idx] = total_ms;
            }
        }
    }
}

/// Session lifecycle. Values are a wire format shared with the client.
#[repr(u8)]
pub enum SessionState {
    /// Created, may be delegated and ticked.
    Open = 0,
    /// `finish_race` ran in the rollup; `xp_earned` is final.
    Finished = 1,
    /// Committed to the base layer at least once, still delegated.
    Banked = 2,
    /// Committed and undelegated. Ready to claim.
    Settled = 3,
    /// Retired without committing. FLATLINE — no XP.
    Abandoned = 4,
}

/// One run. Created on the base layer, delegated to the ER for the duration of
/// the race, then committed back and closed by `claim_xp`.
#[account]
pub struct RaceSession {
    /// The wallet that owns this run.
    pub authority: Pubkey,
    /// The only key allowed to advance this session inside the rollup.
    ///
    /// A throwaway keypair held in browser memory. It exists so the ~10ms tick
    /// stream needs no wallet approval, and it can do exactly one thing:
    /// progress this one race. It cannot move lamports, touch the profile, or
    /// claim XP.
    pub session_signer: Pubkey,
    pub nonce: u64,
    /// Deterministic simulation seed.
    pub seed: u64,
    pub opened_at: i64,
    /// XP computed by `finish_race`, awaiting a claim.
    pub xp_earned: u64,
    /// XP already flushed to the base layer by `bank_run`.
    pub xp_banked: u64,
    /// Rollup state transitions applied to this session.
    pub tick: u32,
    pub total_ms: u32,
    pub best_lap_ms: u32,
    pub drift_score: u32,
    /// Latest elapsed time reported by a tick, ms. Monotonicity is enforced.
    pub elapsed_ms: u32,
    pub checkpoints_hit: u16,
    pub collisions: u16,
    pub overtakes: u16,
    pub level_id: u8,
    pub car_id: u8,
    pub laps_completed: u8,
    pub position: u8,
    pub bank_deferred_laps: u8,
    pub state: u8,
    /// 1 when the run met the level's position and drift objectives.
    pub cleared: u8,
    pub bump: u8,
    /// Digest binding this result to a specific replay.
    pub replay_hash: [u8; 32],
}

impl RaceSession {
    pub const LEN: usize = 8   // discriminator
        + 32                    // authority
        + 32                    // session_signer
        + 8                     // nonce
        + 8                     // seed
        + 8                     // opened_at
        + 8                     // xp_earned
        + 8                     // xp_banked
        + 4                     // tick
        + 4                     // total_ms
        + 4                     // best_lap_ms
        + 4                     // drift_score
        + 4                     // elapsed_ms
        + 2                     // checkpoints_hit
        + 2                     // collisions
        + 2                     // overtakes
        + 1                     // level_id
        + 1                     // car_id
        + 1                     // laps_completed
        + 1                     // position
        + 1                     // bank_deferred_laps
        + 1                     // state
        + 1                     // cleared
        + 1                     // bump
        + 32; // replay_hash

    pub fn is_open(&self) -> bool {
        self.state == SessionState::Open as u8
    }

    pub fn is_claimable(&self) -> bool {
        self.state == SessionState::Finished as u8
            || self.state == SessionState::Banked as u8
            || self.state == SessionState::Settled as u8
    }
}
