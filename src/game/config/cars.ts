/**
 * Car roster and physics tuning.
 *
 * One supplied vehicle: an Aston Martin DBS GT Zagato, shipped with its own PBR
 * textures rather than flattened to solid colours, and with the source model's
 * transform rig intact — four `WHEEL_**` groups and a `STEER_HR` column, which is
 * what lets `CarView` spin the wheels, steer the front axle and turn the wheel in
 * the driver's hands.
 *
 * Collision and rolling-radius figures are the source model's own measurements
 * multiplied by the runtime scale in `CarView`, so the physics box and the visible
 * car are the same size.
 *
 * Handling values are arcade, not simulation: tuned for feel at a 60Hz fixed step.
 * `stats` are the 1-10 numbers shown in the garage and are derived from the tuning
 * below by hand so the UI never contradicts the physics.
 */

import { assetUrl } from "./assets";

export type CarId = "zagato";

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
  /**
   * Optimised GLB under /public — rigged. The player's car.
   *
   * Carries a `?v=<content hash>` from the asset manifest; see `./assets`.
   */
  model: string;
  /** Rival variant — smaller textures, rig collapsed for draw calls. */
  modelLq: string;
  /** Length every car is normalised to, metres. */
  targetLength: number;
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
  zagato: {
    id: "zagato",
    name: "APEX GTZ",
    basedOn: "Aston Martin DBS GT Zagato",
    klass: "Grand Tourer",
    blurb:
      "Long, heavy and immensely fast once it is pointed straight. Rewards a driver who brakes early and gets the nose settled before the apex, and will happily rotate on the handbrake if you insist. Every act is driven in this car.",
    model: assetUrl("/models/cars/zagato.glb"),
    modelLq: assetUrl("/models/cars/zagato-lq.glb"),
    // A DBS GT Zagato is 4.75m long.
    targetLength: 4.75,
    modelYOffset: 0,
    // Measured from the source model's own lamp clusters: it faces +Z, which is
    // the simulation's forward, with a 3.2° export skew to take out.
    modelYaw: -0.056,
    accent: 0xd8a24a,
    unlockXp: 0,
    tuning: {
      mass: 1710,
      enginePower: 24600,
      maxSpeed: 82,
      maxReverseSpeed: 12,
      brakeForce: 27400,
      gripFront: 13.2,
      gripRear: 12.1,
      // A 1710kg GT, not a hot hatch: less lock, a slower rack, and much less
      // authority left at speed. Inheriting the hatchback's numbers made this car
      // dart at the smallest input and was the main reason it kept spearing into
      // the barriers.
      steerAngleMax: 0.42,
      // The rack tracks the wheel briskly; the *feel* comes from `InputManager`,
      // which models the wheel and its self-centring. Damping it here as well
      // would stack two lags and make the car feel like it is steering on a
      // delay.
      steerRate: 3.6,
      highSpeedSteerFactor: 0.18,
      handbrakeGripFactor: 0.32,
      downforce: 0.0021,
      drag: 0.46,
      rollingResistance: 8.4,
      wheelbase: 2.81,
      halfWidth: 1.03,
      halfLength: 2.38,
      wheelRadius: 0.35,
    },
    stats: { acceleration: 9, topSpeed: 9, grip: 8, drift: 7 },
  },
};

export const CAR_IDS = Object.keys(CARS) as CarId[];

export const DEFAULT_CAR: CarId = "zagato";

export function isCarId(value: unknown): value is CarId {
  return typeof value === "string" && value in CARS;
}

export function getCar(id: string | null | undefined): CarDefinition {
  if (isCarId(id)) return CARS[id];
  return CARS[DEFAULT_CAR];
}

/** Stable index used by the on-chain program (u8). Order must never change. */
export const CAR_INDEX: Record<CarId, number> = {
  zagato: 0,
};

export function carFromIndex(index: number): CarDefinition {
  const id = CAR_IDS.find((c) => CAR_INDEX[c] === index);
  return id ? CARS[id] : CARS[DEFAULT_CAR];
}
