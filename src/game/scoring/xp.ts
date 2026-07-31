/**
 * XP math.
 *
 * This file is the client half of a pair: `programs/apex_racing/src/xp.rs`
 * implements the identical formula in Rust and is the authority. Both use
 * integer arithmetic in the same order of operations so the number the player
 * sees on the results screen is exactly the number the program writes.
 *
 * If you change anything here, change it there in the same commit.
 */

import type { LevelDefinition } from "../config/levels";
import type { XpBreakdown } from "../types";

/** Bounds on the pace term, in percent. Mirrors the on-chain clamp. */
const PACE_MIN_PCT = 25;
const PACE_MAX_PCT = 200;

/** Placing bonuses for positions 1..6. */
const PLACING_BONUS = [500, 250, 100, 0, 0, 0] as const;

/** Per-lap risk added while a run stays uncommitted (Act IV), in percent. */
export const RISK_PER_DEFERRED_LAP = 25;

/** Cap so deferring cannot run away with the economy. */
const MAX_RISK_PCT = 300;

/**
 * XP forfeited per registered contact, with a barrier or another car.
 *
 * Contact already cost the binary `cleanBonus`; this makes each individual hit
 * cost something, which is what stops a driver from writing off the bonus on lap
 * one and then using the barriers as a guide rail for the rest of the race.
 *
 * Deliberately derived from the collision *count* and nothing else. That count is
 * already streamed to the rollup every tick as `collision_delta` and stored on the
 * session, so the program can compute this term from state it already has — no new
 * instruction argument, no new account field, and no change to a wire format that
 * would need a migration.
 */
export const XP_PER_CONTACT = 120;

/** Penalty in XP for a number of contacts, before it is capped at the subtotal. */
export function penaltyXp(collisions: number): number {
  return Math.max(0, Math.floor(collisions)) * XP_PER_CONTACT;
}

export interface XpInput {
  /** Finish time, ms. */
  totalMs: number;
  driftScore: number;
  collisions: number;
  overtakes: number;
  /** 1-based finishing position. */
  position: number;
  /** Laps completed without banking. */
  bankDeferredLaps: number;
}

/**
 * Pace term: how close the run was to par, clamped.
 *
 * Integer-only, and the multiply happens before the divide so the Rust side can
 * reproduce it exactly without floats.
 */
export function paceXp(baseXp: number, parMs: number, totalMs: number): number {
  if (totalMs <= 0) return 0;
  const ratioPct = Math.floor((parMs * 100) / totalMs);
  const clamped = Math.min(Math.max(ratioPct, PACE_MIN_PCT), PACE_MAX_PCT);
  return Math.floor((baseXp * clamped) / 100);
}

export function riskPercent(bankDeferredLaps: number): number {
  const pct = 100 + RISK_PER_DEFERRED_LAP * Math.max(0, bankDeferredLaps);
  return Math.min(pct, MAX_RISK_PCT);
}

export function computeXp(level: LevelDefinition, input: XpInput): XpBreakdown {
  const pace = paceXp(level.baseXp, level.parMs, input.totalMs);

  // driftMultiplier is authored as a float for tuning readability; convert to
  // integer basis points once so the arithmetic below stays integral.
  const driftBps = Math.round(level.driftMultiplier * 10_000);
  const drift = Math.floor((input.driftScore * driftBps) / 10_000);

  const clean = input.collisions === 0 ? level.cleanBonus : 0;
  const overtakes = Math.max(0, input.overtakes) * 25;
  const placing = PLACING_BONUS[Math.min(Math.max(input.position, 1), 6) - 1] ?? 0;

  const subtotal = pace + drift + clean + overtakes + placing;
  // Capped at the subtotal: the program's arithmetic is unsigned, so a run that
  // earned less than it forfeited has to floor at zero rather than wrap.
  const penalty = Math.min(subtotal, penaltyXp(input.collisions));
  const risk = riskPercent(input.bankDeferredLaps);
  const total = Math.floor(((subtotal - penalty) * risk) / 100);

  return { pace, drift, clean, overtakes, placing, penalty, riskPercent: risk, total };
}

/**
 * Live XP estimate mid-race.
 *
 * Extrapolates the finish time from progress so the HUD number moves smoothly
 * instead of jumping at the line. Deliberately not the authoritative path.
 */
export function projectXp(
  level: LevelDefinition,
  elapsedMs: number,
  lapsCompleted: number,
  lapProgress: number,
  driftScore: number,
  collisions: number,
  overtakes: number,
  position: number,
  bankDeferredLaps: number,
): number {
  const progress = (lapsCompleted + lapProgress) / level.laps;
  if (progress <= 0.01) return 0;
  const projectedTotalMs = Math.max(level.floorMs, Math.floor(elapsedMs / progress));
  return computeXp(level, {
    totalMs: projectedTotalMs,
    driftScore,
    collisions,
    overtakes,
    position,
    bankDeferredLaps,
  }).total;
}

/**
 * Client-side sanity check matching the program's validation.
 *
 * Anything the program would reject should be caught here first so the player
 * gets an explanation instead of a failed transaction.
 */
export function validateResult(
  level: LevelDefinition,
  input: XpInput & { checkpointsHit: number; totalCheckpoints: number },
): { ok: true } | { ok: false; reason: string } {
  if (input.totalMs < level.floorMs) {
    return { ok: false, reason: "Finish time below the physical floor for this track." };
  }
  if (input.totalMs > level.parMs * 6) {
    return { ok: false, reason: "Run exceeded the maximum session duration." };
  }
  const expected = level.laps * input.totalCheckpoints;
  if (input.checkpointsHit < expected) {
    return {
      ok: false,
      reason: `Missed checkpoints: ${input.checkpointsHit}/${expected}.`,
    };
  }
  // A drift score can only grow so fast: cap is score-per-ms times duration.
  const maxDrift = Math.floor(input.totalMs * 1.5);
  if (input.driftScore > maxDrift) {
    return { ok: false, reason: "Drift score exceeds the per-tick ceiling." };
  }
  if (input.position < 1 || input.position > 8) {
    return { ok: false, reason: "Invalid finishing position." };
  }
  return { ok: true };
}
