/**
 * Scalar math used by the deterministic simulation.
 *
 * Every function here must be pure and allocation-free: they run tens of
 * thousands of times per second inside the fixed-step loop.
 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing. `speed` is per second. */
export function damp(current: number, target: number, speed: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-speed * dt));
}

/** Map `value` from one range to another, clamped to the output range. */
export function remap(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMax === inMin) return outMin;
  const t = clamp01((value - inMin) / (inMax - inMin));
  return outMin + (outMax - outMin) * t;
}

/** Smooth Hermite interpolation between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Wrap an angle to `(-PI, PI]`. Essential for steering error terms. */
export function wrapAngle(radians: number): number {
  let a = radians;
  while (a > Math.PI) a -= TAU;
  while (a <= -Math.PI) a += TAU;
  return a;
}

/** Shortest signed angular difference from `a` to `b`. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Kill tiny values so idle cars settle to exactly zero. */
export function deadzone(value: number, threshold: number): number {
  return Math.abs(value) < threshold ? 0 : value;
}

/** `sign` that returns 0 for 0 and never -0. */
export function sign0(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** Squared 2D distance — avoids a sqrt in hot comparisons. */
export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Catmull-Rom interpolation of four control values at `t` in [0,1]. */
export function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}
