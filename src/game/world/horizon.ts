/**
 * The desert horizon: mesas, buttes, spires, a rock arch and a wind farm.
 *
 * This replaces the supplied `landscape.glb`. That asset was a temperate forest
 * range, which cannot be tinted into a high-desert sunset, and it was a single
 * authored composition kept ahead of the camera — so it had to be rotated to face
 * the viewer every frame, and any heading where the rotation lagged showed its
 * open back. It also had to survive a load: a backdrop that fails to download is a
 * race with no horizon at all.
 *
 * Generated geometry fixes all of it. A full 360° ring needs no rotation and has
 * no back to see, every heading gets a horizon, there is nothing to download, and
 * the whole thing is one vertex-coloured draw.
 *
 * ## Why it is unlit
 *
 * At 600m through this much haze, a real range carries almost no shading — it is a
 * flat silhouette with the sky's colour bleeding into its base. Lighting it would
 * spend a shader on detail the air has already removed, and would make the horizon
 * respond to the sun's position in a way distant rock visibly does not. Instead the
 * recession is baked into the vertex colours and `FogExp2` does the rest.
 *
 * ## Determinism
 *
 * Placement comes from `hash` over the feature index, never `Math.random`, so the
 * horizon is identical on every device and every reload. `scripts/smoke-scenery.ts`
 * asserts its angular coverage and elevation band against the built geometry.
 */

import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  type BufferGeometry,
  type Color,
} from "three";
import { MeshBuilder } from "./MeshBuilder";
import { hash } from "./terrain";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Clearance kept between the ring and the camera's far plane, metres. */
export const HORIZON_MARGIN = 40;
/** The ring never goes further out than this, so every tier looks the same. */
export const HORIZON_MAX_RADIUS = 620;

/**
 * Elevation band the horizon is allowed to occupy, degrees above the base.
 *
 * Heights are derived from these angles rather than authored in metres, which is
 * what guarantees the band: a range whose peaks are specified in metres changes
 * apparent size whenever the ring radius changes with the quality tier.
 */
export const HORIZON_MIN_ELEVATION_DEGREES = 3;
export const HORIZON_MAX_ELEVATION_DEGREES = 13.5;

/** Feature counts. Enough to close the ring with overlap, and no more. */
const MESA_COUNT = 30;
const BUTTE_COUNT = 12;
const SPIRE_COUNT = 7;
const ARCH_COUNT = 2;
const TURBINE_COUNT = 9;

/** Radial band the ring occupies, as a fraction of its nominal radius. */
const DISTANCE_MIN = 0.82;
const DISTANCE_MAX = 1;

/** Depth as a fraction of width, and the most a footprint corner is pushed out. */
const DEPTH_RATIO_MAX = 0.95;
const FOOTPRINT_WOBBLE_MAX = 1.28;

/**
 * Segments in the skirt that closes the gap under the range.
 *
 * The skirt is what makes the ring *close*: the features are discrete silhouettes
 * with sky between them, and 60 of them over 360° leaves headings with nothing but
 * the seam where the ground plane ends. At 1.6° it sat below the shortest feature
 * and left three of seventy-two headings empty, so it now reads as a continuous
 * distant ridge that everything else stands on.
 */
const SKIRT_SEGMENTS = 96;
const SKIRT_ELEVATION_DEGREES = 2.6;

export type HorizonKind = "mesa" | "butte" | "spire" | "arch" | "turbine";

export interface HorizonFeature {
  kind: HorizonKind;
  /** Bearing from the camera, radians. */
  azimuth: number;
  /** Horizontal distance from the camera, metres. */
  distance: number;
  /** Width across the line of sight, metres. */
  width: number;
  /** Height above the ring's base, metres. */
  height: number;
  /** Depth along the line of sight, metres. */
  depth: number;
  /** Apparent elevation of the top, degrees. */
  elevationDegrees: number;
  /**
   * Position across the ring's radial band, 0 at the front edge and 1 at the back.
   *
   * Carried on the feature so shading can haze the farther silhouettes without
   * needing the ring radius again. This is what layers the range into depth rather
   * than leaving it one flat cut-out.
   */
  depthFraction: number;
  /** 0-1 shape variation from the deterministic hash. */
  variation: number;
}

export interface HorizonComposition {
  /** Nominal radius of the ring, metres. */
  radius: number;
}

export interface HorizonPalette {
  /** Colour at the base, where there is the most air between viewer and rock. */
  haze: Color;
  /** Colour at the peaks, where there is the least. */
  rock: Color;
}

/**
 * Fit the ring inside the active tier's far plane.
 *
 * The radius alone is not what has to fit. A mesa is placed *on* the ring and then
 * given a footprint proportional to its own height, so the back of the deepest one
 * sits well beyond the ring itself — 1.29 radii, as it turns out, which put the low
 * tier's range 54m past a 650m far plane and sliced it. `horizonExtentFactor`
 * derives that multiplier from the profiles below, so changing a profile cannot
 * reintroduce the clipping.
 *
 * Heights are derived from angles, so shrinking the ring on a low tier costs
 * nothing visually: the range subtends the same angle from a nearer distance.
 */
export function horizonComposition(drawDistance: number): HorizonComposition {
  const usable = Math.max(160, drawDistance - HORIZON_MARGIN);
  return {
    radius: Math.max(120, Math.min(HORIZON_MAX_RADIUS, usable / horizonExtentFactor())),
  };
}

/** How far past the nominal radius the outermost geometry can reach, in radii. */
export function horizonExtentFactor(): number {
  let deepest = 0;
  for (const kind of KIND_ORDER) {
    const profile = PROFILES[kind];
    // Width scales with height, height with distance, and depth with width; the
    // footprint wobble then pushes a corner further out still.
    const width = Math.tan(profile.maxElevation * DEG) * DISTANCE_MAX * profile.maxAspect;
    deepest = Math.max(deepest, (width * DEPTH_RATIO_MAX * FOOTPRINT_WOBBLE_MAX) / 2);
  }
  return DISTANCE_MAX + deepest;
}

interface KindProfile {
  count: number;
  /** Elevation band for this kind, degrees. */
  minElevation: number;
  maxElevation: number;
  /** Width as a multiple of height. */
  minAspect: number;
  maxAspect: number;
}

const PROFILES: Record<HorizonKind, KindProfile> = {
  // Broad flat-topped tables: the bulk of the range.
  mesa: { count: MESA_COUNT, minElevation: 4.5, maxElevation: 8.5, minAspect: 1.5, maxAspect: 3.2 },
  // Taller, narrower, stepped. These carry the skyline.
  butte: { count: BUTTE_COUNT, minElevation: 8, maxElevation: 12, minAspect: 0.7, maxAspect: 1.4 },
  // Near-vertical pinnacles, the tallest things out there.
  spire: { count: SPIRE_COUNT, minElevation: 9, maxElevation: 13.5, minAspect: 0.22, maxAspect: 0.45 },
  arch: { count: ARCH_COUNT, minElevation: 5.5, maxElevation: 7.5, minAspect: 1.1, maxAspect: 1.5 },
  // Low and slender, dotted along the plain in front of the rock.
  turbine: { count: TURBINE_COUNT, minElevation: 3, maxElevation: 4.6, minAspect: 0.3, maxAspect: 0.42 },
};

const KIND_ORDER: HorizonKind[] = ["mesa", "butte", "spire", "arch", "turbine"];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Every feature on the ring, deterministic in the feature index.
 *
 * Slots are spread evenly and then jittered by less than half a slot, so the
 * range closes all the way round without the regular spacing being visible.
 */
export function horizonFeatures(radius: number): HorizonFeature[] {
  const features: HorizonFeature[] = [];

  KIND_ORDER.forEach((kind, kindIndex) => {
    const profile = PROFILES[kind];
    const slice = TAU / profile.count;

    for (let i = 0; i < profile.count; i += 1) {
      const jitter = hash(kindIndex * 977 + 1, i * 31 + 7) - 0.5;
      // Each kind starts at its own offset so the kinds interleave rather than
      // every spire landing next to every arch.
      const azimuth =
        (i + 0.5) * slice + jitter * slice * 0.8 + (kindIndex * TAU) / KIND_ORDER.length;

      const depthRoll = hash(kindIndex * 613 + 3, i * 47 + 11);
      const distance = radius * lerp(DISTANCE_MIN, DISTANCE_MAX, depthRoll);

      const elevationRoll = hash(kindIndex * 419 + 5, i * 59 + 13);
      const elevationDegrees = lerp(profile.minElevation, profile.maxElevation, elevationRoll);
      const height = Math.tan(elevationDegrees * DEG) * distance;

      const aspectRoll = hash(kindIndex * 271 + 9, i * 67 + 17);
      const width = height * lerp(profile.minAspect, profile.maxAspect, aspectRoll);

      features.push({
        kind,
        azimuth,
        distance,
        width,
        height,
        depth: width * lerp(0.55, DEPTH_RATIO_MAX, hash(kindIndex * 131 + 15, i * 71 + 19)),
        elevationDegrees,
        depthFraction: depthRoll,
        variation: hash(kindIndex * 89 + 21, i * 73 + 23),
      });
    }
  });

  return features;
}

/**
 * Build the horizon as one geometry, base at y = 0.
 *
 * The caller places it: the base belongs on the ground plane so the range stands
 * on the desert rather than floating over it.
 */
export function buildHorizon(
  composition: HorizonComposition,
  palette: HorizonPalette,
): BufferGeometry {
  const builder = new MeshBuilder();
  const features = horizonFeatures(composition.radius);

  addSkirt(builder, composition.radius, palette);
  // Farthest first, so that within one draw the nearer silhouettes are written
  // over the hazier ones even where depth is a near tie.
  for (const feature of [...features].sort((a, b) => b.distance - a.distance)) {
    addFeature(builder, feature, palette);
  }

  return builder.build("horizon");
}

/**
 * The finished horizon mesh, ready to parent to a camera-locked anchor.
 *
 * `DoubleSide` on purpose: a silhouette looks identical from either face, and
 * back-face culling on generated prisms is a whole class of bug — an inverted
 * winding removes a mesa and nothing says which one.
 */
export function createHorizonMesh(
  composition: HorizonComposition,
  palette: HorizonPalette,
): { mesh: Mesh; geometry: BufferGeometry; material: MeshBasicMaterial } {
  const geometry = buildHorizon(composition, palette);
  const material = new MeshBasicMaterial({
    vertexColors: true,
    side: DoubleSide,
    name: "horizon",
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "desert-horizon";
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // It is always around the camera, and a bounding sphere test on a ring that
  // never leaves the view is wasted work.
  mesh.frustumCulled = false;
  return { mesh, geometry, material };
}

// --------------------------------------------------------------------- shapes

/** Colour at a height up a feature: hazy at the base, rock at the top. */
function shade(palette: HorizonPalette, fraction: number, depthFade: number): Color {
  // Haze wins low down and further out. Squaring biases the blend toward the
  // base, which is where the air actually accumulates.
  const hazeAmount = (1 - fraction) * (1 - fraction) * 0.85 + depthFade * 0.3;
  return palette.rock.clone().lerp(palette.haze, Math.min(1, hazeAmount));
}

interface Frame {
  /** Unit vector from the camera toward the feature. */
  outX: number;
  outZ: number;
  /** Unit vector across the line of sight. */
  acrossX: number;
  acrossZ: number;
  /** Feature centre, on the ring. */
  centreX: number;
  centreZ: number;
}

function frameFor(feature: HorizonFeature): Frame {
  const outX = Math.sin(feature.azimuth);
  const outZ = Math.cos(feature.azimuth);
  return {
    outX,
    outZ,
    acrossX: outZ,
    acrossZ: -outX,
    centreX: outX * feature.distance,
    centreZ: outZ * feature.distance,
  };
}

function addFeature(
  builder: MeshBuilder,
  feature: HorizonFeature,
  palette: HorizonPalette,
): void {
  switch (feature.kind) {
    case "arch":
      addArch(builder, feature, palette);
      return;
    case "turbine":
      addTurbine(builder, feature, palette);
      return;
    case "spire":
      addPrism(builder, feature, palette, {
        footprintSides: 5,
        topScale: 0.12,
        height: feature.height,
        baseY: 0,
      });
      return;
    case "butte":
      // A shoulder, then the tower above it: the stepped profile is what makes a
      // butte read as eroded rock instead of an extruded polygon.
      addPrism(builder, feature, palette, {
        footprintSides: 6,
        topScale: 0.72,
        height: feature.height * 0.42,
        baseY: 0,
      });
      addPrism(builder, feature, palette, {
        footprintSides: 6,
        topScale: 0.78,
        widthScale: 0.7,
        height: feature.height * 0.58,
        baseY: feature.height * 0.42,
      });
      return;
    default:
      addPrism(builder, feature, palette, {
        footprintSides: 6,
        topScale: 0.82,
        height: feature.height,
        baseY: 0,
      });
  }
}

interface PrismOptions {
  footprintSides: number;
  /** Footprint scale at the top, relative to the base. */
  topScale: number;
  height: number;
  baseY: number;
  widthScale?: number;
}

/**
 * A tapered prism on an irregular footprint.
 *
 * The footprint is jittered per corner from the feature's own hash, so no two
 * mesas share a silhouette even though they share this code.
 */
function addPrism(
  builder: MeshBuilder,
  feature: HorizonFeature,
  palette: HorizonPalette,
  options: PrismOptions,
): void {
  const frame = frameFor(feature);
  const fade = feature.depthFraction;
  const scale = options.widthScale ?? 1;
  const halfWidth = (feature.width / 2) * scale;
  const halfDepth = (feature.depth / 2) * scale;

  const bottom = shade(palette, options.baseY / feature.height, fade);
  const top = shade(palette, (options.baseY + options.height) / feature.height, fade);

  const sides = options.footprintSides;
  const base: [number, number][] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * TAU;
    // Corner-by-corner jitter, deterministic in the feature and the corner.
    const wobble =
      FOOTPRINT_WOBBLE_MAX -
      hash(Math.round(feature.azimuth * 1e4), i * 37 + 5) * (FOOTPRINT_WOBBLE_MAX - 0.72);
    base.push([Math.cos(angle) * halfWidth * wobble, Math.sin(angle) * halfDepth * wobble]);
  }

  const world = (u: number, v: number, y: number): [number, number, number] => [
    frame.centreX + frame.acrossX * u + frame.outX * v,
    y,
    frame.centreZ + frame.acrossZ * u + frame.outZ * v,
  ];

  const topY = options.baseY + options.height;
  const bottomRing = base.map(([u, v]) => {
    const [x, y, z] = world(u, v, options.baseY);
    return builder.vertex(x, y, z, bottom);
  });
  const topRing = base.map(([u, v]) => {
    const [x, y, z] = world(u * options.topScale, v * options.topScale, topY);
    return builder.vertex(x, y, z, top);
  });

  for (let i = 0; i < sides; i += 1) {
    const next = (i + 1) % sides;
    builder.quad(bottomRing[i]!, bottomRing[next]!, topRing[next]!, topRing[i]!);
  }

  // Flat top, as a fan from the first corner. Only visible on the shorter mesas,
  // but a missing cap is a hole in the skyline from any raised camera.
  for (let i = 1; i < sides - 1; i += 1) {
    builder.quad(topRing[0]!, topRing[i]!, topRing[i + 1]!, topRing[0]!);
  }
}

/** Two legs and a span: the reference photograph's arch, in silhouette. */
function addArch(
  builder: MeshBuilder,
  feature: HorizonFeature,
  palette: HorizonPalette,
): void {
  const legWidth = feature.width * 0.26;
  const legHeight = feature.height * 0.62;
  const offset = feature.width * 0.32;

  for (const side of [-1, 1] as const) {
    addPrism(
      builder,
      {
        ...feature,
        azimuth: feature.azimuth + (side * offset) / feature.distance,
        width: legWidth,
        depth: feature.depth * 0.5,
      },
      palette,
      { footprintSides: 5, topScale: 0.86, height: legHeight, baseY: 0 },
    );
  }

  // The span, wide enough to bridge both legs.
  addPrism(
    builder,
    { ...feature, width: feature.width * 0.95, depth: feature.depth * 0.45 },
    palette,
    {
      footprintSides: 4,
      topScale: 0.9,
      height: feature.height - legHeight,
      baseY: legHeight,
    },
  );
}

/**
 * A wind turbine: tapered mast, nacelle, three blades.
 *
 * The rotor is built in the plane across the line of sight, so it presents its
 * full disc to the camera — which is the only orientation that reads as a turbine
 * at this distance and this size.
 */
function addTurbine(
  builder: MeshBuilder,
  feature: HorizonFeature,
  palette: HorizonPalette,
): void {
  const frame = frameFor(feature);
  // Turbines sit in front of the rock, so they keep a little more of their own
  // colour than a mesa at the same depth would.
  const fade = 0.2 + feature.depthFraction * 0.5;
  const hubHeight = feature.height * 0.68;
  const bladeLength = feature.height * 0.34;
  const mastHalf = Math.max(0.6, feature.height * 0.012);

  const colorLow = shade(palette, 0.15, fade);
  const colorHigh = shade(palette, 0.85, fade);

  const world = (u: number, y: number, v = 0): [number, number, number] => [
    frame.centreX + frame.acrossX * u + frame.outX * v,
    y,
    frame.centreZ + frame.acrossZ * u + frame.outZ * v,
  ];

  const vertex = (u: number, y: number, color: Color, v = 0): number => {
    const [x, wy, z] = world(u, y, v);
    return builder.vertex(x, wy, z, color);
  };

  // Mast: a tapering quad, seen edge-on from anywhere on the ring.
  builder.quad(
    vertex(-mastHalf, 0, colorLow),
    vertex(mastHalf, 0, colorLow),
    vertex(mastHalf * 0.45, hubHeight, colorHigh),
    vertex(-mastHalf * 0.45, hubHeight, colorHigh),
  );

  // Nacelle.
  const nacelle = mastHalf * 1.6;
  builder.quad(
    vertex(-nacelle, hubHeight - nacelle * 0.6, colorHigh),
    vertex(nacelle, hubHeight - nacelle * 0.6, colorHigh),
    vertex(nacelle, hubHeight + nacelle * 0.6, colorHigh),
    vertex(-nacelle, hubHeight + nacelle * 0.6, colorHigh),
  );

  // Three blades, 120° apart, at a per-turbine rotor angle.
  const phase = feature.variation * TAU;
  for (let blade = 0; blade < 3; blade += 1) {
    const angle = phase + (blade * TAU) / 3;
    const dirU = Math.cos(angle);
    const dirY = Math.sin(angle);
    const rootHalf = mastHalf * 1.1;
    const tipHalf = mastHalf * 0.35;

    builder.quad(
      vertex(-dirY * rootHalf, hubHeight + dirU * rootHalf, colorHigh),
      vertex(dirY * rootHalf, hubHeight - dirU * rootHalf, colorHigh),
      vertex(
        dirU * bladeLength + dirY * tipHalf,
        hubHeight + dirY * bladeLength - dirU * tipHalf,
        colorHigh,
      ),
      vertex(
        dirU * bladeLength - dirY * tipHalf,
        hubHeight + dirY * bladeLength + dirU * tipHalf,
        colorHigh,
      ),
    );
  }
}

/**
 * A low continuous band around the whole ring.
 *
 * The range is a set of discrete silhouettes with sky between them, and without
 * this the gaps show the ground plane running out to the fog with a visible seam
 * where it ends. The skirt is the same haze colour the fog is converging on, so it
 * closes the seam rather than drawing attention to it.
 */
function addSkirt(builder: MeshBuilder, radius: number, palette: HorizonPalette): void {
  const distance = radius * DISTANCE_MAX;
  const height = Math.tan(SKIRT_ELEVATION_DEGREES * DEG) * distance;
  const base = palette.haze.clone();
  const top = palette.haze.clone().lerp(palette.rock, 0.35);

  let previous: [number, number] | null = null;
  for (let i = 0; i <= SKIRT_SEGMENTS; i += 1) {
    const azimuth = (i / SKIRT_SEGMENTS) * TAU;
    const x = Math.sin(azimuth) * distance;
    const z = Math.cos(azimuth) * distance;
    const ring: [number, number] = [
      builder.vertex(x, 0, z, base),
      builder.vertex(x, height, z, top),
    ];
    if (previous) builder.quad(previous[0]!, ring[0]!, ring[1]!, previous[1]!);
    previous = ring;
  }
}
