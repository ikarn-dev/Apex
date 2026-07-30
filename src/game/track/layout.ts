/**
 * The circuit: APEX International.
 *
 * The map used to be a supplied Suzuka GLB, with its centreline extracted offline
 * by a build script and committed as JSON. That asset is gone, and with it the
 * only thing the route could be derived from. This module replaces both: the
 * circuit is authored here as a ring of control points and turned into route
 * samples at load, so there is no map asset to download and no generated file to
 * keep in sync with one.
 *
 * ## What the layout is
 *
 * A permanent day circuit with a deliberate mix of corner types, because the
 * campaign leans on all of them: a long pit straight to make slipstreaming
 * matter, a fast double-right onto the back section, a set of esses that punish
 * a car that will not change direction, a genuine hairpin for the drift act, and
 * a long banked left onto the straight. Elevation runs about 30m peak to trough.
 *
 * ## Two properties worth protecting
 *
 * **It closes exactly.** A centripetal Catmull-Rom through a closed ring cannot
 * leave a seam, which matters because lap counting derives from arc length and a
 * discontinuity at the join would read as a teleport.
 *
 * **It is exactly `TARGET_LENGTH` long.** The shape is measured and then scaled
 * to hit that number. Every level's `parMs` and `floorMs` is calibrated against
 * lap distance, so pinning the length means the circuit can be reshaped without
 * silently invalidating the campaign's timing or the on-chain floor checks.
 *
 * Pure arithmetic, no randomness, no DOM: the headless simulation harness imports
 * this module too, and it has to produce identical samples there.
 */

/** Lap distance, metres. Levels are calibrated against this figure. */
const TARGET_LENGTH = 5_860;

/** Nominal spacing between emitted route samples, metres. */
const TARGET_SPACING = 2.5;

/** Catmull-Rom knot parameterisation. 0.5 is centripetal: no cusps, no overshoot. */
const ALPHA = 0.5;

/** Dense evaluations per control-point span, used for arc-length measurement. */
const SUBDIVISIONS = 96;

/** Road half-width bounds, metres. */
const MIN_HALF_WIDTH = 4.6;
const MAX_HALF_WIDTH = 7.6;
/** How sharply the road narrows as curvature rises. */
const WIDTH_CURVATURE_GAIN = 170;

/** Crossfall applied per unit of curvature, and its ceiling in radians. */
const BANK_GAIN = 5.2;
const MAX_BANK = 0.085;

/**
 * Control ring, listed in the driving direction and closing back on the first.
 *
 * `[x, y, z]` in metres before length normalisation. The first point is the
 * start/finish line, so `Track` sample 0 — and therefore the grid, the first
 * checkpoint and the timing line — all land on the pit straight.
 */
const CONTROL_POINTS: readonly (readonly [number, number, number])[] = [
  // Pit straight, running +x.
  [-300, 0, -450],
  [-120, 0.5, -455],
  [60, 1.5, -458],
  [220, 2.5, -455],
  // Turn 1-2: hard right, then a fast sweep onto the eastern run.
  [330, 4, -440],
  [430, 6, -395],
  [500, 8.5, -320],
  [525, 11, -240],
  // Fast right kink, dropping downhill.
  [505, 12.5, -165],
  [450, 13, -105],
  // Esses.
  [395, 12, -55],
  [405, 10, 10],
  [455, 8, 65],
  [520, 6.5, 110],
  // Hairpin.
  [575, 5, 165],
  [597, 4, 226],
  [553, 3.5, 276],
  [480, 3, 300],
  // Back straight, running -x.
  [380, 2.5, 315],
  [240, 2, 325],
  [100, 1, 330],
  [-40, 0, 330],
  // Northern sweeper, climbing.
  [-170, -1.5, 322],
  [-290, -3, 300],
  [-390, -4.5, 255],
  [-460, -5, 190],
  // Chicane.
  [-490, -4, 115],
  [-452, -3, 55],
  [-497, -2, -10],
  // Long banked left back onto the straight.
  [-545, -1, -80],
  [-560, 0, -160],
  [-540, 0.5, -240],
  [-490, 0.5, -320],
  [-420, 0.25, -390],
  [-360, 0, -430],
];

export type RouteSample = readonly [
  x: number,
  y: number,
  z: number,
  halfWidth: number,
  banking: number,
];

export interface Route {
  sampleSpacing: number;
  length: number;
  samples: RouteSample[];
}

interface Point {
  x: number;
  y: number;
  z: number;
}

function horizontalDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/**
 * Non-uniform Catmull-Rom via Barry-Goldman, evaluated on one span.
 *
 * Knot spacing comes from the chord lengths raised to `ALPHA`, which is what
 * makes it centripetal and keeps the curve from looping back on itself where the
 * control points bunch up — the hairpin, in practice.
 */
function splinePoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t0 = 0;
  const t1 = t0 + Math.pow(horizontalDistance(p0, p1), ALPHA);
  const t2 = t1 + Math.pow(horizontalDistance(p1, p2), ALPHA);
  const t3 = t2 + Math.pow(horizontalDistance(p2, p3), ALPHA);

  // Degenerate spacing would divide by zero; a straight chord is the right
  // answer in that case anyway.
  if (t1 <= t0 || t2 <= t1 || t3 <= t2) return lerpPoint(p1, p2, t);

  const s = t1 + t * (t2 - t1);
  const a1 = lerpPoint(p0, p1, (s - t0) / (t1 - t0));
  const a2 = lerpPoint(p1, p2, (s - t1) / (t2 - t1));
  const a3 = lerpPoint(p2, p3, (s - t2) / (t3 - t2));
  const b1 = lerpPoint(a1, a2, (s - t0) / (t2 - t0));
  const b2 = lerpPoint(a2, a3, (s - t1) / (t3 - t1));
  return lerpPoint(b1, b2, (s - t1) / (t2 - t1));
}

/** Dense polyline around the closed ring. */
function densePolyline(points: readonly Point[]): Point[] {
  const n = points.length;
  const dense: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    const p0 = points[(i - 1 + n) % n]!;
    const p1 = points[i]!;
    const p2 = points[(i + 1) % n]!;
    const p3 = points[(i + 2) % n]!;
    for (let step = 0; step < SUBDIVISIONS; step += 1) {
      dense.push(splinePoint(p0, p1, p2, p3, step / SUBDIVISIONS));
    }
  }
  return dense;
}

function polylineLength(dense: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i < dense.length; i += 1) {
    total += horizontalDistance(dense[i]!, dense[(i + 1) % dense.length]!);
  }
  return total;
}

/**
 * Emit `count` points at uniform arc length around the closed dense polyline.
 *
 * Driven by a cumulative-distance table rather than by walking and carrying a
 * remainder. The walking version is easy to get subtly wrong — mine drifted, and
 * the symptom was not a wrong sample position but a 1.6km gap between the last
 * sample and the first, i.e. a lap that did not close.
 */
function resample(dense: readonly Point[], count: number, spacing: number): Point[] {
  const n = dense.length;
  const cumulative = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    cumulative[i + 1] = cumulative[i]! + horizontalDistance(dense[i]!, dense[(i + 1) % n]!);
  }
  const total = cumulative[n]!;

  const samples: Point[] = [];
  let index = 0;
  for (let i = 0; i < count; i += 1) {
    const target = Math.min(i * spacing, total);
    while (index < n - 1 && cumulative[index + 1]! < target) index += 1;
    const start = cumulative[index]!;
    const segment = cumulative[index + 1]! - start;
    const t = segment > 1e-9 ? (target - start) / segment : 0;
    samples.push(lerpPoint(dense[index]!, dense[(index + 1) % n]!, t));
  }
  return samples;
}

/** Smooth a closed series in place-free fashion. */
function smoothClosed(values: readonly number[], passes: number): number[] {
  const n = values.length;
  let current = [...values];
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      const a = current[(i - 1 + n) % n]!;
      const b = current[i]!;
      const c = current[(i + 1) % n]!;
      next[i] = (a + 2 * b + c) / 4;
    }
    current = next;
  }
  return current;
}

function wrapAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

let cached: Route | null = null;

/**
 * Build the route. Cached, because `Track` and the offline harness both call it
 * and the result is a pure function of the constants above.
 */
export function buildRoute(): Route {
  if (cached) return cached;

  const authored: Point[] = CONTROL_POINTS.map(([x, y, z]) => ({ x, y, z }));

  // Measure the authored shape, then scale it to the calibrated lap distance.
  // Scaling elevation with it keeps every gradient exactly as authored.
  const rawLength = polylineLength(densePolyline(authored));
  const scale = TARGET_LENGTH / rawLength;
  const scaled = authored.map((point) => ({
    x: point.x * scale,
    y: point.y * scale,
    z: point.z * scale,
  }));

  const dense = densePolyline(scaled);
  const length = polylineLength(dense);
  const count = Math.round(length / TARGET_SPACING);
  const spacing = length / count;
  const points = resample(dense, count, spacing);

  // Curvature from a wide heading baseline, then smoothed: the AI brakes on this
  // number, so resampling noise must not reach it.
  const window = 3;
  const headings = points.map((point, i) => {
    const previous = points[(i - window + count) % count]!;
    const next = points[(i + window) % count]!;
    return Math.atan2(next.x - previous.x, next.z - previous.z);
  });
  const rawCurvature = points.map((_, i) => {
    const previous = headings[(i - window + count) % count]!;
    const next = headings[(i + window) % count]!;
    return wrapAngle(next - previous) / (2 * window * spacing);
  });
  const curvature = smoothClosed(rawCurvature, 6);

  const samples: RouteSample[] = points.map((point, i) => {
    const k = curvature[i]!;
    const halfWidth = clamp(
      MAX_HALF_WIDTH - Math.abs(k) * WIDTH_CURVATURE_GAIN,
      MIN_HALF_WIDTH,
      MAX_HALF_WIDTH,
    );
    // Banked into the corner: the outside of a right-hander (positive curvature)
    // is the left edge, so the right edge is the low one and the crossfall is
    // negative. `VehicleSim` reads the same convention.
    const banking = clamp(-k * BANK_GAIN, -MAX_BANK, MAX_BANK);
    return [point.x, point.y, point.z, halfWidth, banking];
  });

  cached = { sampleSpacing: spacing, length, samples };
  return cached;
}
