/**
 * Car roster and physics tuning.
 *
 * One supplied vehicle: a game-ready hatchback with a real transform rig
 * (four `... Tire Pivot` nodes, a `Steering Wheel Pivot`, doors and trunk).
 * Collision and rolling-radius figures below are the source model's own
 * measurements multiplied by the runtime scale in `CarView`, so the physics box
 * and the visible car are the same size.
 *
 * Handling values are arcade, not simulation: they are tuned for feel at a 60Hz
 * fixed step. `stats` are the 1-10 numbers shown in the garage and are derived
 * from the tuning below by hand so the UI never contradicts the physics.
 */

export type CarId = "hatch";

export interface CarTuning {
  /** kg. Affects acceleration and how much momentum carries through a slide. */
  mass: number;
  /** Peak drive force at the wheels, newtons. */
  enginePower: number;
  /** m/s. ~83 m/s = 300 km/h. */
  maxSpeed: number;
  /** Reverse top speed, m/s. */
  maxReverseSpeed: number;
  /** Braking force, newtons. */
  brakeForce: number;
  /** Lateral grip coefficients. Rear < front means natural oversteer. */
  gripFront: number;
  gripRear: number;
  /** Max steering angle at low speed, radians. */
  steerAngleMax: number;
  /** How fast the wheels reach commanded angle, rad/s. */
  steerRate: number;
  /** Steering authority retained at top speed, 0-1. */
  highSpeedSteerFactor: number;
  /** Rear grip multiplier while the handbrake is down. Lower = easier drift. */
  handbrakeGripFactor: number;
  /** Extra downforce as a fraction of speed^2. Raises grip when fast. */
  downforce: number;
  /** Aerodynamic drag. */
  drag: number;
  /** Constant rolling resistance. */
  rollingResistance: number;
  /** Distance between axles, metres. Sets turn radius. */
  wheelbase: number;
  /** Half-width used for collisions, metres. */
  halfWidth: number;
  /** Half-length used for collisions, metres. */
  halfLength: number;
  /** Rolling radius of the visible wheels, metres. Drives wheel spin rate. */
  wheelRadius: number;
}

export interface CarStats {
  acceleration: number;
  topSpeed: number;
  grip: number;
  drift: number;
}

export interface CarDefinition {
  id: CarId;
  /** In-fiction name. */
  name: string;
  /** Real-world model the art is based on. */
  basedOn: string;
  klass: string;
  blurb: string;
  /** Optimised GLB under /public — full detail, 1K textures. */
  model: string;
  /** Reduced variant — 512 textures, looser simplification. Used for rivals. */
  modelLq: string;
  /** Vertical offset so the wheels sit on the road, metres. */
  modelYOffset: number;
  /** Y-rotation correction if the source model faces the wrong way, radians. */
  modelYaw: number;
  /** Livery accent, used in the HUD and garage. */
  accent: number;
  tuning: CarTuning;
  stats: CarStats;
  /** XP on the driver profile required to drive it. */
  unlockXp: number;
}

export const CARS: Record<CarId, CarDefinition> = {
  hatch: {
    id: "hatch",
    name: "APEX GH",
    basedOn: "Generic Hatchback",
    klass: "Hot Hatch",
    blurb:
      "Short, light and honest. Front-heavy on entry, playful on the handbrake, and forgiving enough to learn a 5.8km circuit in. Every act is driven in this car.",
    model: "/models/cars/hatch.glb",
    modelLq: "/models/cars/hatch-lq.glb",
    modelYOffset: 0,
    // The source model already faces +Z, which is the simulation's forward.
    modelYaw: 0,
    accent: 0xd7263d,
    unlockXp: 0,
    tuning: {
      mass: 1180,
      enginePower: 13800,
      maxSpeed: 74,
      maxReverseSpeed: 12,
      brakeForce: 19500,
      gripFront: 12.6,
      gripRear: 11.4,
      steerAngleMax: 0.6,
      steerRate: 4.2,
      highSpeedSteerFactor: 0.34,
      handbrakeGripFactor: 0.34,
      downforce: 0.0018,
      drag: 0.42,
      rollingResistance: 7.6,
      // Source axle centres 2.313m apart, scaled by 4.2 / 3.539.
      wheelbase: 2.75,
      halfWidth: 0.92,
      halfLength: 2.1,
      wheelRadius: 0.377,
    },
    stats: { acceleration: 7, topSpeed: 6, grip: 7, drift: 8 },
  },
};

export const CAR_IDS = Object.keys(CARS) as CarId[];

export const DEFAULT_CAR: CarId = "hatch";

export function getCar(id: string | null | undefined): CarDefinition {
  if (id && id in CARS) return CARS[id as CarId];
  return CARS[DEFAULT_CAR];
}

/** Stable index used by the on-chain program (u8). Order must never change. */
export const CAR_INDEX: Record<CarId, number> = {
  hatch: 0,
};

export function carFromIndex(index: number): CarDefinition {
  const id = CAR_IDS.find((c) => CAR_INDEX[c] === index);
  return id ? CARS[id] : CARS[DEFAULT_CAR];
}
