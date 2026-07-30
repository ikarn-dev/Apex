/**
 * Deterministic circuit queries.
 *
 * The geometry comes from `./layout`, which builds the closed centreline of APEX
 * International from authored control points and normalises it to the calibrated
 * lap distance. This class is the only thing the simulation asks about the road:
 * where the surface is, how wide it is, which way it is banked, where the racing
 * line runs and where the checkpoints sit.
 */

import type { Vector3 } from "three";
import { buildRoute } from "./layout";
import { clamp, lerp, wrapAngle } from "@/lib/math";

const routeData = buildRoute();

/** Gates per lap. Also the granularity of rollup checkpoint writes. */
export const CHECKPOINTS_PER_LAP = 12;

export interface TrackSample {
  /** Arc length from the start line, metres. */
  distance: number;
  x: number;
  y: number;
  z: number;
  /** Unit forward vector in the XZ plane. */
  fx: number;
  fz: number;
  /** Unit right vector in the XZ plane (forward rotated -90°). */
  rx: number;
  rz: number;
  /** Heading angle, radians, matching the vehicle's `yaw` convention. */
  heading: number;
  /** Signed curvature, 1/m. Positive turns right. */
  curvature: number;
  /** Measured road half-width at this point, metres. */
  halfWidth: number;
  /** Banking angle measured across the supplied road mesh, radians. */
  banking: number;
  /** Lateral offset of the racing line from the authored centre row, metres. */
  racingLine: number;
  /** Grade, metres of rise per metre travelled. */
  slope: number;
}

export interface TrackProjection {
  /** Nearest sample index. */
  index: number;
  /** Arc length at that sample. */
  distance: number;
  /** Signed lateral offset; positive is right of the centreline. */
  lateral: number;
  /** Road height under the car. */
  height: number;
  /** Centreline heading at that point. */
  heading: number;
  /** Fraction around the lap, 0-1. */
  progress: number;
}

/** Tangents use a 15m baseline so resampling noise cannot steer the AI. */
const TANGENT_WINDOW = 3;

export class Track {
  readonly samples: TrackSample[] = [];
  readonly length: number;
  readonly sampleSpacing: number;
  /** Radius used to size fog, sky, and the distant ground plane. */
  readonly boundsRadius: number;
  /** Sample indices of the checkpoint gates, `[0]` being the start line. */
  readonly checkpointIndices: number[] = [];
  readonly checkpointDistances: number[] = [];

  constructor() {
    this.sampleSpacing = routeData.sampleSpacing;
    this.length = routeData.length;

    const points = routeData.samples;
    const n = points.length;
    if (n < 64 || this.sampleSpacing <= 0 || this.length <= 0) {
      throw new Error("Circuit layout produced an invalid route");
    }

    let maxRadius = 0;
    for (let i = 0; i < n; i += 1) {
      const point = points[i]!;
      const previous = points[(i - TANGENT_WINDOW + n) % n]!;
      const next = points[(i + TANGENT_WINDOW) % n]!;

      let fx = next[0] - previous[0];
      let fz = next[2] - previous[2];
      const horizontal = Math.hypot(fx, fz) || 1;
      fx /= horizontal;
      fz /= horizontal;

      maxRadius = Math.max(maxRadius, Math.hypot(point[0], point[2]));
      this.samples.push({
        distance: i * this.sampleSpacing,
        x: point[0],
        y: point[1],
        z: point[2],
        fx,
        fz,
        rx: fz,
        rz: -fx,
        heading: Math.atan2(fx, fz),
        curvature: 0,
        halfWidth: point[3],
        banking: point[4],
        racingLine: 0,
        slope: (next[1] - previous[1]) / horizontal,
      });
    }

    this.boundsRadius = maxRadius;
    this.computeCurvature();
    this.computeRacingLine();
    this.placeCheckpoints();
  }

  private computeCurvature(): void {
    const n = this.samples.length;
    const window = 2;
    const raw = new Array<number>(n);

    for (let i = 0; i < n; i += 1) {
      const previous = this.samples[(i - window + n) % n]!;
      const next = this.samples[(i + window) % n]!;
      raw[i] =
        wrapAngle(next.heading - previous.heading) /
        (2 * window * this.sampleSpacing);
    }

    // Source vertices follow the road closely enough to preserve tiny tessellation
    // changes. Smooth those away before curvature drives steering and braking.
    let current = raw;
    for (let pass = 0; pass < 4; pass += 1) {
      const smoothed = new Array<number>(n);
      for (let i = 0; i < n; i += 1) {
        const a = current[(i - 1 + n) % n]!;
        const b = current[i]!;
        const c = current[(i + 1) % n]!;
        smoothed[i] = (a + 2 * b + c) / 4;
      }
      current = smoothed;
    }

    for (let i = 0; i < n; i += 1) this.samples[i]!.curvature = current[i]!;
  }

  /**
   * Bias AI toward the inside of bends while staying inside measured edges.
   * This is a driving line derived from route curvature, not visible geometry.
   */
  private computeRacingLine(): void {
    const n = this.samples.length;
    let current = this.samples.map((sample) => {
      const strength = clamp(sample.curvature * 220, -1, 1);
      return strength * sample.halfWidth * 0.48;
    });

    for (let pass = 0; pass < 24; pass += 1) {
      const next = new Array<number>(n);
      for (let i = 0; i < n; i += 1) {
        const a = current[(i - 1 + n) % n]!;
        const b = current[i]!;
        const c = current[(i + 1) % n]!;
        next[i] = (a + 2 * b + c) / 4;
      }
      current = next;
    }

    for (let i = 0; i < n; i += 1) this.samples[i]!.racingLine = current[i]!;
  }

  private placeCheckpoints(): void {
    const n = this.samples.length;
    for (let i = 0; i < CHECKPOINTS_PER_LAP; i += 1) {
      const index = Math.round((i / CHECKPOINTS_PER_LAP) * n) % n;
      this.checkpointIndices.push(index);
      this.checkpointDistances.push(this.samples[index]!.distance);
    }
  }

  sampleAt(index: number): TrackSample {
    const n = this.samples.length;
    return this.samples[((index % n) + n) % n]!;
  }

  /** Sample by arc length, interpolating between the two nearest samples. */
  sampleAtDistance(distance: number): TrackSample {
    const n = this.samples.length;
    const wrapped = ((distance % this.length) + this.length) % this.length;
    const exact = wrapped / this.sampleSpacing;
    const i0 = Math.floor(exact) % n;
    const i1 = (i0 + 1) % n;
    const t = exact - Math.floor(exact);
    const a = this.samples[i0]!;
    const b = this.samples[i1]!;
    return {
      distance: wrapped,
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      fx: lerp(a.fx, b.fx, t),
      fz: lerp(a.fz, b.fz, t),
      rx: lerp(a.rx, b.rx, t),
      rz: lerp(a.rz, b.rz, t),
      heading: a.heading + wrapAngle(b.heading - a.heading) * t,
      curvature: lerp(a.curvature, b.curvature, t),
      halfWidth: lerp(a.halfWidth, b.halfWidth, t),
      banking: lerp(a.banking, b.banking, t),
      racingLine: lerp(a.racingLine, b.racingLine, t),
      slope: lerp(a.slope, b.slope, t),
    };
  }

  /**
   * Locate a world position on the circuit.
   *
   * Suzuka crosses over itself. The local search window is therefore also a
   * correctness constraint: once a car is on one branch, an XZ-near overpass
   * cannot make progress jump to the other branch.
   */
  project(x: number, z: number, hintIndex = -1, window = 24): TrackProjection {
    const n = this.samples.length;
    let bestIndex = 0;
    let bestDist2 = Infinity;

    if (hintIndex >= 0) {
      for (let offset = -window; offset <= window; offset += 1) {
        const i = ((hintIndex + offset) % n + n) % n;
        const sample = this.samples[i]!;
        const dx = x - sample.x;
        const dz = z - sample.z;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq < bestDist2) {
          bestDist2 = distanceSq;
          bestIndex = i;
        }
      }
    } else {
      for (let i = 0; i < n; i += 1) {
        const sample = this.samples[i]!;
        const dx = x - sample.x;
        const dz = z - sample.z;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq < bestDist2) {
          bestDist2 = distanceSq;
          bestIndex = i;
        }
      }
    }

    const sample = this.samples[bestIndex]!;
    const dx = x - sample.x;
    const dz = z - sample.z;
    const along = dx * sample.fx + dz * sample.fz;
    const lateral = dx * sample.rx + dz * sample.rz;
    const distance =
      (((sample.distance + along) % this.length) + this.length) % this.length;

    return {
      index: bestIndex,
      distance,
      lateral,
      height: sample.y + sample.slope * along,
      heading: sample.heading,
      progress: distance / this.length,
    };
  }

  /** World position for a given arc length and lateral offset. */
  positionAt(distance: number, lateral: number, out: Vector3): Vector3 {
    const sample = this.sampleAtDistance(distance);
    out.set(
      sample.x + sample.rx * lateral,
      sample.y,
      sample.z + sample.rz * lateral,
    );
    return out;
  }

  /** Which checkpoint index a given arc length has most recently passed. */
  checkpointFor(distance: number): number {
    const spacing = this.length / CHECKPOINTS_PER_LAP;
    return Math.min(
      CHECKPOINTS_PER_LAP - 1,
      Math.floor(distance / spacing),
    );
  }

  /** Starting grid slot: staggered back from the line, alternating sides. */
  gridSlot(position: number): { distance: number; lateral: number } {
    const row = Math.floor(position / 2);
    const side = position % 2 === 0 ? -1 : 1;
    const start = this.samples[0]!;
    return {
      distance: this.length - 12 - row * 9,
      lateral: side * Math.min(1.4, start.halfWidth * 0.42),
    };
  }
}
