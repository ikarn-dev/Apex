/**
 * Corner census: where the circuit turns, how hard, and how fast is sensible.
 *
 * Signage has to agree with the road it is painted on. Authoring a list of
 * corners by hand would let the two drift apart the moment a control point moves,
 * so the census is derived from the same smoothed curvature the AI brakes on and
 * `CircuitView` builds geometry from. Move a control point and the arrows, the
 * advisory numbers and the barrier warning lights all follow.
 *
 * Pure arithmetic over `Track.samples`: no DOM, no randomness, so the headless
 * harness can assert every number below.
 */

import type { Track } from "./Track";

export interface Corner {
  /** Sample index where curvature first exceeds the entry threshold. */
  entryIndex: number;
  /** Sample index of peak curvature. */
  apexIndex: number;
  /** Sample index where curvature falls back below the exit threshold. */
  exitIndex: number;
  /** Sample index the advance warning board is painted at. */
  boardIndex: number;
  /** +1 for a right-hand corner, -1 for a left-hander. */
  direction: 1 | -1;
  /** Peak absolute curvature, 1/m. */
  curvature: number;
  /** Radius at the apex, metres. */
  radius: number;
  /** Advisory speed, km/h. Always a multiple of `ADVISORY_STEP_KPH`. */
  advisoryKph: number;
  /** 1 gentle, 2 medium, 3 tight. Chevron count and board size follow it. */
  severity: 1 | 2 | 3;
  /** Length of the turning section along the route, metres. */
  length: number;
}

/**
 * Curvature thresholds, 1/m, with hysteresis.
 *
 * Two numbers rather than one because a single threshold splits a long corner
 * into a string of short ones wherever the smoothed curvature dips across it,
 * and every fragment would then get its own board.
 *
 * Entry is a 330m radius, which is set by the car rather than by taste: at its
 * 338km/h top speed it needs 302m to turn at all, so a 330m sweep is a corner
 * the driver has to lift for even though it barely looks like one. At 260m the
 * census missed the fast double-right onto the eastern run entirely.
 */
export const CORNER_ENTER = 1 / 330;
export const CORNER_EXIT = 1 / 560;

/** Turning sections closer together than this are one corner, metres. */
export const CORNER_MERGE_GAP = 34;

/**
 * Shortest run that counts as a corner rather than a kink, metres.
 *
 * Long enough to reject the direction changes between the esses. Those are real
 * curvature, but signing a 17m transition earns a board, four chevrons and an
 * advisory number for a bend the driver never lifts for.
 */
export const CORNER_MIN_LENGTH = 24;

/**
 * Lateral acceleration the advisory speed assumes, m/s².
 *
 * Deliberately below what the car can actually hold: an advisory speed is the
 * speed a corner can be taken comfortably at, not the limit. Sign the limit and
 * every board reads as an invitation to crash.
 */
export const ADVISORY_GRIP = 15;

/** Advisory speeds are rounded down to a multiple of this, km/h. */
export const ADVISORY_STEP_KPH = 10;

/** Advisory speeds are clamped to this band, km/h. */
export const ADVISORY_MIN_KPH = 40;
export const ADVISORY_MAX_KPH = 300;

/** How far before the turn-in point the warning board is painted, metres. */
export const BOARD_LEAD = 110;

/** Apex radius under which a corner is severity 3, then 2. Metres. */
const SEVERITY_TIGHT_RADIUS = 85;
const SEVERITY_MEDIUM_RADIUS = 210;

function wrapIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}

/** Comfortable speed through a given radius, km/h, rounded down to a step. */
export function advisorySpeedKph(radius: number): number {
  const metresPerSecond = Math.sqrt(ADVISORY_GRIP * Math.max(radius, 1));
  const raw = metresPerSecond * 3.6;
  const stepped = Math.floor(raw / ADVISORY_STEP_KPH) * ADVISORY_STEP_KPH;
  return Math.min(ADVISORY_MAX_KPH, Math.max(ADVISORY_MIN_KPH, stepped));
}

function severityFor(radius: number): 1 | 2 | 3 {
  if (radius < SEVERITY_TIGHT_RADIUS) return 3;
  if (radius < SEVERITY_MEDIUM_RADIUS) return 2;
  return 1;
}

/**
 * Every corner on the circuit, in route order.
 *
 * The scan starts at the straightest point on the lap rather than at sample 0.
 * Sample 0 is the start line, which is on a straight here but need not be, and a
 * corner that straddled the array boundary would otherwise be reported as two.
 */
export function findCorners(track: Track): Corner[] {
  const samples = track.samples;
  const count = samples.length;
  const spacing = track.sampleSpacing;

  let origin = 0;
  let straightest = Infinity;
  for (let i = 0; i < count; i += 1) {
    const magnitude = Math.abs(samples[i]!.curvature);
    if (magnitude < straightest) {
      straightest = magnitude;
      origin = i;
    }
  }

  interface Run {
    start: number;
    end: number;
  }

  // One pass with hysteresis: open a run when curvature exceeds the entry
  // threshold, close it when it drops below the exit threshold.
  const runs: Run[] = [];
  let open: Run | null = null;
  for (let step = 0; step < count; step += 1) {
    const index = wrapIndex(origin + step, count);
    const magnitude = Math.abs(samples[index]!.curvature);
    if (open === null) {
      if (magnitude >= CORNER_ENTER) open = { start: step, end: step };
    } else if (magnitude >= CORNER_EXIT) {
      open.end = step;
    } else {
      runs.push(open);
      open = null;
    }
  }
  if (open !== null) runs.push(open);

  // Merge runs separated by a short straight, and runs that changed direction
  // stay separate — a left immediately followed by a right is two corners and
  // needs two boards.
  const merged: Run[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const gap = (run.start - previous.end) * spacing;
      const previousDirection = Math.sign(
        samples[wrapIndex(origin + previous.end, count)]!.curvature,
      );
      const nextDirection = Math.sign(samples[wrapIndex(origin + run.start, count)]!.curvature);
      if (gap <= CORNER_MERGE_GAP && previousDirection === nextDirection) {
        previous.end = run.end;
        continue;
      }
    }
    merged.push({ ...run });
  }

  const corners: Corner[] = [];
  for (const run of merged) {
    const length = (run.end - run.start) * spacing;
    if (length < CORNER_MIN_LENGTH) continue;

    let apexStep = run.start;
    let peak = 0;
    for (let step = run.start; step <= run.end; step += 1) {
      const magnitude = Math.abs(samples[wrapIndex(origin + step, count)]!.curvature);
      if (magnitude > peak) {
        peak = magnitude;
        apexStep = step;
      }
    }
    if (peak <= 0) continue;

    const apexIndex = wrapIndex(origin + apexStep, count);
    const radius = 1 / peak;
    const entryIndex = wrapIndex(origin + run.start, count);

    corners.push({
      entryIndex,
      apexIndex,
      exitIndex: wrapIndex(origin + run.end, count),
      boardIndex: wrapIndex(entryIndex - Math.round(BOARD_LEAD / spacing), count),
      direction: samples[apexIndex]!.curvature > 0 ? 1 : -1,
      curvature: peak,
      radius,
      advisoryKph: advisorySpeedKph(radius),
      severity: severityFor(radius),
      length,
    });
  }

  return corners;
}

/**
 * Per-sample warning flag: the direction of the corner a sample belongs to, or 0.
 *
 * Covers the approach as well as the turn itself, because that is the stretch the
 * barrier lights are supposed to be warning through. Returned as a typed array so
 * `CircuitView` can test it per sample while building geometry without searching
 * the corner list for every one of 2,344 samples.
 */
export function cornerWarningMask(track: Track, corners: readonly Corner[]): Int8Array {
  const count = track.samples.length;
  const mask = new Int8Array(count);
  for (const corner of corners) {
    let index = corner.boardIndex;
    // Walk forward from the board to the exit; the span can wrap.
    for (let guard = 0; guard < count; guard += 1) {
      mask[index] = corner.direction;
      if (index === corner.exitIndex) break;
      index = wrapIndex(index + 1, count);
    }
  }
  return mask;
}
