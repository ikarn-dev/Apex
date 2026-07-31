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

import {
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import type { CityPalette, LevelEnvironment } from "../config/levels";
import type { QualitySettings } from "../config/quality";
import { MeshBuilder } from "../world/MeshBuilder";
import { forEachGlyphCell, glyphTextColumns, GLYPH_ROWS } from "../world/glyphs";
import { smoothstep } from "../world/terrain";
import { cornerWarningMask, findCorners, type Corner } from "./corners";
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
/**
 * How far paint sits proud of the asphalt, metres.
 *
 * Coplanar paint z-fights at every distance the chase camera uses, so all of it
 * is lifted. 4cm was enough for that and not enough to be unambiguous: this road
 * banks 4.5° and is 16.8m wide, so reconstructing the surface height from the
 * nearest route sample instead of the exact one carries a couple of centimetres
 * of error at the road's edge — enough that a lane dash 3m off centre could not
 * be told apart from asphalt. 6cm is still invisible from the car and leaves the
 * distinction clear.
 */
const PAINT_RISE = 0.06;

/**
 * Dashed lane dividers.
 *
 * The road is 12.8-16.8m wide, which is three lanes, and an expanse of bare
 * asphalt that wide gives a driver nothing to judge closing speed or lateral
 * position against. The dashes are the cheapest possible fix: they stream past at
 * a rate proportional to speed, which is most of what makes a road feel fast.
 *
 * One route sample of dash every four gives a 2.5m mark on a 10m period.
 */
const LANE_COUNT = 3;
const LANE_LINE_WIDTH = 0.16;
const LANE_DASH_PERIOD = 4;
/** Clear space kept between the outermost lane line and the edge line. */
const LANE_EDGE_MARGIN = 0.25;

/**
 * Corner warning boards painted on the road.
 *
 * A chevron per severity step plus one, so a gentle bend gets two and a hairpin
 * four, followed by the advisory speed in painted numerals. Both sit on the
 * approach, `BOARD_LEAD` metres before the turn-in point.
 */
const CHEVRON_SPACING = 7.5;
const CHEVRON_HALF_WIDTH = 2.1;
const CHEVRON_HALF_LENGTH = 1.5;
const CHEVRON_BAR = 0.46;

/** Painted numeral cell size: lateral, then along the route. Metres. */
const NUMERAL_CELL = 0.42;
const NUMERAL_CELL_ALONG = 0.78;
/** Gap between the numerals and the last chevron, metres. */
const NUMERAL_LEAD = 5.5;

/**
 * Barrier light strip.
 *
 * Chevrons on the inner face of both barriers, pointing the way the road goes,
 * amber instead of green from each advance board through to the corner exit. They
 * are drawn unlit and outside tone mapping, so they read as emitted light against
 * a low sun rather than as painted panels.
 */
const LED_SPACING = 1;
const LED_BOTTOM = 0.42;
const LED_TOP = 0.88;
const LED_HALF_LENGTH = 0.62;
const LED_BAR = 0.17;
/** How far proud of the barrier face the strip sits, metres. */
const LED_INSET = 0.05;

/** Route samples between lighting columns, alternating sides. ~47m. */
const LIGHT_SPACING = 19;
const LIGHT_HEIGHT = 9.2;

const GANTRY_HEIGHT = 7.2;
const GANTRY_POST = 0.42;

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

  /** Every corner on the lap, with its direction and advisory speed. */
  readonly corners: readonly Corner[];

  private readonly colors: Record<keyof CityPalette, Color>;
  private readonly geometries: BufferGeometry[] = [];
  private readonly material: MeshLambertMaterial;
  private readonly glowMaterial: MeshBasicMaterial;
  /** Per-sample corner direction, 0 on the straights. Colours the barrier strip. */
  private readonly warning: Int8Array;
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

    // Unlit, and outside tone mapping, which is the whole point: the barrier
    // strip has to stay bright when the sun is 9° above the horizon and every
    // lit surface around it has gone warm and dim. Fog is left on so a strip
    // 600m away hazes out instead of picking the horizon out in hard green.
    this.glowMaterial = new MeshBasicMaterial({
      vertexColors: true,
      toneMapped: false,
      name: "circuit-glow",
    });

    this.corners = findCorners(track);
    this.warning = cornerWarningMask(track, this.corners);

    this.build();
  }

  private build(): void {
    const n = this.track.samples.length;

    for (let start = 0; start < n; start += CHUNK) {
      const end = Math.min(start + CHUNK, n);
      const builder = new MeshBuilder();
      const glow = new MeshBuilder();

      this.addRoad(builder, start, end);
      for (const side of [-1, 1] as const) {
        this.addKerb(builder, start, end, side);
        this.addEdgeLine(builder, start, end, side);
        this.addBarrier(builder, start, end, side);
        this.addBarrierLights(glow, start, end, side);
        this.addRunoff(builder, start, end, side);
      }
      this.addLaneLines(builder, start, end);
      this.addLightingColumns(builder, start, end);
      this.addMarkings(builder, start, end);
      this.addCornerBoards(builder, start, end);

      const index = start / CHUNK;
      // Barriers, gantries and the tree line are what make the shadow pass worth
      // running; the road itself only receives.
      this.emit(builder, this.material, `circuit-${index}`, this.quality.shadowMapSize > 0);
      // The strip neither casts nor receives: it is light, not a surface.
      this.emit(glow, this.glowMaterial, `circuit-glow-${index}`, false);
    }
  }

  private emit(
    builder: MeshBuilder,
    material: Material,
    name: string,
    shadows: boolean,
  ): void {
    if (builder.empty) return;
    const geometry = builder.build(name);
    this.geometries.push(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    this.group.add(mesh);
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
   * Dashed lane dividers.
   *
   * A 16.8m road is three lanes, and bare asphalt that wide gives a driver
   * nothing to judge lateral position or closing speed against. Dashes are the
   * cheapest possible fix and they do most of the work of making a road feel
   * fast, because they stream past at a rate proportional to speed.
   */
  private addLaneLines(builder: MeshBuilder, start: number, end: number): void {
    const n = this.track.samples.length;
    const line = this.colors.line;
    const half = LANE_LINE_WIDTH / 2;

    for (let i = start; i < end; i += 1) {
      if (i % LANE_DASH_PERIOD !== 0) continue;
      const a = this.track.samples[i % n]!;
      const b = this.track.samples[(i + 1) % n]!;

      for (let lane = 1; lane < LANE_COUNT; lane += 1) {
        const centreA = this.laneLateral(a, lane / LANE_COUNT);
        const centreB = this.laneLateral(b, lane / LANE_COUNT);
        // Along the route first, then across, so the painted face points up.
        const p0 = this.surfacePoint(a, 1, centreA - half, PAINT_RISE);
        const p1 = this.surfacePoint(b, 1, centreB - half, PAINT_RISE);
        const p2 = this.surfacePoint(b, 1, centreB + half, PAINT_RISE);
        const p3 = this.surfacePoint(a, 1, centreA + half, PAINT_RISE);
        builder.quad(
          builder.vertex(p0.x, p0.y, p0.z, line),
          builder.vertex(p1.x, p1.y, p1.z, line),
          builder.vertex(p2.x, p2.y, p2.z, line),
          builder.vertex(p3.x, p3.y, p3.z, line),
        );
      }
    }
  }

  /** Lateral offset of a lane boundary, `fraction` running 0 (left) to 1 (right). */
  private laneLateral(sample: TrackSample, fraction: number): number {
    const inner = this.paintedHalfWidth(sample);
    return -inner + 2 * inner * fraction;
  }

  /** Half-width available for paint: inboard of the kerb and the edge line. */
  private paintedHalfWidth(sample: TrackSample): number {
    return Math.max(
      0.5,
      sample.halfWidth - KERB_WIDTH - EDGE_LINE_WIDTH - LANE_EDGE_MARGIN,
    );
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
   * The barrier light strip: a chevron on the inner face pointing along the road.
   *
   * Amber instead of green from each advance board through to the corner exit, so
   * a corner announces itself while its geometry is still hidden by the barrier
   * on the approach — which is exactly the case a low sun and a blind crest make
   * hardest to read.
   */
  private addBarrierLights(
    builder: MeshBuilder,
    start: number,
    end: number,
    side: number,
  ): void {
    const n = this.track.samples.length;
    const middle = (LED_BOTTOM + LED_TOP) / 2;
    const first = Math.ceil(start / LED_SPACING) * LED_SPACING;

    for (let i = first; i < end; i += LED_SPACING) {
      const index = i % n;
      const sample = this.track.samples[index]!;
      const color = this.warning[index] !== 0 ? this.colors.ledWarn : this.colors.led;
      // Two bars meeting at a tip that points the way the road goes.
      const bar = (fromUp: number) =>
        this.addBarrierBar(
          builder,
          sample,
          side,
          -LED_HALF_LENGTH,
          fromUp,
          LED_HALF_LENGTH,
          middle,
          color,
        );
      bar(LED_BOTTOM);
      bar(LED_TOP);
    }
  }

  /** One bar of a barrier chevron, in (along, up) coordinates on the inner face. */
  private addBarrierBar(
    builder: MeshBuilder,
    sample: TrackSample,
    side: number,
    fromAlong: number,
    fromUp: number,
    toAlong: number,
    toUp: number,
    color: Color,
  ): void {
    const dAlong = toAlong - fromAlong;
    const dUp = toUp - fromUp;
    const length = Math.hypot(dAlong, dUp);
    if (length < 1e-6) return;
    const half = LED_BAR / 2;
    const pAlong = (-dUp / length) * half;
    const pUp = (dAlong / length) * half;

    const corners: [number, number][] = [
      [fromAlong + pAlong, fromUp + pUp],
      [toAlong + pAlong, toUp + pUp],
      [toAlong - pAlong, toUp - pUp],
      [fromAlong - pAlong, fromUp - pUp],
    ];
    // `forward x up` is -right, so a counter-clockwise loop in (along, up) faces
    // the road from the right-hand barrier and away from it on the left.
    const clockwise = shoelace(corners) < 0;
    if (side > 0 ? clockwise : !clockwise) corners.reverse();

    const indices = corners.map(([along, up]) => {
      const point = this.barrierFacePoint(sample, side, along, up);
      return builder.vertex(point.x, point.y, point.z, color);
    });
    builder.quad(indices[0]!, indices[1]!, indices[2]!, indices[3]!);
  }

  /** A point on the barrier's inner face, offset along the route. */
  private barrierFacePoint(
    sample: TrackSample,
    side: number,
    along: number,
    up: number,
  ): Vector3 {
    const point = this.surfacePoint(sample, side, sample.halfWidth - LED_INSET, up);
    point.x += sample.fx * along;
    point.y += sample.slope * along;
    point.z += sample.fz * along;
    return point;
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

  /**
   * Advance warning boards, painted on the approach to every corner.
   *
   * A chevron per severity step plus one — two for a gentle bend, four for the
   * hairpin — pointing the way the road turns, followed by the advisory speed in
   * painted numerals. Both come from `findCorners`, which derives them from the
   * same smoothed curvature the AI brakes on, so the signs cannot disagree with
   * the road they are painted on.
   */
  private addCornerBoards(builder: MeshBuilder, start: number, end: number): void {
    for (const corner of this.corners) {
      if (corner.boardIndex < start || corner.boardIndex >= end) continue;
      this.addCornerBoard(builder, corner);
    }
  }

  private addCornerBoard(builder: MeshBuilder, corner: Corner): void {
    const n = this.track.samples.length;
    const spacing = this.track.sampleSpacing;
    const line = this.colors.line;
    const chevrons = corner.severity + 1;

    const at = (metres: number): TrackSample =>
      this.track.samples[(corner.boardIndex + Math.round(metres / spacing)) % n]!;

    for (let step = 0; step < chevrons; step += 1) {
      const sample = at(step * CHEVRON_SPACING);
      const tip = corner.direction * CHEVRON_HALF_WIDTH;
      const tail = -corner.direction * CHEVRON_HALF_WIDTH;
      // Two strokes meeting at a tip on the inside of the bend: a chevron the
      // driver reads as "the road goes that way".
      this.addRoadBar(builder, sample, tail, -CHEVRON_HALF_LENGTH, tip, 0, CHEVRON_BAR, line);
      this.addRoadBar(builder, sample, tail, CHEVRON_HALF_LENGTH, tip, 0, CHEVRON_BAR, line);
    }

    const text = String(corner.advisoryKph);
    const width = glyphTextColumns(text) * NUMERAL_CELL;
    const sample = at((chevrons - 1) * CHEVRON_SPACING + NUMERAL_LEAD);
    // Painted on the outside of the bend, which is the half of the road the
    // racing line is leaving free anyway.
    const usable = this.paintedHalfWidth(sample);
    const centre = -corner.direction * Math.max(0, usable - width / 2 - 0.2);
    const length = GLYPH_ROWS * NUMERAL_CELL_ALONG;

    forEachGlyphCell(text, (column, row) => {
      const fromLateral = centre - width / 2 + column * NUMERAL_CELL;
      // Row 0 is the top of the digit and has to be the far end from the driver,
      // or the number reads upside down on the approach.
      const toAlong = length / 2 - row * NUMERAL_CELL_ALONG;
      this.addRoadQuad(
        builder,
        sample,
        fromLateral,
        fromLateral + NUMERAL_CELL,
        toAlong - NUMERAL_CELL_ALONG,
        toAlong,
        line,
      );
    });
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
    // Along-track first, then across, so the painted face points up.
    builder.quad(
      this.roadVertex(builder, sample, fromLateral, fromAlong, color),
      this.roadVertex(builder, sample, fromLateral, toAlong, color),
      this.roadVertex(builder, sample, toLateral, toAlong, color),
      this.roadVertex(builder, sample, toLateral, fromAlong, color),
    );
  }

  /**
   * A thick painted stroke on the road, in centreline-relative coordinates.
   *
   * Unlike `addRoadQuad` the stroke can run at any angle, so the winding cannot
   * be fixed at authoring time. `right x forward` is -Y, which makes a clockwise
   * loop in (lateral, along) the one whose face points up; getting it backwards
   * culls the paint and leaves the board invisible.
   */
  private addRoadBar(
    builder: MeshBuilder,
    sample: TrackSample,
    fromLateral: number,
    fromAlong: number,
    toLateral: number,
    toAlong: number,
    thickness: number,
    color: Color,
  ): void {
    const dLateral = toLateral - fromLateral;
    const dAlong = toAlong - fromAlong;
    const length = Math.hypot(dLateral, dAlong);
    if (length < 1e-6) return;
    const half = thickness / 2;
    const pLateral = (-dAlong / length) * half;
    const pAlong = (dLateral / length) * half;

    const corners: [number, number][] = [
      [fromLateral + pLateral, fromAlong + pAlong],
      [toLateral + pLateral, toAlong + pAlong],
      [toLateral - pLateral, toAlong - pAlong],
      [fromLateral - pLateral, fromAlong - pAlong],
    ];
    if (shoelace(corners) > 0) corners.reverse();

    const indices = corners.map(([lateral, along]) =>
      this.roadVertex(builder, sample, lateral, along, color),
    );
    builder.quad(indices[0]!, indices[1]!, indices[2]!, indices[3]!);
  }

  /** A vertex on the painted road surface, in centreline-relative coordinates. */
  private roadVertex(
    builder: MeshBuilder,
    sample: TrackSample,
    lateral: number,
    along: number,
    color: Color,
  ): number {
    return builder.vertex(
      sample.x + sample.rx * lateral + sample.fx * along,
      sample.y + lateral * Math.tan(sample.banking) + along * sample.slope + PAINT_RISE,
      sample.z + sample.rz * lateral + sample.fz * along,
      color,
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
    this.glowMaterial.dispose();
    this.group.clear();
  }
}

/** Twice the signed area of a closed 2D loop. Sign gives the winding direction. */
function shoelace(points: readonly [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[(i + 1) % points.length]!;
    sum += ax * by - bx * ay;
  }
  return sum;
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
