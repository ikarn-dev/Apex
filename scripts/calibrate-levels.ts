#!/usr/bin/env tsx
/**
 * Par-time calibration.
 *
 * `parMs` is the reference the XP pace term is scored against, so a bad value
 * quietly breaks the economy: set it too fast and every player bottoms out at the
 * 25% clamp, too slow and everyone tops out at 200%. Guessing it from track
 * length does not work, because a corner-heavy 2km circuit takes far longer than
 * a flowing 2km one.
 *
 * So it is measured. This runs each level headlessly with the real rival AI and
 * reports the fastest AI finish, which is exactly the benchmark the player is
 * racing against. Suggested values:
 *
 *   parMs   ≈ fastest AI time — a player matching the best rival scores 1.0×
 *   floorMs ≈ 0.62 × par     — a physical lower bound for the on-chain check,
 *                              loose enough never to reject a real run
 *
 * Run: npm run calibrate
 */

import { RaceDirector, FIXED_STEP } from "../src/game/race/RaceDirector";
import type { Track } from "../src/game/track/Track";
import { LEVELS, CAMPAIGN_ORDER, LEVEL_INDEX, type LevelId } from "../src/game/config/levels";
import type { GameBridge } from "../src/game/types";
import { clamp, wrapAngle } from "../src/lib/math";

export type PolicyStyle = "clean" | "drift";

/**
 * Player stand-in.
 *
 * `clean` drives for time and only slides by accident, which is the lower bound
 * on drift score. `drift` deliberately overspeeds corner entry and pulls the
 * handbrake, which approximates a player chasing the Act III gate. The two
 * together bracket where a drift target should sit.
 */
function policy(
  track: Track,
  state: { x: number; z: number; yaw: number; speed: number; slipAngle: number },
  hint: number,
  style: PolicyStyle,
  gripScale: number,
) {
  const projection = track.project(state.x, state.z, hint);
  const target = track.sampleAtDistance(projection.distance + 12 + state.speed * 1.1);
  const tx = target.x + target.rx * target.racingLine;
  const tz = target.z + target.rz * target.racingLine;
  const error = wrapAngle(Math.atan2(tx - state.x, tz - state.z) - state.yaw);

  let worst = 0;
  for (let d = 6; d < 30 + state.speed * 1.9; d += 6) {
    worst = Math.max(
      worst,
      Math.abs(track.sampleAtDistance(projection.distance + d).curvature),
    );
  }
  const grip = 11 * gripScale;
  const cornerSpeed = worst > 1e-5 ? Math.sqrt(grip / worst) : 80;

  if (style === "clean") {
    return {
      steer: clamp(error * 2.0, -1, 1),
      throttle: state.speed < cornerSpeed ? 1 : 0,
      brake: state.speed > cornerSpeed * 1.12 ? 0.7 : 0,
      handbrake: false,
    };
  }

  // Drift style: carry ~25% more speed into corners, counter-steer the resulting
  // slide, and use the handbrake to start rotation.
  const entry = cornerSpeed * 1.25;
  const inCorner = worst > 0.008;
  return {
    steer: clamp(error * 2.2 - state.slipAngle * 0.9, -1, 1),
    throttle: state.speed < entry ? 1 : 0.55,
    brake: state.speed > entry * 1.3 ? 0.5 : 0,
    handbrake: inCorner && state.speed > 16 && Math.abs(state.slipAngle) < 0.35,
  };
}

interface Measurement {
  levelId: LevelId;
  lengthKm: number;
  totalKm: number;
  /** Best single lap by any rival — the benchmark par is derived from. */
  bestAiLapMs: number | null;
  /** Best single lap by the scripted player stand-in, for comparison. */
  bestPlayerLapMs: number | null;
  /** How far the leading rival got, as a fraction of race distance. */
  aiProgress: number;
  playerMs: number | null;
  playerDriftScore: number;
  minRadius: number;
  maxSlopePct: number;
}

function measure(levelId: LevelId, style: PolicyStyle = "clean"): Measurement {
  const level = LEVELS[levelId];
  const bridge: GameBridge = { onEvent: () => {}, onTick: () => {} };

  const director = new RaceDirector({
    level,
    carId: level.recommendedCar,
    seed: 0xca11b8a7n + BigInt(LEVEL_INDEX[levelId]),
    maxRivals: level.rivals,
    bridge,
    practice: true,
  });

  director.beginCountdown();

  const track = director.track;
  // Generous budget: the point is to observe, not to enforce.
  const maxSteps = Math.ceil(900 / FIXED_STEP);
  let steps = 0;

  while (steps < maxSteps) {
    const player = director.player;
    director.setPlayerInput(
      policy(track, player.sim.state, player.trackIndex, style, level.gripScale),
    );
    director.update(FIXED_STEP);
    steps += 1;
    if (director.currentPhase === "finished" || director.currentPhase === "failed") break;
  }

  const rivals = director.racers.filter((r) => !r.isPlayer);
  const player = director.player;

  const bestAiLap = rivals
    .filter((r) => r.bestLapMs > 0)
    .reduce<number | null>(
      (best, r) => (best === null || r.bestLapMs < best ? r.bestLapMs : best),
      null,
    );

  const raceDistance = track.length * level.laps;
  const leaderDistance = rivals.reduce(
    (best, r) => Math.max(best, r.travelled - r.startOffset),
    0,
  );

  const curvatures = track.samples.map((s) => Math.abs(s.curvature));
  const slopes = track.samples.map((s) => Math.abs(s.slope));

  return {
    levelId,
    lengthKm: track.length / 1000,
    totalKm: raceDistance / 1000,
    bestAiLapMs: bestAiLap,
    bestPlayerLapMs: player.bestLapMs > 0 ? player.bestLapMs : null,
    aiProgress: raceDistance > 0 ? leaderDistance / raceDistance : 0,
    playerMs: director.raceResult?.totalMs ?? null,
    playerDriftScore: director.raceResult?.driftScore ?? 0,
    minRadius: 1 / Math.max(...curvatures),
    maxSlopePct: Math.max(...slopes) * 100,
  };
}

const ids: LevelId[] = [...CAMPAIGN_ORDER, "endless-time-attack"];

/**
 * A clean race is a little slower than the sum of its best laps — traffic, the
 * standing start, one scruffy corner. 5% covers it.
 */
const PAR_FROM_LAPS = 1.05;

console.log(
  `\n  ${"level".padEnd(24)}${"laps".padStart(6)}${"total".padStart(8)}${"minR".padStart(7)}` +
    `${"grip".padStart(6)}${"AI lap".padStart(9)}${"own lap".padStart(9)}${"AI prog".padStart(9)}` +
    `${"par now".padStart(9)}${"par →".padStart(9)}${"drift".padStart(8)}${"drifty".padStart(8)}`,
);
console.log(`  ${"-".repeat(113)}`);

const suggestions: { levelId: LevelId; par: number; floor: number; drift: number }[] = [];
const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);

for (const levelId of ids) {
  const m = measure(levelId, "clean");
  const drifty = measure(levelId, "drift");
  const level = LEVELS[levelId];

  // Par comes from the best lap either driver managed, times lap count. Using a
  // lap rather than a finish time means the number is unaffected by whether a
  // particular run happened to get held up in traffic.
  const reference =
    m.bestAiLapMs !== null && m.bestPlayerLapMs !== null
      ? Math.min(m.bestAiLapMs, m.bestPlayerLapMs)
      : (m.bestAiLapMs ?? m.bestPlayerLapMs);

  const par =
    reference !== null
      ? Math.round((reference * level.laps * PAR_FROM_LAPS) / 500) * 500
      : level.parMs;
  const floor = Math.round((par * 0.62) / 500) * 500;

  // A drift gate should be out of reach for someone driving for time and
  // comfortably reachable for someone chasing angle. Two thirds of the way from
  // the clean score to the drift-seeking score puts it there.
  // Rounded to 10, not 500: on a single lap of a real circuit the spread
  // between a clean run and a drift-seeking one is a few hundred points, and a
  // 500-point grid collapses that to zero.
  const driftSpan = drifty.playerDriftScore - m.playerDriftScore;
  const drift = Math.round((m.playerDriftScore + driftSpan * 0.66) / 10) * 10;
  suggestions.push({ levelId, par, floor, drift });

  console.log(
    `  ${`${level.actLabel} ${level.title}`.padEnd(24)}` +
      `${String(level.laps).padStart(6)}` +
      `${`${m.totalKm.toFixed(1)}km`.padStart(8)}` +
      `${`${m.minRadius.toFixed(0)}m`.padStart(7)}` +
      `${level.gripScale.toFixed(2).padStart(6)}` +
      `${secs(m.bestAiLapMs).padStart(9)}` +
      `${secs(m.bestPlayerLapMs).padStart(9)}` +
      `${`${(m.aiProgress * 100).toFixed(0)}%`.padStart(9)}` +
      `${secs(level.parMs).padStart(9)}` +
      `${secs(par).padStart(9)}` +
      `${String(m.playerDriftScore).padStart(8)}` +
      `${String(drifty.playerDriftScore).padStart(8)}`,
  );
}

console.log(`\n  Paste into src/game/config/levels.ts and programs/apex_racing/src/xp.rs:\n`);
for (const s of suggestions) {
  console.log(
    `    ${LEVELS[s.levelId].actLabel.padEnd(9)} parMs: ${s.par}, floorMs: ${s.floor}` +
      (LEVELS[s.levelId].driftTarget > 0 ? `, driftTarget: ${s.drift}` : ""),
  );
}
console.log(
  `\n  "AI prog" is how far the leading rival got before the race ended. Well\n` +
    `  under 100% means the field is too slow to be a race.\n`,
);
