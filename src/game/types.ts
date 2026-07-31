/**
 * The engine ↔ application contract.
 *
 * `game/*` must not import React, zustand or anything under `chain/*`. The
 * application passes in a `GameBridge` and the engine calls it. That keeps the
 * simulation portable and testable, and it is what stops chain I/O from ever
 * appearing on the render path.
 */

import type { CarId } from "./config/cars";
import type { LevelId } from "./config/levels";
import type { QualityTier } from "./config/quality";

export type RacePhase =
  | "loading"
  | "ready"
  | "countdown"
  | "racing"
  | "finished"
  | "failed"
  | "paused";

/** APEX is a desktop build: keyboard and gamepad only. */
export type ControlScheme = "keyboard" | "gamepad";

/**
 * One row of the live order, for the leaderboard.
 *
 * The engine keeps one of these per racer for the whole race and mutates them in
 * place — see `Telemetry`'s note on allocation — so a consumer that wants to hold
 * on to a row has to copy it.
 */
export interface StandingEntry {
  /** Stable racer id, so React can key rows across reorders. */
  id: number;
  name: string;
  isPlayer: boolean;
  /** 1-based, and the array is sorted by it. */
  position: number;
  lapsCompleted: number;
  bestLapMs: number;
  finished: boolean;
  /** Distance behind the leader, metres. 0 for the leader. */
  gapM: number;
  /** Contacts this driver has had. */
  contacts: number;
  /** XP this driver has forfeited to contact. */
  penaltyPoints: number;
}

/**
 * Per-frame mutable telemetry.
 *
 * A single long-lived object: the HUD reads a throttled snapshot of it, React never
 * sees the live object. Nothing in the render loop is allowed to allocate a new one,
 * which is why `standings` is a fixed array of mutable rows rather than rebuilt each
 * step — and why `Engine` deep-copies it when it publishes.
 */
export interface Telemetry {
  speedMs: number;
  speedKph: number;
  /** Normalised engine speed, 0-1, for the tacho and audio pitch. */
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;

  /** Current slip angle magnitude, radians. */
  slipAngle: number;
  drifting: boolean;
  /** Score accumulating in the current unbroken drift. */
  driftChain: number;
  /** Multiplier on the active chain, 1-5. */
  driftMultiplier: number;
  /** Total drift score this run. */
  driftScore: number;

  lap: number;
  totalLaps: number;
  checkpoint: number;
  totalCheckpoints: number;
  /** 0-1 around the current lap. Drives the minimap marker. */
  lapProgress: number;

  position: number;
  totalRacers: number;
  /** The whole field, sorted by position. */
  standings: StandingEntry[];

  raceTimeMs: number;
  currentLapMs: number;
  lastLapMs: number;
  bestLapMs: number;
  /** Signed delta of the current lap against `bestLapMs`. */
  deltaMs: number;

  collisions: number;
  /** XP forfeited to contact so far. */
  penaltyPoints: number;
  offTrack: boolean;
  /** Distance from the racing line, metres. Feeds the off-track warning. */
  lateralOffset: number;

  /** Estimated XP if the run ended right now. */
  projectedXp: number;
  /** Laps completed without banking, for the Act IV risk multiplier. */
  bankDeferredLaps: number;

  phase: RacePhase;
  /** Seconds remaining on the start light sequence. */
  countdown: number;
  fps: number;
}

export function createTelemetry(totalLaps: number, totalCheckpoints: number): Telemetry {
  return {
    speedMs: 0,
    speedKph: 0,
    rpm: 0,
    gear: 1,
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    slipAngle: 0,
    drifting: false,
    driftChain: 0,
    driftMultiplier: 1,
    driftScore: 0,
    lap: 1,
    totalLaps,
    checkpoint: 0,
    totalCheckpoints,
    lapProgress: 0,
    position: 1,
    totalRacers: 1,
    standings: [],
    raceTimeMs: 0,
    currentLapMs: 0,
    lastLapMs: 0,
    bestLapMs: 0,
    deltaMs: 0,
    collisions: 0,
    penaltyPoints: 0,
    offTrack: false,
    lateralOffset: 0,
    projectedXp: 0,
    bankDeferredLaps: 0,
    phase: "loading",
    countdown: 0,
    fps: 0,
  };
}

/** Discrete gameplay events. These are the only things that reach React. */
export type GameEvent =
  | { type: "phase"; phase: RacePhase }
  | { type: "countdown"; value: number }
  | { type: "checkpoint"; index: number; lap: number; elapsedMs: number }
  | { type: "lap"; lap: number; lapMs: number; totalMs: number; best: boolean }
  | { type: "position"; position: number; previous: number }
  | { type: "collision"; severity: number; totalCollisions: number }
  | { type: "drift-end"; score: number; durationMs: number; multiplier: number }
  | { type: "off-track"; offTrack: boolean }
  | { type: "story"; speaker: string; line: string }
  | { type: "finish"; result: RaceResult }
  | { type: "failed"; reason: FailureReason }
  | { type: "quality"; tier: QualityTier; reason: string }
  | { type: "loaded" }
  /** A car model could not be fetched. The race runs on placeholders. */
  | { type: "load-failed"; reason: string };

export type FailureReason =
  | "drift-target-missed"
  | "position-target-missed"
  | "retired"
  | "timeout";

/** The authoritative outcome of a run. Feeds both the results UI and the chain. */
export interface RaceResult {
  levelId: LevelId;
  carId: CarId;
  seed: string;
  totalMs: number;
  bestLapMs: number;
  lapTimesMs: number[];
  position: number;
  totalRacers: number;
  driftScore: number;
  collisions: number;
  overtakes: number;
  checkpointsHit: number;
  /**
   * State transitions the engine handed to the chain layer.
   *
   * Not the same as rollup transactions: the tick queue coalesces these into at
   * most one transaction per flush window. The confirmed on-chain count comes
   * from the session store's `ticksLanded`.
   */
  ticks: number;
  bankDeferredLaps: number;
  cleared: boolean;
  /** Hex replay digest bound to this result. */
  replayHash: string;
  /** Per-checkpoint elapsed times, for verification and ghosts. */
  splits: number[];
  xp: XpBreakdown;
}

export interface XpBreakdown {
  pace: number;
  drift: number;
  clean: number;
  overtakes: number;
  placing: number;
  /**
   * XP forfeited to contact, as a positive number to subtract.
   *
   * Saturated at the subtotal on both sides of the wire, because the program's
   * arithmetic is unsigned: a driver who spends the whole race in the barriers
   * scores zero, never a negative that would wrap.
   */
  penalty: number;
  /** Percent, 100 = x1.00. */
  riskPercent: number;
  total: number;
}

/**
 * Callbacks the engine invokes. Every method must be cheap and non-blocking:
 * `onTick` in particular is called from inside the fixed step.
 */
export interface GameBridge {
  /** Discrete event stream for UI + chain reactions. */
  onEvent(event: GameEvent): void;
  /**
   * A state transition worth writing to the rollup. Implementations must queue
   * and return immediately — never await here.
   */
  onTick(tick: TickPayload): void;
  /**
   * Throttled snapshot for the HUD, published a few times a second rather than
   * per frame. This is the only per-race value React is allowed to see, and the
   * interval is what keeps the reconciler off the render path.
   */
  onTelemetry?(telemetry: Telemetry): void;
}

/** One rollup-bound state transition. */
export interface TickPayload {
  checkpoint: number;
  lap: number;
  driftDelta: number;
  collisions: number;
  elapsedMs: number;
  /** Monotonic engine tick index. */
  sequence: number;
}

export interface RaceConfig {
  levelId: LevelId;
  carId: CarId;
  /**
   * The player's display name. Local and cosmetic; never sent to the chain.
   */
  driverName: string;
  /** Decimal string so a u64 survives the trip through JSON. */
  seed: string;
  quality: QualityTier;
  controls: ControlScheme;
  /** Practice runs never touch the chain and skip the session lifecycle. */
  practice: boolean;
  /** Ghost lap times to race against, if any. */
  ghostSplits?: number[];
  masterVolume: number;
  sfxEnabled: boolean;
  /** Reduce camera shake and screen effects. */
  reducedMotion: boolean;
}

export interface EngineHandle {
  start(): void;
  pause(): void;
  resume(): void;
  restart(): void;
  retire(): void;
  /** Act IV: player banked the run at a lap boundary. */
  markBanked(): void;
  setControls(scheme: ControlScheme): void;
  setVolume(volume: number): void;
  setDriverName(name: string): void;
  readonly telemetry: Readonly<Telemetry>;
  dispose(): void;
}
