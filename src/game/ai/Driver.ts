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

/** How far ahead to look for corners, scaled by speed. */
const LOOKAHEAD_BASE = 14;
const LOOKAHEAD_PER_SPEED = 1.05;

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
    const rawSteer = clamp(headingError * 2.1 + counterSteer, -1, 1);

    // Reaction lag: a first-order filter whose time constant is the skill's
    // reaction time.
    const responsiveness = 1 - Math.exp(-dt / Math.max(0.016, this.skill.reaction));
    this.steerFiltered += (rawSteer - this.steerFiltered) * responsiveness;
    this.input.steer = clamp(this.steerFiltered, -1, 1);

    // --- corner speed ------------------------------------------------------
    // Worst curvature over the braking zone decides the target speed.
    let worstCurvature = 0;
    const scanDistance = 22 + speed * 2.2;
    for (let d = 6; d < scanDistance; d += 6) {
      const s = this.track.sampleAtDistance(distance + d);
      const k = Math.abs(s.curvature);
      if (k > worstCurvature) worstCurvature = k;
    }

    const grip = this.tuning.gripRear * (1 + this.tuning.downforce * speed * speed);
    const cornerSpeed =
      worstCurvature > 1e-5
        ? Math.sqrt((grip + G * 0.2) / worstCurvature)
        : this.tuning.maxSpeed;

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
}
