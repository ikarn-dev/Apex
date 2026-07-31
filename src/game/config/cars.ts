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
  /**
   * How much lock the driver gets beyond the grip-limited angle, ≥ 1.
   *
   * `VehicleSim` limits steering to the Ackermann angle the tyres can actually
   * use at the current speed, which falls with speed squared. This is the margin
   * on top: 1.0 means the car can never be asked to exceed its own grip, and
   * higher values leave room to provoke a slide deliberately.
   */
  steerLockMargin: number;
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
      enginePower: 27800,
      // 338 km/h. This is an arcade racer and the circuit has two long straights
      // to spend a top end on.
      maxSpeed: 94,
      maxReverseSpeed: 12,
      // Scaled with the top speed: the same braking distance from a higher
      // entry speed needs more force, or every corner arrives too fast to make.
      brakeForce: 33500,
      gripFront: 13.2,
      gripRear: 12.1,
      // A 1710kg GT, not a hot hatch. Full lock is available below about 40km/h;
      // above that `VehicleSim` takes it away in proportion to what the tyres can
      // use, so this is really the parking-speed limit.
      steerAngleMax: 0.42,
      // The rack tracks the wheel closely; the *feel* comes from `InputManager`,
      // which models the wheel and its self-centring. This used to be 3.6, whose
      // 280ms time constant stacked on top of the wheel's own wind-on and made
      // the car feel like it was steering on a delay at speed.
      steerRate: 6.5,
      // Headroom so the yaw ceiling is actually reachable through the rack and
      // yaw lags. `VehicleSim` derives the steering lock from the yaw budget, so
      // this no longer buys extra lock — it only stops full stick landing just
      // short of the limit. It was 1.6, which put the ceiling at 62% of stick
      // travel and left the rest of the wheel doing nothing.
      steerLockMargin: 1.08,
      handbrakeGripFactor: 0.32,
      // 1.23g standing, 2.98g at 338km/h. It was 0.00008 — only 1.9g flat out,
      // a 361m minimum radius, so at speed the car barely changed direction no
      // matter what the wheel did. Still nowhere near the 0.0021 (18.6g) that
      // made it uncontrollable.
      downforce: 0.00016,
      drag: 0.46,
      rollingResistance: 8.4,
      wheelbase: 2.81,
      // Measured off the normalised model by `npm run test:rig`, not off the road
      // car's spec sheet. The barrier constraint puts this box's edge exactly on
      // the wall, so a box narrower than the model buries the difference inside
      // the barrier: at the old 1.03m, 180mm of the outboard side went in and the
      // front wheel on that side vanished into the wall on every scrape.
      halfWidth: 1.22,
      halfLength: 2.45,
      // The tyre the model actually draws is 736mm across.
      wheelRadius: 0.368,
    },
    stats: { acceleration: 9, topSpeed: 10, grip: 9, drift: 7 },
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
