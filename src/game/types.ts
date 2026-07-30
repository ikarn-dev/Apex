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
 * Per-frame mutable telemetry.
 *
 * A single long-lived object: Pixi reads it directly every frame, React never
 * sees it. Nothing in the render loop is allowed to allocate a new one.
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

  raceTimeMs: number;
  currentLapMs: number;
  lastLapMs: number;
  bestLapMs: number;
  /** Signed delta of the current lap against `bestLapMs`. */
  deltaMs: number;

  collisions: number;
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
    raceTimeMs: 0,
    currentLapMs: 0,
    lastLapMs: 0,
    bestLapMs: 0,
    deltaMs: 0,
    collisions: 0,
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
  | { type: "loaded" };

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

/**
 * A HUD implementation the engine can drive.
 *
 * Implemented by the Pixi HUD. The engine calls `update` from its render step
 * rather than the HUD running its own animation frame, so there is one loop in
 * the app and the HUD can never be a frame out of step with the scene.
 */
export interface HudLayer {
  update(telemetry: Readonly<Telemetry>, dt: number): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

export interface EngineHandle {
  start(): void;
  pause(): void;
  resume(): void;
  restart(): void;
  retire(): void;
  /** Act IV: player banked the run at a lap boundary. */
  markBanked(): void;
  setQuality(tier: QualityTier): void;
  setControls(scheme: ControlScheme): void;
  setVolume(volume: number): void;
  readonly telemetry: Readonly<Telemetry>;
  dispose(): void;
}
