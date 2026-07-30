/**
 * Drift scoring.
 *
 * Rewards angle held at speed, and punishes tapping anything. The multiplier
 * ladder is what makes Act III work: a long linked slide is worth far more than
 * the same seconds of angle taken in separate bites, so the player is pushed
 * into exactly the behaviour that generates a flood of rollup writes.
 *
 * Deterministic and allocation-free, like everything else the fixed step calls.
 */

import { clamp } from "@/lib/math";

/** Minimum slip angle that counts, radians (~9°). */
const MIN_SLIP = 0.16;
/** Below this speed a slide is just a spin in a car park. */
const MIN_SPEED = 8;
/** Grace period before a chain breaks, seconds. */
const CHAIN_GRACE = 0.45;
/** Points per second at 1 rad of slip and 1 m/s. */
const RATE = 0.6;

const MULTIPLIER_STEPS = [
  { seconds: 0, value: 1 },
  { seconds: 1.5, value: 2 },
  { seconds: 3, value: 3 },
  { seconds: 5, value: 4 },
  { seconds: 7.5, value: 5 },
] as const;

export interface DriftResult {
  /** Score added to the run this step. */
  gained: number;
  /** True on the step a chain ends. */
  chainEnded: boolean;
  /** Score of the chain that just ended. */
  endedScore: number;
  endedDurationMs: number;
  endedMultiplier: number;
}

const EMPTY: DriftResult = {
  gained: 0,
  chainEnded: false,
  endedScore: 0,
  endedDurationMs: 0,
  endedMultiplier: 1,
};

export class DriftScorer {
  /** Total for the run. */
  total = 0;
  /** Score accumulated in the chain currently running. */
  chain = 0;
  /** Multiplier applied to the active chain. */
  multiplier = 1;
  /** Seconds the current chain has been alive. */
  chainSeconds = 0;
  active = false;

  private graceLeft = 0;
  /** Reused so `update` never allocates. */
  private readonly result: DriftResult = { ...EMPTY };

  reset(): void {
    this.total = 0;
    this.chain = 0;
    this.multiplier = 1;
    this.chainSeconds = 0;
    this.active = false;
    this.graceLeft = 0;
  }

  /**
   * @param slipAngle Signed slip angle, radians.
   * @param speed     m/s.
   * @param onGround  Airborne cars do not score.
   * @param dt        Fixed step, seconds.
   */
  update(slipAngle: number, speed: number, onGround: boolean, dt: number): DriftResult {
    const r = this.result;
    r.gained = 0;
    r.chainEnded = false;
    r.endedScore = 0;
    r.endedDurationMs = 0;
    r.endedMultiplier = 1;

    const angle = Math.abs(slipAngle);
    const qualifies = onGround && angle > MIN_SLIP && speed > MIN_SPEED;

    if (qualifies) {
      this.active = true;
      this.graceLeft = CHAIN_GRACE;
      this.chainSeconds += dt;

      // Cap the angle term: sideways past ~60° is a spin, not a drift, and
      // should not pay more than a controlled slide.
      const effectiveAngle = Math.min(angle, 1.05);
      const gained = RATE * effectiveAngle * speed * this.multiplier * dt;
      this.chain += gained;
      this.total += gained;
      r.gained = gained;

      let next = 1;
      for (const step of MULTIPLIER_STEPS) {
        if (this.chainSeconds >= step.seconds) next = step.value;
      }
      this.multiplier = next;
      return r;
    }

    if (this.active) {
      // Brief straightening between linked corners must not break the chain.
      this.graceLeft -= dt;
      if (this.graceLeft <= 0) {
        r.chainEnded = true;
        r.endedScore = this.chain;
        r.endedDurationMs = this.chainSeconds * 1000;
        r.endedMultiplier = this.multiplier;
        this.active = false;
        this.chain = 0;
        this.chainSeconds = 0;
        this.multiplier = 1;
      }
    }

    return r;
  }

  /** Contact ends a chain immediately — no credit for bouncing off a wall. */
  breakChain(): DriftResult {
    const r = this.result;
    r.gained = 0;
    r.chainEnded = this.active;
    r.endedScore = this.chain;
    r.endedDurationMs = this.chainSeconds * 1000;
    r.endedMultiplier = this.multiplier;

    this.active = false;
    this.chain = 0;
    this.chainSeconds = 0;
    this.multiplier = 1;
    this.graceLeft = 0;
    return r;
  }

  /** Integer score for the chain and the on-chain tick payload. */
  get integerTotal(): number {
    return Math.floor(this.total);
  }

  /** Progress toward the next multiplier step, 0-1. Drives the HUD meter. */
  get multiplierProgress(): number {
    const currentIndex = MULTIPLIER_STEPS.findIndex((s) => s.value === this.multiplier);
    const next = MULTIPLIER_STEPS[currentIndex + 1];
    if (!next) return 1;
    const current = MULTIPLIER_STEPS[currentIndex]!;
    const span = next.seconds - current.seconds;
    if (span <= 0) return 1;
    return clamp((this.chainSeconds - current.seconds) / span, 0, 1);
  }
}
