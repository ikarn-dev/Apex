//! XP math — the authoritative implementation.
//!
//! `src/game/scoring/xp.ts` mirrors this function for function so the number the
//! player sees on the results screen is the number this program writes. Both
//! sides use integer arithmetic in the same order of operations; if you change
//! one, change the other in the same commit.

/// Per-level tuning. Mirrors `src/game/config/levels.ts`.
#[derive(Clone, Copy)]
pub struct LevelParams {
    pub laps: u8,
    /// Target time, ms. The pace term is scored against this.
    pub par_ms: u32,
    /// Fastest physically plausible time. Anything below is rejected outright.
    pub floor_ms: u32,
    pub base_xp: u32,
    /// Drift multiplier in basis points (400 = 0.04x).
    pub drift_bps: u32,
    pub clean_bonus: u32,
    /// Act III gate. 0 means no gate.
    pub drift_target: u32,
    /// Finishing position required to clear the level.
    pub target_position: u8,
    /// XP required to unlock. Enforced at `open_session`.
    pub unlock_xp: u64,
}

/// Indexed by `LEVEL_INDEX` in `src/game/config/levels.ts`. Order is a wire
/// format — append only, never reorder.
pub const LEVELS: [LevelParams; 6] = [
    // All acts use the supplied Suzuka route. Lap counts and timing bounds are
    // calibrated to keep a browser race near the original session length.
    // 0 — ACT I, Cold Start
    LevelParams { laps: 1, par_ms: 249500, floor_ms: 154500, base_xp: 400, drift_bps: 400, clean_bonus: 150, drift_target: 0, target_position: 3, unlock_xp: 0 },
    // 1 — ACT II, Delegation
    LevelParams { laps: 1, par_ms: 243000, floor_ms: 150500, base_xp: 700, drift_bps: 600, clean_bonus: 250, drift_target: 0, target_position: 3, unlock_xp: 0 },
    // 2 — ACT III, Tick Rate
    LevelParams { laps: 1, par_ms: 225000, floor_ms: 139500, base_xp: 850, drift_bps: 1_400, clean_bonus: 300, drift_target: 220, target_position: 3, unlock_xp: 2_500 },
    // 3 — ACT IV, The Commit Window
    LevelParams { laps: 2, par_ms: 477000, floor_ms: 295500, base_xp: 1_100, drift_bps: 900, clean_bonus: 400, drift_target: 0, target_position: 2, unlock_xp: 10_000 },
    // 4 — ACT V, Undelegate
    LevelParams { laps: 1, par_ms: 242500, floor_ms: 150500, base_xp: 1_600, drift_bps: 1_000, clean_bonus: 600, drift_target: 0, target_position: 1, unlock_xp: 30_000 },
    // 5 — Endless Time Attack
    LevelParams { laps: 1, par_ms: 255500, floor_ms: 158500, base_xp: 600, drift_bps: 1_100, clean_bonus: 350, drift_target: 0, target_position: 1, unlock_xp: 0 },
];

/// XP required to unlock each car index. Mirrors `CARS[*].unlockXp`.
pub const CAR_UNLOCK_XP: [u64; 1] = [0];

pub const LEVEL_COUNT: u8 = 6;
pub const CAR_COUNT: u8 = 1;

const PACE_MIN_PCT: u64 = 25;
const PACE_MAX_PCT: u64 = 200;
const PLACING_BONUS: [u32; 6] = [500, 250, 100, 0, 0, 0];
const RISK_PER_DEFERRED_LAP: u64 = 25;
const MAX_RISK_PCT: u64 = 300;

/// Rank thresholds. Mirrors `RANKS` in `src/game/config/progression.ts`.
pub const RANK_THRESHOLDS: [u64; 5] = [0, 2_500, 10_000, 30_000, 75_000];

pub fn rank_for_xp(xp: u64) -> u8 {
    let mut rank = 0u8;
    let mut i = 0usize;
    while i < RANK_THRESHOLDS.len() {
        if xp >= RANK_THRESHOLDS[i] {
            rank = i as u8;
        }
        i += 1;
    }
    rank
}

pub fn level_params(level_id: u8) -> Option<LevelParams> {
    if (level_id as usize) < LEVELS.len() {
        Some(LEVELS[level_id as usize])
    } else {
        None
    }
}

pub fn pace_xp(base_xp: u32, par_ms: u32, total_ms: u32) -> u64 {
    if total_ms == 0 {
        return 0;
    }
    // Multiply before dividing so this is reproducible without floats.
    let ratio_pct = (par_ms as u64 * 100) / total_ms as u64;
    let clamped = ratio_pct.clamp(PACE_MIN_PCT, PACE_MAX_PCT);
    (base_xp as u64 * clamped) / 100
}

pub fn risk_percent(bank_deferred_laps: u8) -> u64 {
    (100 + RISK_PER_DEFERRED_LAP * bank_deferred_laps as u64).min(MAX_RISK_PCT)
}

pub struct XpInput {
    pub total_ms: u32,
    pub drift_score: u32,
    pub collisions: u16,
    pub overtakes: u16,
    pub position: u8,
    pub bank_deferred_laps: u8,
}

pub struct XpBreakdown {
    pub pace: u64,
    pub drift: u64,
    pub clean: u64,
    pub overtakes: u64,
    pub placing: u64,
    pub risk_percent: u64,
    pub total: u64,
}

pub fn compute_xp(level: &LevelParams, input: &XpInput) -> XpBreakdown {
    let pace = pace_xp(level.base_xp, level.par_ms, input.total_ms);
    let drift = (input.drift_score as u64 * level.drift_bps as u64) / 10_000;
    let clean = if input.collisions == 0 {
        level.clean_bonus as u64
    } else {
        0
    };
    let overtakes = input.overtakes as u64 * 25;
    let placing_index = (input.position.clamp(1, 6) - 1) as usize;
    let placing = PLACING_BONUS[placing_index] as u64;

    let subtotal = pace + drift + clean + overtakes + placing;
    let risk = risk_percent(input.bank_deferred_laps);
    let total = (subtotal * risk) / 100;

    XpBreakdown {
        pace,
        drift,
        clean,
        overtakes,
        placing,
        risk_percent: risk,
        total,
    }
}

/// Bounds that make a submitted result *possible*.
///
/// This is not full verification — the client still simulates the race. It
/// closes off the cheap attacks (a one-second lap, a million-point drift score,
/// skipped checkpoints) so forging a result needs a real replay rather than an
/// edited number. Full server-side replay is the next step.
pub fn plausible(
    level: &LevelParams,
    input: &XpInput,
    checkpoints_hit: u16,
    checkpoints_per_lap: u16,
) -> bool {
    if input.total_ms < level.floor_ms {
        return false;
    }
    if input.total_ms as u64 > level.par_ms as u64 * 6 {
        return false;
    }
    if input.position < 1 || input.position > 8 {
        return false;
    }
    // Drift score can only accumulate so fast per millisecond of race time.
    if input.drift_score as u64 > input.total_ms as u64 * 3 / 2 {
        return false;
    }
    let expected = level.laps as u16 * checkpoints_per_lap;
    if checkpoints_per_lap > 0 && checkpoints_hit < expected {
        return false;
    }
    if input.bank_deferred_laps > level.laps {
        return false;
    }
    true
}
