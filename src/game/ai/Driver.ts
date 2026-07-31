/**
 * Rival AI.
 *
 * A racing-line follower with lookahead braking. It drives the same
 * `VehicleSim` as the player through the same `VehicleInput` — no cheating on
 * physics, no invisible speed bonus. That matters for a game where the result is
 * settled on-chain: if the AI could break the rules, the player's finishing
 * position would be meaningless.
 *
 * What it *does* get is a skill parameter, controlling cornering confidence,
 * reaction lag and how much it drifts off the ideal line. Rubber-banding is a
 * separate, capped nudge, disabled entirely for the Act V boss.
 */

import type { Track } from "../track/Track";
import type { CarTuning } from "../config/cars";
import type { VehicleInput, VehicleState } from "../physics/VehicleSim";
import { Rng } from "@/lib/rng";
import { clamp, wrapAngle } from "@/lib/math";

export interface DriverSkill {
  /** 0-1. Fraction of theoretical corner speed attempted. */
  confidence: number;
  /** Seconds of input lag. Higher = clumsier corrections. */
  reaction: number;
  /** Metres of wander off the racing line. */
  sloppiness: number;
  /** 0-1. Willingness to slide the car. */
  aggression: number;
}

/**
 * Skill tiers.
 *
 * Retuned after headless measurement: the first pass had `sloppiness` up to
 * 2.4m and used the handbrake freely, and the result was a field slower than a
 * mediocre scripted policy — no rival ever finished ahead of the player. Wander
 * pushed them off the racing line into the barriers, and every handbrake pull
 * threw away speed the AI then had to rebuild.
 */
export const SKILL_TIERS: Record<"easy" | "mid" | "hard" | "boss", DriverSkill> = {
  easy: { confidence: 0.85, reaction: 0.14, sloppiness: 1.3, aggression: 0.2 },
  mid: { confidence: 0.92, reaction: 0.09, sloppiness: 0.85, aggression: 0.35 },
  hard: { confidence: 0.97, reaction: 0.055, sloppiness: 0.5, aggression: 0.5 },
  // The Act V boss is allowed to be marginally beyond a clean human line. It is
  // the last race in the campaign and it should feel like one.
  boss: { confidence: 1.02, reaction: 0.03, sloppiness: 0.2, aggression: 0.62 },
};

/** How far ahead to place the steering aim point, scaled by speed. */
const LOOKAHEAD_BASE = 14;
const LOOKAHEAD_PER_SPEED = 1.05;

/**
 * Margin on top of the braking distance when scanning for corners, metres.
 *
 * The scan used to be `22 + speed * 2.2`, which is linear, while braking distance
 * is quadratic in speed. At 82m/s the two happened to agree with 10m to spare; at
 * 94m/s the car needed 231m to slow for the hairpin and was looking 229m ahead, so
 * it committed to the corner before it had seen it. Deriving the scan from the
 * braking distance keeps the margin constant at every top speed.
 */
const BRAKING_MARGIN = 30;

/** Gravity used for the cornering-speed estimate. */
const G = 9.81;

export class AiDriver {
  private readonly input: VehicleInput = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
  };

  /** Smoothed steer, so reaction lag is modelled rather than instant. */
  private steerFiltered = 0;
  private wanderPhase: number;
  private wanderSpeed: number;

  constructor(
    private readonly track: Track,
    private readonly tuning: CarTuning,
    private readonly skill: DriverSkill,
    seed: number,
  ) {
    const rng = new Rng(seed);
    this.wanderPhase = rng.range(0, Math.PI * 2);
    this.wanderSpeed = rng.range(0.12, 0.3);
  }

  /**
   * @param rubberBand -1 (behind, gets help) to 1 (ahead, backs off). Pass 0 to
   *                   disable.
   */
  update(
    state: VehicleState,
    trackIndex: number,
    distance: number,
    dt: number,
    elapsed: number,
    rubberBand: number,
  ): VehicleInput {
    const speed = state.speed;

    // --- aim point ---------------------------------------------------------
    const lookahead = LOOKAHEAD_BASE + speed * LOOKAHEAD_PER_SPEED;
    const target = this.track.sampleAtDistance(distance + lookahead);

    // Wander keeps rivals from driving the identical line in a train.
    const wander =
      Math.sin(elapsed * this.wanderSpeed + this.wanderPhase) * this.skill.sloppiness;
    const targetLateral = target.racingLine + wander;

    const targetX = target.x + target.rx * targetLateral;
    const targetZ = target.z + target.rz * targetLateral;

    const desiredHeading = Math.atan2(targetX - state.x, targetZ - state.z);
    const headingError = wrapAngle(desiredHeading - state.yaw);

    // Counter-steer into a slide rather than fighting it.
    const counterSteer = -state.slipAngle * this.skill.aggression * 0.85;
    // The gain was 2.1, tuned when full stick commanded 1.6x the yaw the tyres
    // could track — so the yaw ceiling was reached at 62% of stick travel and a
    // modest steering request produced an outsized response. Now that the stick is
    // proportional, the same 2.1 asks for about half the lock a corner needs at
    // speed, and the field understeers into the barriers: rival contacts tripled.
    const rawSteer = clamp(headingError * 3.6 + counterSteer, -1, 1);

    // Reaction lag: a first-order filter whose time constant is the skill's
    // reaction time.
    const responsiveness = 1 - Math.exp(-dt / Math.max(0.016, this.skill.reaction));
    this.steerFiltered += (rawSteer - this.steerFiltered) * responsiveness;
    this.input.steer = clamp(this.steerFiltered, -1, 1);

    // --- corner speed ------------------------------------------------------
    // Worst curvature over the braking zone decides the target speed.
    let worstCurvature = 0;
    const decel = Math.max(1, this.tuning.brakeForce / this.tuning.mass);
    const scanDistance = BRAKING_MARGIN + (speed * speed) / (2 * decel);
    for (let d = 6; d < scanDistance; d += 6) {
      const s = this.track.sampleAtDistance(distance + d);
      const k = Math.abs(s.curvature);
      if (k > worstCurvature) worstCurvature = k;
    }

    const cornerSpeed = this.cornerSpeedFor(worstCurvature);

    let targetSpeed = Math.min(
      this.tuning.maxSpeed,
      cornerSpeed * this.skill.confidence,
    );

    // Rubber-banding, capped hard so skill still decides the race.
    targetSpeed *= 1 - clamp(rubberBand, -1, 1) * 0.07;

    // --- pedals ------------------------------------------------------------
    const speedError = targetSpeed - speed;
    if (speedError > 1.5) {
      this.input.throttle = clamp(speedError / 8, 0.35, 1);
      this.input.brake = 0;
    } else if (speedError < -2.5) {
      this.input.throttle = 0;
      this.input.brake = clamp(-speedError / 12, 0.25, 1);
    } else {
      // Hold station on throttle rather than coasting: these tracks have real
      // gradients and coasting up one bleeds speed the AI never gets back.
      this.input.throttle = 0.7;
      this.input.brake = 0;
    }

    // Handbrake only for genuine hairpins. Using it more freely reads as
    // aggressive and measures as slow.
    this.input.handbrake =
      this.skill.aggression > 0.45 &&
      worstCurvature > 0.05 &&
      speed > 16 &&
      Math.abs(headingError) > 0.55;

    // Recovery: if badly off the road, forget the racing line and just get back.
    const projection = this.track.project(state.x, state.z, trackIndex);
    if (Math.abs(projection.lateral) > this.track.sampleAt(trackIndex).halfWidth + 3) {
      this.input.throttle = Math.min(this.input.throttle, 0.45);
      this.input.brake = 0;
      this.input.handbrake = false;
    }

    return this.input;
  }

  /**
   * The speed a given curvature can actually be held at.
   *
   * This used to evaluate grip at the car's *current* speed, which is a different
   * speed from the one it is braking down to — and with downforce in the mix the
   * two disagree badly. Arriving at a hairpin at 90m/s, the old form saw 2.98g of
   * downforce-assisted grip and concluded the corner could be taken at 32m/s; the
   * car then arrived with only 1.4g available and went straight into the barrier.
   * Rival contact counts across a race roughly tripled when downforce went up.
   *
   * Solving for the self-consistent speed removes the disagreement. With
   * `grip(v) = gripRear * (1 + downforce * v²)` and `v² = grip(v) / k`:
   *
   *   v² = gripRear / (k - gripRear * downforce)
   *
   * The denominator goes non-positive exactly when downforce alone can hold the
   * corner at any speed, which is the flat-out case and is capped by top speed.
   */
  private cornerSpeedFor(curvature: number): number {
    if (curvature <= 1e-5) return this.tuning.maxSpeed;
    // A small allowance for the banking the layout puts into every corner.
    const assisted = this.tuning.gripRear + G * 0.2;
    const denominator = curvature - this.tuning.gripRear * this.tuning.downforce;
    if (denominator <= 1e-6) return this.tuning.maxSpeed;
    return Math.min(this.tuning.maxSpeed, Math.sqrt(assisted / denominator));
  }
}
