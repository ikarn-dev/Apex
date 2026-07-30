/**
 * Race director — the simulation half of a race, with no rendering in it.
 *
 * Owns the track, every car's physics, lap and checkpoint bookkeeping,
 * positions, scoring, and the stream of rollup ticks. It is driven by
 * `update(dt)` at a fixed 60Hz and is deliberately renderer-agnostic so the
 * whole thing can be run headless — which is how a replay would be verified.
 *
 * ## Progress tracking
 *
 * Lap and checkpoint state are derived from one monotonic number, `travelled`,
 * the arc length each car has covered along the centreline:
 *
 *   lapsCompleted  = floor((travelled - startOffset) / trackLength)
 *   checkpointsHit = floor((travelled - startOffset) / gateSpacing) + 1
 *
 * Deriving rather than event-counting removes a whole category of bug — gates
 * cannot be missed, double-counted or taken out of order, and the state is
 * identical however the frame timing fell. Corner-cutting is prevented
 * separately, by the road edges being solid.
 */

import { CARS, DEFAULT_CAR, type CarId, type CarTuning } from "../config/cars";
import type { LevelDefinition } from "../config/levels";
import { CHECKPOINTS_PER_LAP, Track } from "../track/Track";
import { VehicleSim, type VehicleInput } from "../physics/VehicleSim";
import { AiDriver, SKILL_TIERS, type DriverSkill } from "../ai/Driver";
import { DriftScorer } from "../scoring/drift";
import { computeXp, projectXp } from "../scoring/xp";
import type {
  GameBridge,
  RaceResult,
  RacePhase,
  Telemetry,
} from "../types";
import { createTelemetry } from "../types";
import { Rng, ReplayHasher } from "@/lib/rng";
import { clamp } from "@/lib/math";

export const FIXED_STEP = 1 / 60;

/** Seconds of start lights. */
const COUNTDOWN_SECONDS = 3.2;

/** Restitution when hitting the road edge. */
const WALL_RESTITUTION = 0.28;

/** Impact speed below which contact is not counted as a collision. */
const COLLISION_THRESHOLD = 3.5;

/**
 * Speed under which a car counts as stationary, m/s.
 *
 * Deliberately near-standstill. An earlier 3.5 m/s threshold also caught cars
 * genuinely driving slowly through the hairpin, which teleported the player
 * mid-corner for no visible reason.
 */
const STUCK_SPEED = 1.1;
/** How long a car may sit stationary before it is put back on the road, ms. */
const STUCK_RECOVERY_MS = 3200;
/** Speed a recovered car rejoins at, m/s. */
const RECOVERY_SPEED = 9;

/**
 * Physics steps between heartbeat ticks when nothing eventful is happening.
 *
 * 10 steps is ~6Hz. The tick queue coalesces everything into at most one
 * transaction per 120ms anyway, so a shorter interval costs no extra rollup
 * traffic — it just keeps the session's clock current enough that a mid-race
 * commit reflects where the car actually is.
 */
const IDLE_TICK_INTERVAL = 10;

export interface Racer {
  id: number;
  isPlayer: boolean;
  carId: CarId;
  sim: VehicleSim;
  ai: AiDriver | null;
  /** Latest track projection index, used as the O(1) search hint. */
  trackIndex: number;
  /** Monotonic arc length covered, metres. */
  travelled: number;
  /** Projected arc length last step, for wrap detection. */
  lastProjectedDistance: number;
  /** Distance from the grid slot to the start line. */
  startOffset: number;
  lapsCompleted: number;
  checkpointsHit: number;
  lapStartMs: number;
  lapTimesMs: number[];
  bestLapMs: number;
  finished: boolean;
  finishMs: number;
  position: number;
  collisions: number;
  /** Milliseconds spent effectively stationary. Drives the recovery timer. */
  stuckMs: number;
}

export interface RaceDirectorOptions {
  level: LevelDefinition;
  carId: CarId;
  seed: bigint;
  maxRivals: number;
  bridge: GameBridge;
  /** Practice runs skip the rollup entirely. */
  practice: boolean;
}

export class RaceDirector {
  readonly track: Track;
  readonly telemetry: Telemetry;
  readonly racers: Racer[] = [];

  private readonly level: LevelDefinition;
  private readonly bridge: GameBridge;
  private readonly rng: Rng;
  private readonly hasher = new ReplayHasher();
  private readonly drift = new DriftScorer();
  private readonly seed: bigint;
  private readonly practice: boolean;

  private phase: RacePhase = "ready";
  private countdown = COUNTDOWN_SECONDS;
  private raceTimeMs = 0;
  private overtakes = 0;
  /** Monotonic id stamped on every tick payload. Advances every step. */
  private tickSequence = 0;
  /**
   * Payloads actually handed to the chain layer.
   *
   * Distinct from `tickSequence` on purpose: idle steps are throttled, so the
   * two differ by a lot, and this is the one the player is shown. Conflating
   * them made the results screen report physics steps under the label "rollup
   * writes", which is precisely the kind of inflated number this game should not
   * print.
   */
  private ticksEmitted = 0;

  /** Accumulators drained into each rollup tick. */
  private pendingDrift = 0;
  private pendingCollisions = 0;

  /** Act IV: laps completed since the last bank. */
  private bankDeferredLaps = 0;
  private bankedAtLap = 0;

  /** Player input for the current step, set by the engine before `update`. */
  private playerInput: VehicleInput = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
  };

  private readonly splits: number[] = [];
  private storyFired = new Set<string>();
  private result: RaceResult | null = null;

  constructor(options: RaceDirectorOptions) {
    this.level = options.level;
    this.bridge = options.bridge;
    this.seed = options.seed;
    this.practice = options.practice;
    this.rng = new Rng(options.seed);
    this.track = new Track();

    this.telemetry = createTelemetry(options.level.laps, CHECKPOINTS_PER_LAP);
    this.spawnField(options.carId, Math.min(options.maxRivals, options.level.rivals));
    this.telemetry.totalRacers = this.racers.length;

    // Bind the replay digest to the run's identity so a hash cannot be lifted
    // from one run onto another.
    this.hasher.push(Number(options.seed & 0xffffffffn));
    this.hasher.push(this.level.laps);
    this.hasher.push(this.racers.length);
  }

  // ------------------------------------------------------------------- setup

  private spawnField(playerCar: CarId, rivals: number): void {
    const total = rivals + 1;

    // The player starts at the back — a field to overtake is more interesting
    // than a field to defend against, and it makes the overtake bonus reachable.
    const playerSlot = total - 1;

    for (let i = 0; i < total; i += 1) {
      const isPlayer = i === playerSlot;
      const carId = isPlayer ? playerCar : this.pickRivalCar();
      const car = CARS[carId];
      // Surface grip is a property of the track, so it is folded into the car's
      // tuning here rather than checked inside the physics step.
      const tuning = this.surfaceTuning(car.tuning);
      const sim = new VehicleSim(tuning);

      const slot = this.track.gridSlot(i);
      const sample = this.track.sampleAtDistance(slot.distance);
      sim.reset(
        sample.x + sample.rx * slot.lateral,
        sample.y,
        sample.z + sample.rz * slot.lateral,
        sample.heading,
      );

      const projection = this.track.project(sim.state.x, sim.state.z, -1);

      this.racers.push({
        id: i,
        isPlayer,
        carId,
        sim,
        ai: isPlayer
          ? null
          : new AiDriver(
              this.track,
              tuning,
              this.skillFor(i, total),
              Number((this.seed + BigInt(i * 7919)) & 0xffffffffn),
            ),
        trackIndex: projection.index,
        travelled: 0,
        lastProjectedDistance: projection.distance,
        startOffset: this.track.length - slot.distance,
        lapsCompleted: 0,
        checkpointsHit: 0,
        lapStartMs: 0,
        lapTimesMs: [],
        bestLapMs: 0,
        finished: false,
        finishMs: 0,
        position: i + 1,
        collisions: 0,
        stuckMs: 0,
      });
    }
  }

  /**
   * Apply the track's surface grip to a car's tuning.
   *
   * The AI is given the same adjusted tuning it drives on, so its
   * corner-speed estimate stays honest on a slick surface instead of
   * confidently understeering into every barrier.
   */
  private surfaceTuning(tuning: CarTuning): CarTuning {
    const scale = this.level.gripScale;
    if (scale === 1) return tuning;
    return {
      ...tuning,
      gripFront: tuning.gripFront * scale,
      gripRear: tuning.gripRear * scale,
    };
  }

  private pickRivalCar(): CarId {
    // Rivals are drawn from the full roster regardless of the player's unlocks;
    // the field should look like a field.
    const ids = Object.keys(CARS) as CarId[];
    return this.rng.pick(ids) ?? DEFAULT_CAR;
  }

  private skillFor(index: number, total: number): DriverSkill {
    if (this.level.bossRace && index === 0) return SKILL_TIERS.boss;
    // Front of the grid is quicker than the back.
    const t = index / Math.max(1, total - 1);
    if (t < 0.34) return SKILL_TIERS.hard;
    if (t < 0.7) return SKILL_TIERS.mid;
    return SKILL_TIERS.easy;
  }

  // ------------------------------------------------------------------ control

  setPhase(phase: RacePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.telemetry.phase = phase;
    this.bridge.onEvent({ type: "phase", phase });
  }

  beginCountdown(): void {
    this.countdown = COUNTDOWN_SECONDS;
    this.setPhase("countdown");
    this.fireStory("pre");
  }

  setPlayerInput(input: VehicleInput): void {
    this.playerInput = input;
  }

  /** Act IV: the player banked; the risk multiplier resets. */
  markBanked(): void {
    this.bankedAtLap = this.player.lapsCompleted;
    this.bankDeferredLaps = 0;
    this.telemetry.bankDeferredLaps = 0;
  }

  retire(): void {
    if (this.phase === "finished" || this.phase === "failed") return;
    this.setPhase("failed");
    this.bridge.onEvent({ type: "failed", reason: "retired" });
  }

  get player(): Racer {
    // The player is always the last spawned racer; see `spawnField`.
    return this.racers[this.racers.length - 1]!;
  }

  get currentPhase(): RacePhase {
    return this.phase;
  }

  get raceResult(): RaceResult | null {
    return this.result;
  }

  // ------------------------------------------------------------------- update

  /** One fixed step. `dt` is always `FIXED_STEP`. */
  update(dt: number): void {
    if (this.phase === "countdown") {
      this.countdown -= dt;
      const shown = Math.max(0, Math.ceil(this.countdown));
      if (shown !== this.telemetry.countdown) {
        this.telemetry.countdown = shown;
        this.bridge.onEvent({ type: "countdown", value: shown });
      }
      if (this.countdown <= 0) {
        this.setPhase("racing");
        this.fireStory("start");
      }
      // Cars are held on the line, but physics still runs so they settle.
      this.stepRacers(dt, true);
      return;
    }

    if (this.phase !== "racing") return;

    this.raceTimeMs += dt * 1000;
    this.stepRacers(dt, false);
    this.resolveCarContacts();
    this.updateProgress(dt);
    this.updatePositions();
    this.updatePlayerScoring(dt);
    this.emitTick();
    this.checkFinish();
  }

  private stepRacers(dt: number, held: boolean): void {
    for (const racer of this.racers) {
      const projection = this.track.project(
        racer.sim.state.x,
        racer.sim.state.z,
        racer.trackIndex,
      );
      racer.trackIndex = projection.index;

      let input: VehicleInput;
      if (held) {
        input = { throttle: 0, brake: 1, steer: 0, handbrake: true };
      } else if (racer.isPlayer) {
        input = this.playerInput;
      } else if (racer.ai) {
        input = racer.ai.update(
          racer.sim.state,
          racer.trackIndex,
          projection.distance,
          dt,
          this.raceTimeMs / 1000,
          this.rubberBandFor(racer),
        );
      } else {
        input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
      }

      if (racer.finished) {
        // Finished cars coast to a stop instead of vanishing.
        input = { throttle: 0, brake: 0.35, steer: 0, handbrake: false };
      }

      const sample = this.track.sampleAt(racer.trackIndex);
      // `projection.height` is refined along the tangent, so the surface under
      // the car is continuous between samples rather than stepping every 2.5m.
      racer.sim.step(input, dt, projection.height, sample.slope);
      this.resolveTrackEdge(racer, sample.halfWidth);
      if (!held) this.resolveStuck(racer, dt);
    }
  }

  /**
   * Recovery timer.
   *
   * Any car that has come to rest and stayed there gets placed back on the
   * racing line facing forward. A racing game must never present an unwinnable
   * state, and the alternative — leaving the player nose-first into a barrier
   * with no reverse gear worth using — is exactly that. Recovery costs time,
   * which is punishment enough.
   */
  private resolveStuck(racer: Racer, dt: number): void {
    if (racer.finished) return;

    if (racer.sim.state.speed > STUCK_SPEED) {
      racer.stuckMs = 0;
      return;
    }

    racer.stuckMs += dt * 1000;
    if (racer.stuckMs < STUCK_RECOVERY_MS) return;
    racer.stuckMs = 0;

    const projection = this.track.project(
      racer.sim.state.x,
      racer.sim.state.z,
      racer.trackIndex,
    );
    // Nudge slightly forward so the car does not immediately re-trigger on the
    // same spot, and put it on the racing line rather than the centreline.
    const sample = this.track.sampleAtDistance(projection.distance + 6);
    racer.sim.recoverTo(
      sample.x + sample.rx * sample.racingLine,
      sample.y,
      sample.z + sample.rz * sample.racingLine,
      sample.heading,
      RECOVERY_SPEED,
    );
    racer.lastProjectedDistance = this.track.project(
      racer.sim.state.x,
      racer.sim.state.z,
      racer.trackIndex,
    ).distance;

    if (racer.isPlayer) {
      this.bridge.onEvent({
        type: "story",
        speaker: "HALO",
        line: "Putting you back on the line. The clock kept running.",
      });
    }
  }

  /**
   * Solid road edges.
   *
   * Besides being the obvious arcade behaviour, this is what makes the
   * derived-progress model safe: a car cannot leave the ribbon, so it cannot
   * shortcut a corner and claim arc length it did not cover.
   */
  private resolveTrackEdge(racer: Racer, halfWidth: number): void {
    const state = racer.sim.state;
    const projection = this.track.project(state.x, state.z, racer.trackIndex);
    const car = CARS[racer.carId];
    const limit = halfWidth - car.tuning.halfWidth * 0.6;

    if (Math.abs(projection.lateral) <= limit) {
      if (racer.isPlayer && this.telemetry.offTrack) {
        this.telemetry.offTrack = false;
        this.bridge.onEvent({ type: "off-track", offTrack: false });
      }
      if (racer.isPlayer) this.telemetry.lateralOffset = projection.lateral;
      return;
    }

    const sample = this.track.sampleAt(projection.index);
    const side = Math.sign(projection.lateral) || 1;

    // Push back to the edge and reflect off the inward normal.
    const overshoot = Math.abs(projection.lateral) - limit;
    state.x -= sample.rx * side * overshoot;
    state.z -= sample.rz * side * overshoot;

    const impact = racer.sim.applyWallImpact(
      -sample.rx * side,
      -sample.rz * side,
      WALL_RESTITUTION,
    );

    if (racer.isPlayer) {
      this.telemetry.lateralOffset = side * limit;
      if (!this.telemetry.offTrack) {
        this.telemetry.offTrack = true;
        this.bridge.onEvent({ type: "off-track", offTrack: true });
      }
      if (impact > COLLISION_THRESHOLD) {
        this.registerPlayerCollision(impact);
      }
    }
  }

  private resolveCarContacts(): void {
    for (let i = 0; i < this.racers.length; i += 1) {
      const a = this.racers[i]!;
      for (let j = i + 1; j < this.racers.length; j += 1) {
        const b = this.racers[j]!;
        const dx = b.sim.state.x - a.sim.state.x;
        const dz = b.sim.state.z - a.sim.state.z;
        const dist2 = dx * dx + dz * dz;

        const ra = CARS[a.carId].tuning;
        const rb = CARS[b.carId].tuning;
        // Circle approximation. Box-on-box would be more accurate and is not
        // worth the cost for arcade contact.
        const minDist = ra.halfLength * 0.82 + rb.halfLength * 0.82;
        if (dist2 >= minDist * minDist || dist2 < 1e-6) continue;

        const dist = Math.sqrt(dist2);
        const nx = dx / dist;
        const nz = dz / dist;
        const overlap = minDist - dist;

        // Separate both cars, then exchange a little momentum.
        a.sim.state.x -= nx * overlap * 0.5;
        a.sim.state.z -= nz * overlap * 0.5;
        b.sim.state.x += nx * overlap * 0.5;
        b.sim.state.z += nz * overlap * 0.5;

        const closing =
          (b.sim.state.vx - a.sim.state.vx) * nx +
          (b.sim.state.vz - a.sim.state.vz) * nz;
        if (closing < 0) {
          const impulse = clamp(-closing * 0.45, 0, 9);
          a.sim.applyCarImpact(-nx, -nz, impulse);
          b.sim.applyCarImpact(nx, nz, impulse);

          const player = a.isPlayer ? a : b.isPlayer ? b : null;
          if (player && -closing > COLLISION_THRESHOLD) {
            this.registerPlayerCollision(-closing);
          }
        }
      }
    }
  }

  private registerPlayerCollision(severity: number): void {
    const player = this.player;
    player.collisions += 1;
    this.telemetry.collisions = player.collisions;
    this.pendingCollisions += 1;

    // Contact ends a drift chain: no credit for bouncing off scenery.
    const ended = this.drift.breakChain();
    if (ended.chainEnded) {
      this.bridge.onEvent({
        type: "drift-end",
        score: Math.floor(ended.endedScore),
        durationMs: Math.floor(ended.endedDurationMs),
        multiplier: ended.endedMultiplier,
      });
    }

    this.bridge.onEvent({
      type: "collision",
      severity,
      totalCollisions: player.collisions,
    });
  }

  /**
   * Accumulate monotonic arc length, then derive laps and checkpoints from it.
   */
  private updateProgress(_dt: number): void {
    const length = this.track.length;
    const gateSpacing = length / CHECKPOINTS_PER_LAP;

    for (const racer of this.racers) {
      if (racer.finished) continue;

      const projection = this.track.project(
        racer.sim.state.x,
        racer.sim.state.z,
        racer.trackIndex,
      );

      // Unwrap: a projected distance that jumps from ~length to ~0 is a lap,
      // not a teleport backwards.
      let delta = projection.distance - racer.lastProjectedDistance;
      if (delta > length * 0.5) delta -= length;
      else if (delta < -length * 0.5) delta += length;
      racer.lastProjectedDistance = projection.distance;

      // Reversing must not rack up progress.
      racer.travelled = Math.max(racer.travelled, racer.travelled + delta);

      const past = racer.travelled - racer.startOffset;
      const laps = past >= 0 ? Math.floor(past / length) : 0;
      const gates = past >= 0 ? Math.floor(past / gateSpacing) + 1 : 0;

      if (racer.isPlayer) {
        this.telemetry.lapProgress =
          past >= 0 ? (past % length) / length : 0;
      }

      if (gates > racer.checkpointsHit) {
        racer.checkpointsHit = gates;
        if (racer.isPlayer) {
          const gateIndex = (gates - 1) % CHECKPOINTS_PER_LAP;
          this.telemetry.checkpoint = gateIndex;
          this.splits.push(Math.floor(this.raceTimeMs));
          this.hasher.push(gates);
          this.hasher.push(this.raceTimeMs);
          this.bridge.onEvent({
            type: "checkpoint",
            index: gateIndex,
            lap: racer.lapsCompleted + 1,
            elapsedMs: Math.floor(this.raceTimeMs),
          });
        }
      }

      if (laps > racer.lapsCompleted) {
        racer.lapsCompleted = laps;
        const lapMs = Math.floor(this.raceTimeMs - racer.lapStartMs);
        racer.lapStartMs = this.raceTimeMs;
        racer.lapTimesMs.push(lapMs);
        const isBest = racer.bestLapMs === 0 || lapMs < racer.bestLapMs;
        if (isBest) racer.bestLapMs = lapMs;

        if (racer.isPlayer) {
          this.telemetry.lap = Math.min(laps + 1, this.level.laps);
          this.telemetry.lastLapMs = lapMs;
          this.telemetry.bestLapMs = racer.bestLapMs;
          this.bankDeferredLaps = laps - this.bankedAtLap;
          this.telemetry.bankDeferredLaps = this.bankDeferredLaps;
          this.bridge.onEvent({
            type: "lap",
            lap: laps,
            lapMs,
            totalMs: Math.floor(this.raceTimeMs),
            best: isBest,
          });
          this.fireStory(laps + 1);
        }
      }
    }
  }

  private updatePositions(): void {
    // Finished cars hold their finishing order; the rest sort on distance.
    const ordered = [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishMs - b.finishMs;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.travelled - a.travelled;
    });

    const player = this.player;
    const previous = player.position;

    ordered.forEach((racer, index) => {
      racer.position = index + 1;
    });

    if (player.position !== previous) {
      if (player.position < previous) this.overtakes += previous - player.position;
      this.telemetry.position = player.position;
      this.bridge.onEvent({
        type: "position",
        position: player.position,
        previous,
      });
    }
  }

  private updatePlayerScoring(dt: number): void {
    const player = this.player;
    const state = player.sim.state;
    const t = this.telemetry;

    const driftResult = this.drift.update(
      state.slipAngle,
      state.speed,
      state.onGround,
      dt,
    );
    if (driftResult.gained > 0) this.pendingDrift += driftResult.gained;
    if (driftResult.chainEnded) {
      this.bridge.onEvent({
        type: "drift-end",
        score: Math.floor(driftResult.endedScore),
        durationMs: Math.floor(driftResult.endedDurationMs),
        multiplier: driftResult.endedMultiplier,
      });
    }

    t.speedMs = state.speed;
    t.speedKph = state.speed * 3.6;
    t.rpm = state.rpm;
    t.gear = state.gear;
    t.throttle = this.playerInput.throttle;
    t.brake = this.playerInput.brake;
    t.steer = this.playerInput.steer;
    t.handbrake = this.playerInput.handbrake;
    t.slipAngle = Math.abs(state.slipAngle);
    t.drifting = this.drift.active;
    t.driftChain = Math.floor(this.drift.chain);
    t.driftMultiplier = this.drift.multiplier;
    t.driftScore = this.drift.integerTotal;
    t.raceTimeMs = this.raceTimeMs;
    t.currentLapMs = this.raceTimeMs - player.lapStartMs;
    t.deltaMs =
      player.bestLapMs > 0 ? t.currentLapMs - player.bestLapMs : 0;

    t.projectedXp = projectXp(
      this.level,
      this.raceTimeMs,
      player.lapsCompleted,
      t.lapProgress,
      t.driftScore,
      player.collisions,
      this.overtakes,
      player.position,
      this.bankDeferredLaps,
    );

    this.hasher.push(this.playerInput.throttle);
    this.hasher.push(this.playerInput.brake);
    this.hasher.push(this.playerInput.steer);
  }

  /**
   * Hand a state transition to the chain layer.
   *
   * Called every step; the tick queue coalesces. Practice mode skips it
   * entirely so no rollup traffic is generated for a run that cannot settle.
   */
  private emitTick(): void {
    if (this.practice) return;

    const player = this.player;
    const drift = Math.floor(this.pendingDrift);
    const collisions = this.pendingCollisions;

    if (drift <= 0 && collisions <= 0 && this.tickSequence > 0) {
      // Nothing happened this step. Still advance the rollup's view of the clock
      // periodically, so a car cruising a straight is not invisible to it.
      if (this.tickSequence % IDLE_TICK_INTERVAL !== 0) {
        this.tickSequence += 1;
        return;
      }
    }

    this.pendingDrift -= drift;
    this.pendingCollisions = 0;
    this.ticksEmitted += 1;

    this.bridge.onTick({
      checkpoint: player.checkpointsHit,
      lap: player.lapsCompleted,
      driftDelta: drift,
      collisions,
      elapsedMs: Math.floor(this.raceTimeMs),
      sequence: this.tickSequence++,
    });
  }

  private rubberBandFor(racer: Racer): number {
    if (this.level.bossRace) return 0;
    const player = this.player;
    const gap = racer.travelled - player.travelled;
    // ±120m maps to the full ±1 range; the AI only trims 7% of target speed.
    return clamp(gap / 120, -1, 1);
  }

  private checkFinish(): void {
    const totalDistance = this.level.laps * this.track.length;

    for (const racer of this.racers) {
      if (racer.finished) continue;
      if (racer.travelled - racer.startOffset >= totalDistance) {
        racer.finished = true;
        racer.finishMs = this.raceTimeMs;
      }
    }

    const player = this.player;
    if (!player.finished) return;

    this.updatePositions();
    this.finishRace();
  }

  private finishRace(): void {
    if (this.result) return;

    const player = this.player;
    const totalMs = Math.max(1, Math.floor(player.finishMs));

    // Close any live drift chain so its score is not silently dropped.
    this.drift.breakChain();

    const cleared =
      player.position <= this.level.targetPosition &&
      this.drift.integerTotal >= this.level.driftTarget;

    const xp = computeXp(this.level, {
      totalMs,
      driftScore: this.drift.integerTotal,
      collisions: player.collisions,
      overtakes: this.overtakes,
      position: player.position,
      bankDeferredLaps: this.bankDeferredLaps,
    });

    this.hasher.push(totalMs);
    this.hasher.push(this.drift.integerTotal);
    this.hasher.push(player.position);

    this.result = {
      levelId: this.level.id,
      carId: player.carId,
      seed: this.seed.toString(),
      totalMs,
      bestLapMs: player.bestLapMs,
      lapTimesMs: [...player.lapTimesMs],
      position: player.position,
      totalRacers: this.racers.length,
      driftScore: this.drift.integerTotal,
      collisions: player.collisions,
      overtakes: this.overtakes,
      checkpointsHit: player.checkpointsHit,
      ticks: this.ticksEmitted,
      bankDeferredLaps: this.bankDeferredLaps,
      cleared,
      replayHash: this.hasher.digestHex(),
      splits: [...this.splits],
      xp,
    };

    this.telemetry.projectedXp = xp.total;
    this.setPhase("finished");
    this.fireStory("finish");
    this.bridge.onEvent({ type: "finish", result: this.result });
  }

  /** 32-byte digest for `finish_race`. */
  replayDigest(): Uint8Array {
    return this.hasher.digest();
  }

  private fireStory(at: "pre" | "start" | "finish" | number): void {
    const key = String(at);
    if (this.storyFired.has(key)) return;
    this.storyFired.add(key);
    for (const beat of this.level.story) {
      if (beat.at === at) {
        this.bridge.onEvent({
          type: "story",
          speaker: beat.speaker,
          line: beat.line,
        });
      }
    }
  }
}
