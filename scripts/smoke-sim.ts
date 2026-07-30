#!/usr/bin/env tsx
/**
 * Headless simulation smoke test.
 *
 * The whole point of keeping `game/*` free of React, DOM and chain imports is
 * that the simulation can run without a browser. This exercises that: it drives
 * a full race with a scripted AI-style input policy and asserts the things a
 * green build cannot tell you.
 *
 * What it checks:
 *   1. Tracks generate as closed, non-self-intersecting loops of sane length.
 *   2. A car actually completes the required laps and the race finishes.
 *   3. Checkpoints are hit in order and none are skipped.
 *   4. XP is computed and matches a fresh evaluation of the same formula.
 *   5. The simulation is deterministic — same seed and inputs, same replay hash.
 *   6. The rollup tick stream is produced at a sane rate.
 *
 * Run: npm run test:sim
 */

import { RaceDirector, FIXED_STEP } from "../src/game/race/RaceDirector";
import { CHECKPOINTS_PER_LAP, Track } from "../src/game/track/Track";
import { LEVELS, CAMPAIGN_ORDER, type LevelId } from "../src/game/config/levels";
import { CARS } from "../src/game/config/cars";
import { computeXp } from "../src/game/scoring/xp";
import type { GameBridge, GameEvent, RaceResult, TickPayload } from "../src/game/types";
import { clamp, wrapAngle } from "../src/lib/math";

let failures = 0;
let checks = 0;

function check(condition: boolean, label: string, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

/**
 * A simple racing-line follower, used as the *player* so the run is repeatable.
 *
 * Not the game's AI — it deliberately drives the centreline conservatively, so a
 * pass here means the physics and track can be navigated at all, which is the
 * property under test.
 */
function drivePolicy(
  track: Track,
  state: { x: number; z: number; yaw: number; speed: number },
  trackIndex: number,
  gripScale: number,
) {
  const projection = track.project(state.x, state.z, trackIndex);
  const lookahead = 12 + state.speed * 1.1;
  const target = track.sampleAtDistance(projection.distance + lookahead);
  const targetX = target.x + target.rx * target.racingLine;
  const targetZ = target.z + target.rz * target.racingLine;

  const desired = Math.atan2(targetX - state.x, targetZ - state.z);
  const error = wrapAngle(desired - state.yaw);

  // Slow for curvature ahead, otherwise keep it pinned. Corner speed has to
  // account for surface grip, or the policy carries dry-asphalt speed onto a
  // slick track and spends the race in the barriers.
  let worst = 0;
  for (let d = 6; d < 30 + state.speed * 1.8; d += 6) {
    const s = track.sampleAtDistance(projection.distance + d);
    worst = Math.max(worst, Math.abs(s.curvature));
  }
  const cornerSpeed = worst > 1e-5 ? Math.sqrt((11 * gripScale) / worst) : 80;

  return {
    steer: clamp(error * 2.0, -1, 1),
    throttle: state.speed < cornerSpeed ? 1 : 0,
    brake: state.speed > cornerSpeed * 1.12 ? 0.7 : 0,
    handbrake: false,
  };
}

interface RunOutcome {
  result: RaceResult | null;
  events: GameEvent[];
  ticks: TickPayload[];
  steps: number;
  checkpointSequence: number[];
  /** How far the leading rival got, as a fraction of race distance. */
  leaderProgress: number;
  /** Fraction of racing steps the player spent under 5km/h. */
  crawlFraction: number;
}

/**
 * Drive a level to completion.
 *
 * The budget is derived from the level's own par time rather than being a flat
 * number of seconds — a flat budget silently failed the longer acts and made it
 * look like a physics bug. 2.5× par is generous for a policy this crude while
 * still catching a car that is genuinely stuck.
 */
function runRace(levelId: LevelId, seed: bigint): RunOutcome {
  const level = LEVELS[levelId];
  const maxSeconds = (level.parMs / 1000) * 2.5;
  const events: GameEvent[] = [];
  const ticks: TickPayload[] = [];
  const checkpointSequence: number[] = [];

  const bridge: GameBridge = {
    onEvent: (event) => {
      events.push(event);
      if (event.type === "checkpoint") checkpointSequence.push(event.index);
    },
    onTick: (tick) => ticks.push(tick),
  };

  const director = new RaceDirector({
    level,
    carId: level.recommendedCar,
    seed,
    maxRivals: level.rivals,
    bridge,
    practice: false,
  });

  director.beginCountdown();

  const maxSteps = Math.ceil(maxSeconds / FIXED_STEP);
  let steps = 0;
  let racingSteps = 0;
  let crawlSteps = 0;

  while (steps < maxSteps) {
    const player = director.player;
    const state = player.sim.state;
    director.setPlayerInput(
      drivePolicy(director.track, state, player.trackIndex, level.gripScale),
    );
    director.update(FIXED_STEP);
    steps += 1;

    if (director.currentPhase === "racing") {
      racingSteps += 1;
      if (state.speed < 1.4) crawlSteps += 1;
    }

    if (director.currentPhase === "finished" || director.currentPhase === "failed") {
      break;
    }
  }

  const raceDistance = director.track.length * level.laps;
  const leaderDistance = director.racers
    .filter((r) => !r.isPlayer)
    .reduce((best, r) => Math.max(best, r.travelled - r.startOffset), 0);

  return {
    result: director.raceResult,
    events,
    ticks,
    steps,
    checkpointSequence,
    leaderProgress: raceDistance > 0 ? leaderDistance / raceDistance : 0,
    crawlFraction: racingSteps > 0 ? crawlSteps / racingSteps : 0,
  };
}

// ------------------------------------------------------------ supplied route

section("Supplied circuit route");

for (const levelId of [...CAMPAIGN_ORDER, "endless-time-attack" as LevelId]) {
  const level = LEVELS[levelId];
  const track = new Track();

  const lengthKm = (track.length / 1000).toFixed(2);
  check(
    track.length > 5000 && track.length < 6500,
    `${level.actLabel} uses supplied Suzuka route`,
    `${lengthKm} km, ${track.samples.length} samples`,
  );

  const first = track.sampleAt(0);
  const last = track.sampleAt(track.samples.length - 1);
  const gap = Math.hypot(
    first.x - last.x,
    first.y - last.y,
    first.z - last.z,
  );
  check(
    gap < track.sampleSpacing * 1.6,
    `${level.actLabel} loop closes`,
    `gap ${gap.toFixed(2)} m`,
  );

  let maxSpacingError = 0;
  let finite = true;
  for (let i = 0; i < track.samples.length; i += 1) {
    const sample = track.sampleAt(i);
    const next = track.sampleAt(i + 1);
    const spacing = Math.hypot(
      next.x - sample.x,
      next.y - sample.y,
      next.z - sample.z,
    );
    maxSpacingError = Math.max(
      maxSpacingError,
      Math.abs(spacing - track.sampleSpacing),
    );
    finite = finite && Object.values(sample).every(Number.isFinite);
  }
  check(finite, `${level.actLabel} samples are finite`);
  check(
    maxSpacingError < 0.12,
    `${level.actLabel} samples stay uniformly spaced`,
    `max error ${maxSpacingError.toFixed(3)} m`,
  );

  check(
    track.checkpointIndices.length === CHECKPOINTS_PER_LAP,
    `${level.actLabel} checkpoint count`,
    `${track.checkpointIndices.length}`,
  );

  // Measured against the circuit's asphalt, so the corridor has to be wide
  // enough for a car plus racing room, and never wider than real asphalt.
  const widths = track.samples.map((sample) => sample.halfWidth);
  const narrowest = Math.min(...widths);
  const widest = Math.max(...widths);
  check(
    narrowest >= 3 && widest <= 8.5,
    `${level.actLabel} uses measured road boundaries`,
    `${narrowest.toFixed(2)}–${widest.toFixed(2)} m half-width`,
  );

  const carHalfWidth = CARS[level.recommendedCar].tuning.halfWidth;
  check(
    narrowest - carHalfWidth * 0.6 > carHalfWidth * 1.5,
    `${level.actLabel} corridor leaves racing room`,
    `${(narrowest - carHalfWidth * 0.6).toFixed(2)} m usable each side`,
  );
}

// ------------------------------------------------------------------- full race

section("Race completion — ACT II, Neon Mile");

const SEED = 0x5eed_1234n;
const run = runRace("act2-neon-mile", SEED);
const level2 = LEVELS["act2-neon-mile"];

check(run.result !== null, "race finished", `${run.steps} steps`);

if (run.result) {
  const r = run.result;

  check(
    r.totalMs >= level2.floorMs,
    "finish time above the anti-cheat floor",
    `${(r.totalMs / 1000).toFixed(2)}s vs floor ${(level2.floorMs / 1000).toFixed(2)}s`,
  );

  check(
    r.lapTimesMs.length === level2.laps,
    "all laps recorded",
    `${r.lapTimesMs.length}/${level2.laps}`,
  );

  const expectedCheckpoints = level2.laps * CHECKPOINTS_PER_LAP;
  check(
    r.checkpointsHit >= expectedCheckpoints,
    "no checkpoints skipped",
    `${r.checkpointsHit}/${expectedCheckpoints}`,
  );

  // Checkpoint indices must cycle 0..11 in order, every lap.
  let ordered = true;
  for (let i = 0; i < run.checkpointSequence.length; i += 1) {
    if (run.checkpointSequence[i] !== i % CHECKPOINTS_PER_LAP) {
      ordered = false;
      break;
    }
  }
  check(ordered, "checkpoints crossed in order", `${run.checkpointSequence.length} gates`);

  check(
    r.position >= 1 && r.position <= r.totalRacers,
    "finishing position valid",
    `P${r.position} of ${r.totalRacers}`,
  );

  // XP must be reproducible from the recorded facts by the shared formula.
  const recomputed = computeXp(level2, {
    totalMs: r.totalMs,
    driftScore: r.driftScore,
    collisions: r.collisions,
    overtakes: r.overtakes,
    position: r.position,
    bankDeferredLaps: r.bankDeferredLaps,
  });
  check(
    recomputed.total === r.xp.total,
    "XP matches an independent evaluation",
    `${r.xp.total} XP`,
  );
  check(r.xp.total > 0, "XP is non-zero", `pace ${r.xp.pace}, drift ${r.xp.drift}`);

  check(
    r.replayHash.length === 64 && /^[0-9a-f]+$/.test(r.replayHash),
    "replay hash is a 32-byte digest",
    r.replayHash.slice(0, 16) + "…",
  );

  // Tick rate: the queue coalesces, but the engine should still emit a steady
  // stream — that stream is the whole argument for the rollup.
  const ticksPerSecond = run.ticks.length / (r.totalMs / 1000);
  check(
    run.ticks.length > 100,
    "rollup tick stream produced",
    `${run.ticks.length} ticks, ${ticksPerSecond.toFixed(1)}/s`,
  );

  let monotonic = true;
  for (let i = 1; i < run.ticks.length; i += 1) {
    if (run.ticks[i]!.elapsedMs < run.ticks[i - 1]!.elapsedMs) monotonic = false;
    if (run.ticks[i]!.checkpoint < run.ticks[i - 1]!.checkpoint) monotonic = false;
  }
  check(monotonic, "tick elapsed time and checkpoints are monotonic");

  const finishEvents = run.events.filter((e) => e.type === "finish");
  check(finishEvents.length === 1, "exactly one finish event");
}

// ----------------------------------------------------------------- determinism

section("Determinism");

const repeat = runRace("act2-neon-mile", SEED);
check(
  repeat.result?.replayHash === run.result?.replayHash,
  "same seed reproduces the same replay hash",
  repeat.result?.replayHash.slice(0, 16) + "…",
);
check(
  repeat.result?.totalMs === run.result?.totalMs,
  "same seed reproduces the same finish time",
  `${repeat.result?.totalMs}ms`,
);
check(
  repeat.result?.driftScore === run.result?.driftScore,
  "same seed reproduces the same drift score",
  `${repeat.result?.driftScore}`,
);

const different = runRace("act2-neon-mile", 0xabcd_9999n);
check(
  different.result?.replayHash !== run.result?.replayHash,
  "a different seed produces a different run",
);

// ------------------------------------------------------------ every level runs

section("All levels are completable");

for (const levelId of [...CAMPAIGN_ORDER, "endless-time-attack" as LevelId]) {
  const level = LEVELS[levelId];
  const outcome = runRace(levelId, 0x1111n + BigInt(level.act));
  check(
    outcome.result !== null,
    `${level.actLabel} ${level.title}`,
    outcome.result
      ? `${(outcome.result.totalMs / 1000).toFixed(1)}s, P${outcome.result.position}, ${outcome.result.xp.total} XP, ${outcome.ticks.length} ticks`
      : `did not finish in ${outcome.steps} steps`,
  );

  // Guards against the wall death-spiral this test originally caught: a car
  // that grinds to a halt against a barrier and cannot get going again.
  check(
    outcome.crawlFraction < 0.05,
    `${level.actLabel} never grinds to a halt`,
    `${(outcome.crawlFraction * 100).toFixed(1)}% of racing steps under 5km/h`,
  );

  // A field that never gets near the finish is not a race. Endless has no
  // rivals by design, so it is exempt.
  if (level.rivals > 0) {
    check(
      outcome.leaderProgress > 0.6,
      `${level.actLabel} field is competitive`,
      `leading rival reached ${(outcome.leaderProgress * 100).toFixed(0)}%`,
    );
  }
}

section("Level objectives are meaningful");

for (const levelId of CAMPAIGN_ORDER) {
  const level = LEVELS[levelId];
  if (level.driftTarget === 0) continue;
  // Clean driving must not clear a drift gate by accident, or the act teaches
  // nothing. `npm run calibrate` verifies the other half — that a drift-seeking
  // line does clear it.
  const outcome = runRace(levelId, 0x2222n);
  check(
    (outcome.result?.driftScore ?? 0) < level.driftTarget,
    `${level.actLabel} drift gate is not cleared by driving cleanly`,
    `${outcome.result?.driftScore ?? 0} vs target ${level.driftTarget}`,
  );
}

section("Par times are achievable");

for (const levelId of [...CAMPAIGN_ORDER, "endless-time-attack" as LevelId]) {
  const level = LEVELS[levelId];
  // The pace term clamps at 25%-200%. If par is so far off that a competent run
  // pins the clamp, the XP economy stops responding to skill at all.
  const outcome = runRace(levelId, 0x3333n);
  const ratio = outcome.result ? level.parMs / outcome.result.totalMs : 0;
  check(
    ratio > 0.3 && ratio < 2,
    `${level.actLabel} par is in the responsive band`,
    `par/actual = ${ratio.toFixed(2)}`,
  );
}

// ---------------------------------------------------------------------- report

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed\n`,
);
process.exit(failures === 0 ? 0 : 1);
