/**
 * The visible circuit, generated from the route.
 *
 * There is no map GLB any more. Every surface here is built from the same
 * `Track` samples the physics reads, which is the point: the kerb you clip, the
 * barrier you hit and the line you cross are the same numbers the simulation and
 * the rollup are scored against. A supplied mesh can drift out of agreement with
 * its extracted route; generated geometry cannot.
 *
 * ## Cost
 *
 * All of it is untextured, vertex-coloured, flat-shaded geometry, so the whole
 * 5.86km lap renders from one material. It is split into ~240m chunks purely so
 * frustum culling has something to work with — at any moment about four chunks
 * are visible out of twenty-five.
 *
 * ## Smoothness
 *
 * Two things matter for a road that does not shimmer or crawl. Faces get their own
 * vertices so `computeVertexNormals` leaves panel edges hard instead of averaging
 * a kerb into the asphalt. And painted markings are separate quads lifted 4cm off
 * the surface rather than coplanar geometry, because coplanar paint z-fights at
 * every distance the chase camera actually uses.
 */

import { Color, Group, Mesh, MeshLambertMaterial, Vector3, type BufferGeometry } from "three";
import type { CityPalette, LevelEnvironment } from "../config/levels";
import type { QualitySettings } from "../config/quality";
import { MeshBuilder } from "../world/MeshBuilder";
import { CHECKPOINTS_PER_LAP, type Track, type TrackSample } from "./Track";

/** Route samples per merged chunk. ~240m. */
const CHUNK = 96;

/** Kerb strip inboard of the road edge. */
const KERB_WIDTH = 0.85;
const KERB_RISE = 0.06;
/** Route samples per kerb stripe. */
const KERB_STRIPE = 2;
/** Kerbs only appear where the road is actually turning, as on a real circuit. */
const KERB_CURVATURE = 0.0016;

/** Concrete barrier. Its inner face sits on the collision limit. */
const BARRIER_HEIGHT = 1.0;
const BARRIER_THICKNESS = 0.42;

/** How far the ground plane sits below the lowest point of the circuit. */
const GROUND_CLEARANCE = 2.5;

/** Sealed run-off, then a bank down to the surrounding ground. */
const RUNOFF_MIN_REACH = 26;
const RUNOFF_REACH_PER_METRE = 3.2;
const RUNOFF_PROFILE = [0, 0.09, 0.26, 0.56, 1] as const;
const RUNOFF_SEALED = 2;
/** The bank is coarser than the barrier; the barrier hides the chord error. */
const RUNOFF_STRIDE = 2;

/** Painted road markings. */
const EDGE_LINE_WIDTH = 0.14;
const TIMING_LINE_DEPTH = 0.34;
const CHEQUER_CELLS = 12;
const CHEQUER_DEPTH = 1.5;
const PAINT_RISE = 0.04;

/** Route samples between lighting columns, alternating sides. ~47m. */
const LIGHT_SPACING = 19;
const LIGHT_HEIGHT = 9.2;

const GANTRY_HEIGHT = 7.2;
const GANTRY_POST = 0.42;

/** Roadside trees, placed off the outer edge of the run-off. */
const TREE_SPACING = 11;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Deterministic 32-bit hash. No `Math.random`: the scene must be reproducible. */
function hash(a: number, b: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface BarrierRing {
  faceBottom: number;
  faceTop: number;
  capInner: number;
  capOuter: number;
}

export class CircuitView {
  readonly group = new Group();
  /** Height of the ground plane the circuit's run-off banks down to. */
  readonly groundHeight: number;

  private readonly colors: Record<keyof CityPalette, Color>;
  private readonly geometries: BufferGeometry[] = [];
  private readonly material: MeshLambertMaterial;
  private disposed = false;

  constructor(
    private readonly track: Track,
    env: LevelEnvironment,
    private readonly quality: QualitySettings,
  ) {
    this.group.name = "circuit";
    this.colors = Object.fromEntries(
      Object.entries(env.city).map(([key, hex]) => [key, new Color(hex)]),
    ) as Record<keyof CityPalette, Color>;

    // Below the lowest point on the circuit, never the mean.
    //
    // The mean is the obvious choice and it is wrong: this layout climbs and
    // drops 30m, so a ground plane at mean elevation buried 1,232 of 2,344 route
    // samples — over half the lap ran through a trench with the grass drawn over
    // the top of it, and the car with it. The plane has to clear the whole
    // circuit; the run-off bank below handles the height difference.
    let lowest = Infinity;
    for (const sample of track.samples) lowest = Math.min(lowest, sample.y);
    this.groundHeight = lowest - GROUND_CLEARANCE;

    // Lambert, not Standard: nothing here is metallic and there is no
    // environment probe in the budget, so a Standard material would pay for a
    // PBR shader it cannot use.
    this.material = new MeshLambertMaterial({ vertexColors: true, name: "circuit" });

    this.build();
  }

  private build(): void {
    const n = this.track.samples.length;

    for (let start = 0; start < n; start += CHUNK) {
      const end = Math.min(start + CHUNK, n);
      const builder = new MeshBuilder();

      this.addRoad(builder, start, end);
      for (const side of [-1, 1] as const) {
        this.addKerb(builder, start, end, side);
        this.addEdgeLine(builder, start, end, side);
        this.addBarrier(builder, start, end, side);
        this.addRunoff(builder, start, end, side);
        this.addTrees(builder, start, end, side);
      }
      this.addLightingColumns(builder, start, end);
      this.addMarkings(builder, start, end);

      if (builder.empty) continue;
      const geometry = builder.build(`circuit-${start / CHUNK}`);
      this.geometries.push(geometry);
      const mesh = new Mesh(geometry, this.material);
      // Barriers, gantries and the tree line are what make the shadow pass worth
      // running; the road itself only receives.
      mesh.castShadow = this.quality.shadowMapSize > 0;
      mesh.receiveShadow = this.quality.shadowMapSize > 0;
      this.group.add(mesh);
    }
  }

  /**
   * A point on the road plane at a lateral offset.
   *
   * `banking` is the layout's crossfall, positive when the right edge is higher.
   * Everything trackside is placed through this helper, so kerbs, barriers and
   * paint all sit on the banked surface rather than hovering over its low side.
   */
  private surfacePoint(
    sample: TrackSample,
    side: number,
    lateral: number,
    rise: number,
  ): Vector3 {
    const offset = side * lateral;
    return new Vector3(
      sample.x + sample.rx * offset,
      sample.y + offset * Math.tan(sample.banking) + rise,
      sample.z + sample.rz * offset,
    );
  }

  /** The asphalt itself: one quad strip across the measured width. */
  private addRoad(builder: MeshBuilder, start: number, end: number): void {
    const n = this.track.samples.length;
    const asphalt = this.colors.asphalt;
    let previous: [number, number] | null = null;

    for (let i = start; i <= end; i += 1) {
      const sample = this.track.samples[i % n]!;
      const left = this.surfacePoint(sample, -1, sample.halfWidth, 0);
      const right = this.surfacePoint(sample, 1, sample.halfWidth, 0);
      const ring: [number, number] = [
        builder.vertex(left.x, left.y, left.z, asphalt),
        builder.vertex(right.x, right.y, right.z, asphalt),
      ];
      // Wound left → forward → right so the face points up. The other order is
      // the intuitive one and it is wrong: `cross(right, forward)` is -Y, which
      // culls the entire road and leaves the ground plane showing through it.
      if (previous) builder.quad(previous[0], ring[0], ring[1], previous[1]);
      previous = ring;
    }
  }

  /**
   * Red-and-white kerbing, on corners only.
   *
   * Each stripe is an independent quad. Sharing vertices along the strip would
   * interpolate red into white and produce a smear where a kerb should be.
   */
  private addKerb(builder: MeshBuilder, start: number, end: number, side: number): void {
    const n = this.track.samples.length;
    for (let i = start; i < end; i += 1) {
      const a = this.track.samples[i % n]!;
      const b = this.track.samples[(i + 1) % n]!;
      // Kerb the inside and outside of a bend, but leave the straights bare.
      if (Math.abs(a.curvature) < KERB_CURVATURE) continue;

      const color =
        Math.floor(i / KERB_STRIPE) % 2 === 0 ? this.colors.kerbLight : this.colors.kerbDark;
      const p0 = this.surfacePoint(a, side, a.halfWidth - KERB_WIDTH, KERB_RISE * 0.4);
      const p1 = this.surfacePoint(a, side, a.halfWidth, KERB_RISE);
      const p2 = this.surfacePoint(b, side, b.halfWidth, KERB_RISE);
      const p3 = this.surfacePoint(b, side, b.halfWidth - KERB_WIDTH, KERB_RISE * 0.4);

      // Outboard is +right on the right-hand kerb and -right on the left, so the
      // winding flips for the face to point up on both sides.
      const order = side > 0 ? [p0, p3, p2, p1] : [p0, p1, p2, p3];
      builder.quad(
        builder.vertex(order[0]!.x, order[0]!.y, order[0]!.z, color),
        builder.vertex(order[1]!.x, order[1]!.y, order[1]!.z, color),
        builder.vertex(order[2]!.x, order[2]!.y, order[2]!.z, color),
        builder.vertex(order[3]!.x, order[3]!.y, order[3]!.z, color),
      );
    }
  }

  /** Continuous white line just inboard of the road edge. */
  private addEdgeLine(builder: MeshBuilder, start: number, end: number, side: number): void {
    const n = this.track.samples.length;
    const line = this.colors.line;
    let previous: [number, number] | null = null;

    for (let i = start; i <= end; i += 1) {
      const sample = this.track.samples[i % n]!;
      const outer = sample.halfWidth - KERB_WIDTH - 0.05;
      const inner = outer - EDGE_LINE_WIDTH;
      const a = this.surfacePoint(sample, side, inner, PAINT_RISE);
      const b = this.surfacePoint(sample, side, outer, PAINT_RISE);
      const ring: [number, number] = [
        builder.vertex(a.x, a.y, a.z, line),
        builder.vertex(b.x, b.y, b.z, line),
      ];
      if (previous) {
        // Outboard is +right on the right-hand line and -right on the left, so
        // the winding flips to keep both faces pointing up.
        if (side > 0) builder.quad(previous[0], ring[0], ring[1], previous[1]);
        else builder.quad(previous[0], previous[1], ring[1], ring[0]);
      }
      previous = ring;
    }
  }

  /**
   * Concrete barrier, inner face on the collision limit.
   *
   * The outward-facing panel is deliberately not emitted: it is only visible from
   * outside the circuit, where the camera cannot go, and skipping it removes a
   * third of the barrier's triangles across the whole lap.
   */
  private addBarrier(builder: MeshBuilder, start: number, end: number, side: number): void {
    const n = this.track.samples.length;
    let previous: BarrierRing | null = null;

    for (let i = start; i <= end; i += 1) {
      const sample = this.track.samples[i % n]!;
      const ring = this.addBarrierRing(builder, sample, side);
      if (previous) {
        if (side > 0) {
          builder.quad(previous.faceBottom, ring.faceBottom, ring.faceTop, previous.faceTop);
          builder.quad(previous.capInner, ring.capInner, ring.capOuter, previous.capOuter);
        } else {
          builder.quad(ring.faceBottom, previous.faceBottom, previous.faceTop, ring.faceTop);
          builder.quad(ring.capInner, previous.capInner, previous.capOuter, ring.capOuter);
        }
      }
      previous = ring;
    }
  }

  private addBarrierRing(
    builder: MeshBuilder,
    sample: TrackSample,
    side: number,
  ): BarrierRing {
    const concrete = this.colors.barrier;
    const cap = this.colors.barrierTop;
    const inner = sample.halfWidth;
    const outer = inner + BARRIER_THICKNESS;

    const base = this.surfacePoint(sample, side, inner, -0.02);
    const top = this.surfacePoint(sample, side, inner, BARRIER_HEIGHT);
    const back = this.surfacePoint(sample, side, outer, BARRIER_HEIGHT);

    return {
      faceBottom: builder.vertex(base.x, base.y, base.z, concrete),
      faceTop: builder.vertex(top.x, top.y, top.z, concrete),
      capInner: builder.vertex(top.x, top.y, top.z, cap),
      capOuter: builder.vertex(back.x, back.y, back.z, cap),
    };
  }

  /**
   * Run-off and the bank down to the ground plane.
   *
   * The circuit climbs and drops 30m, so a flat ground plane cannot meet the road
   * everywhere. The bank's reach grows with the height it has to cover, which
   * holds its gradient roughly constant and closes the gap at every point.
   */
  private addRunoff(builder: MeshBuilder, start: number, end: number, side: number): void {
    const n = this.track.samples.length;
    const stations = RUNOFF_PROFILE.length;
    let previous: number[] | null = null;

    for (let i = start; i <= end; i += RUNOFF_STRIDE) {
      const sample = this.track.samples[i % n]!;
      const inner = sample.halfWidth + BARRIER_THICKNESS;
      const baseY = sample.y + side * inner * Math.tan(sample.banking);
      const reach = this.runoffReach(baseY);

      const row: number[] = [];
      for (let s = 0; s < stations; s += 1) {
        const t = RUNOFF_PROFILE[s]!;
        const lateral = inner + reach * t;
        const y = baseY + (this.groundHeight - baseY) * smoothstep(t);
        const color =
          s < RUNOFF_SEALED
            ? this.colors.plaza
            : this.colors.plaza
                .clone()
                .lerp(this.colors.verge, (s - RUNOFF_SEALED + 1) / (stations - 1));
        const offset = side * lateral;
        row.push(
          builder.vertex(
            sample.x + sample.rx * offset,
            y,
            sample.z + sample.rz * offset,
            color,
          ),
        );
      }

      if (previous) {
        for (let s = 0; s < stations - 1; s += 1) {
          const a = previous[s]!;
          const b = previous[s + 1]!;
          const c = row[s + 1]!;
          const d = row[s]!;
          if (side > 0) builder.quad(a, d, c, b);
          else builder.quad(a, b, c, d);
        }
      }
      previous = row;
    }
  }

  private runoffReach(baseY: number): number {
    return RUNOFF_MIN_REACH + Math.abs(baseY - this.groundHeight) * RUNOFF_REACH_PER_METRE;
  }

  /** Floodlight columns: a mast outside the barrier with a boxy LED head. */
  private addLightingColumns(builder: MeshBuilder, start: number, end: number): void {
    const n = this.track.samples.length;
    const steel = this.colors.steel;
    const first = Math.ceil(start / LIGHT_SPACING) * LIGHT_SPACING;

    for (let i = first; i < end; i += LIGHT_SPACING) {
      const sample = this.track.samples[i % n]!;
      // Alternating sides keeps the columns from reading as a fence.
      const side = (i / LIGHT_SPACING) % 2 === 0 ? 1 : -1;
      const lateral = sample.halfWidth + BARRIER_THICKNESS + 1.8;
      const boom = 1.5;
      const foot = this.surfacePoint(sample, side, lateral, -0.4);

      builder.box(foot.x - 0.17, foot.y, foot.z - 0.17, 0.34, LIGHT_HEIGHT, 0.34, steel);

      const arm = this.surfacePoint(sample, side, lateral - boom / 2, LIGHT_HEIGHT - 0.28);
      orientedBox(builder, arm, sample, boom / 2, 0.1, 0.1, steel);
      const head = this.surfacePoint(sample, side, lateral - boom, LIGHT_HEIGHT - 0.42);
      orientedBox(builder, head, sample, 0.42, 0.16, 0.3, steel);
    }
  }

  /** Tree line beyond the run-off, for depth cues at speed. */
  private addTrees(builder: MeshBuilder, start: number, end: number, side: number): void {
    const n = this.track.samples.length;
    const trunk = this.colors.trunk;
    const canopy = this.colors.canopy;
    const first = Math.ceil(start / TREE_SPACING) * TREE_SPACING;

    for (let i = first; i < end; i += TREE_SPACING) {
      const sample = this.track.samples[i % n]!;
      const seed = hash(i, side);
      // Roughly a third of the slots stay empty so the line does not read as a
      // hedge, and the rest scatter in depth.
      if (seed < 0.34) continue;

      const inner = sample.halfWidth + BARRIER_THICKNESS;
      const reach = this.runoffReach(sample.y);
      const lateral = inner + reach * (1.04 + seed * 0.5);
      const base = this.surfacePoint(sample, side, lateral, 0);
      const ground = this.groundHeight;
      const height = 5.5 + seed * 4.5;
      const spread = 1.9 + seed * 1.1;

      builder.box(base.x - 0.22, ground - 1, base.z - 0.22, 0.44, height * 0.42, 0.44, trunk);
      builder.box(
        base.x - spread / 2,
        ground + height * 0.34,
        base.z - spread / 2,
        spread,
        height * 0.66,
        spread,
        canopy,
      );
    }
  }

  /** Timing lines, the start/finish chequer, and a gantry over each gate. */
  private addMarkings(builder: MeshBuilder, start: number, end: number): void {
    const n = this.track.samples.length;
    for (let gate = 0; gate < CHECKPOINTS_PER_LAP; gate += 1) {
      const index = this.track.checkpointIndices[gate]!;
      if (index < start || index >= end) continue;
      const sample = this.track.samples[index % n]!;

      if (gate === 0) this.addStartLine(builder, sample);
      else this.addTimingLine(builder, sample);
      this.addGantry(builder, sample, gate === 0);
    }
  }

  private addTimingLine(builder: MeshBuilder, sample: TrackSample): void {
    const w = sample.halfWidth - 0.1;
    this.addRoadQuad(builder, sample, -w, w, -TIMING_LINE_DEPTH, TIMING_LINE_DEPTH, this.colors.line);
  }

  private addStartLine(builder: MeshBuilder, sample: TrackSample): void {
    const w = sample.halfWidth - 0.1;
    const step = (w * 2) / CHEQUER_CELLS;
    for (let cell = 0; cell < CHEQUER_CELLS; cell += 1) {
      for (let row = 0; row < 2; row += 1) {
        // Offset rows, so it reads as a chequer rather than a comb.
        if ((cell + row) % 2 !== 0) continue;
        const from = -w + cell * step;
        const near = -CHEQUER_DEPTH + row * CHEQUER_DEPTH;
        this.addRoadQuad(
          builder,
          sample,
          from,
          from + step,
          near,
          near + CHEQUER_DEPTH,
          this.colors.line,
        );
      }
    }
  }

  /** A quad on the road surface, in centreline-relative coordinates. */
  private addRoadQuad(
    builder: MeshBuilder,
    sample: TrackSample,
    fromLateral: number,
    toLateral: number,
    fromAlong: number,
    toAlong: number,
    color: Color,
  ): void {
    const corner = (lateral: number, along: number) =>
      builder.vertex(
        sample.x + sample.rx * lateral + sample.fx * along,
        sample.y + lateral * Math.tan(sample.banking) + along * sample.slope + PAINT_RISE,
        sample.z + sample.rz * lateral + sample.fz * along,
        color,
      );
    // Along-track first, then across, so the painted face points up.
    builder.quad(
      corner(fromLateral, fromAlong),
      corner(fromLateral, toAlong),
      corner(toLateral, toAlong),
      corner(toLateral, fromAlong),
    );
  }

  /** Overhead gate: two posts and a beam spanning the road. */
  private addGantry(builder: MeshBuilder, sample: TrackSample, isStart: boolean): void {
    const steel = this.colors.steel;
    const accent = this.colors.barrierTop;
    const lateral = sample.halfWidth + BARRIER_THICKNESS + 0.9;
    const height = isStart ? GANTRY_HEIGHT + 1.4 : GANTRY_HEIGHT;

    for (const side of [-1, 1] as const) {
      const foot = this.surfacePoint(sample, side, lateral, -0.4);
      builder.box(
        foot.x - GANTRY_POST / 2,
        foot.y,
        foot.z - GANTRY_POST / 2,
        GANTRY_POST,
        height,
        GANTRY_POST,
        steel,
      );
    }

    const centre = this.surfacePoint(sample, 1, 0, height);
    centre.y += 0.45;
    orientedBox(
      builder,
      centre,
      sample,
      lateral + GANTRY_POST / 2,
      isStart ? 0.85 : 0.5,
      0.28,
      accent,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
    this.material.dispose();
    this.group.clear();
  }
}

/** Box aligned to the track frame, for beams and booms that cross the road. */
function orientedBox(
  builder: MeshBuilder,
  centre: Vector3,
  sample: TrackSample,
  halfRight: number,
  halfUp: number,
  halfForward: number,
  color: Color,
): void {
  const corner = (r: number, u: number, f: number) =>
    builder.vertex(
      centre.x + sample.rx * r * halfRight + sample.fx * f * halfForward,
      centre.y + u * halfUp,
      centre.z + sample.rz * r * halfRight + sample.fz * f * halfForward,
      color,
    );

  const a = corner(-1, 1, 1);
  const b = corner(1, 1, 1);
  const c = corner(1, 1, -1);
  const d = corner(-1, 1, -1);
  const e = corner(-1, -1, 1);
  const f = corner(1, -1, 1);
  const g = corner(1, -1, -1);
  const h = corner(-1, -1, -1);

  builder.quad(a, b, c, d);
  builder.quad(h, g, f, e);
  builder.quad(e, f, b, a);
  builder.quad(g, h, d, c);
  builder.quad(f, g, c, b);
  builder.quad(h, e, a, d);
}
