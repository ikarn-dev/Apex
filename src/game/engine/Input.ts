/**
 * Input.
 *
 * APEX is a desktop build, so there are two sources feeding one normalised
 * `VehicleInput`:
 *
 * - **Keyboard** — digital, so steering is ramped rather than snapped, otherwise
 *   a key tap is a full-lock input and the car is undriveable.
 * - **Gamepad** — analog triggers and stick, read fresh each frame because the
 *   Gamepad API hands out snapshots rather than live objects.
 */

import type { ControlScheme } from "../types";
import type { VehicleInput } from "../physics/VehicleSim";
import { clamp, moveTowards } from "@/lib/math";

/**
 * Steering feel, modelled on a real rack.
 *
 * `steerSmoothed` is the *steering wheel position*, not the road-wheel angle —
 * `VehicleSim` converts one to the other and applies the speed-dependent lock
 * limit. Keeping that split is what lets this file describe how a driver and a
 * steering column behave, and leave the tyres to the physics.
 *
 * Three properties, all of which a real car has and the previous version did not:
 *
 * - **It self-centres.** Release the keys and caster action winds the wheel back
 *   to straight on its own, rather than the wheel merely stopping where it was.
 * - **Centring is faster than winding on.** Unwinding is assisted by the
 *   geometry; winding on fights it. So `RETURN` is well above `ATTACK`, and
 *   counter-steering through centre uses the return rate too.
 * - **It gets heavier and stronger with speed.** At 200km/h the wheel resists
 *   being turned and snaps back hard; at walking pace it does neither.
 */
const STEER_ATTACK = 2.4;
const STEER_RETURN = 5.5;
/** Extra self-centring at speed, added on top of `STEER_RETURN`. */
const STEER_RETURN_SPEED_GAIN = 5;
/** How much slower the wheel is to wind on at speed, 0-1. */
const STEER_ATTACK_SPEED_TAPER = 0.45;
/** Speed at which the speed-dependent terms saturate, m/s. */
const STEER_REFERENCE_SPEED = 55;

/** Analog stick noise floor. */
const STICK_DEADZONE = 0.14;

/**
 * Browser controls and the vehicle yaw axis have opposite screen-space signs.
 * Convert once, at the human-input boundary, so physics, AI and replays keep one
 * authoritative `VehicleInput` convention.
 */
function toVehicleSteer(humanSteer: number): number {
  return clamp(-humanSteer, -1, 1);
}

interface GamepadSample {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
}

export class InputManager {
  private readonly keys = new Set<string>();
  private readonly output: VehicleInput = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
  };

  private steerSmoothed = 0;
  private attached = false;
  private gamepadIndex: number | null = null;

  /** Set when any input arrives, so the HUD can switch hints automatically. */
  lastUsed: ControlScheme = "keyboard";

  attach(target: Window = window): void {
    if (this.attached) return;
    this.attached = true;
    target.addEventListener("keydown", this.onKeyDown, { passive: false });
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.onBlur);
    target.addEventListener("gamepadconnected", this.onGamepadConnected);
    target.addEventListener("gamepaddisconnected", this.onGamepadDisconnected);
  }

  detach(target: Window = window): void {
    if (!this.attached) return;
    this.attached = false;
    target.removeEventListener("keydown", this.onKeyDown);
    target.removeEventListener("keyup", this.onKeyUp);
    target.removeEventListener("blur", this.onBlur);
    target.removeEventListener("gamepadconnected", this.onGamepadConnected);
    target.removeEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    this.keys.clear();
  }

  /** Kept so the engine can report which device the player last touched. */
  setScheme(scheme: ControlScheme): void {
    this.lastUsed = scheme;
  }

  /**
   * Called once per fixed step. Returns a reused object — do not retain it.
   *
   * `speed` is the car's current ground speed in m/s, used only to taper
   * steering authority. Pass 0 and the behaviour is the low-speed one.
   */
  sample(dt: number, speed = 0): VehicleInput {
    const out = this.output;
    const speedRatio = clamp(speed / STEER_REFERENCE_SPEED, 0, 1);

    const pad = this.readGamepad();
    if (pad) {
      out.throttle = pad.throttle;
      out.brake = pad.brake;
      out.handbrake = pad.handbrake;
      // A stick is already a proportional wheel position and it self-centres in
      // the driver's hand, so it is passed straight through. The speed-dependent
      // lock limit still applies, in `VehicleSim`.
      this.steerSmoothed = pad.steer;
      out.steer = toVehicleSteer(this.steerSmoothed);
      this.lastUsed = "gamepad";
      return out;
    }

    const keyThrottle = this.pressed("ArrowUp", "KeyW") ? 1 : 0;
    const keyBrake = this.pressed("ArrowDown", "KeyS") ? 1 : 0;
    const keyLeft = this.pressed("ArrowLeft", "KeyA") ? 1 : 0;
    const keyRight = this.pressed("ArrowRight", "KeyD") ? 1 : 0;
    const keyHandbrake = this.pressed("Space", "ShiftLeft", "ShiftRight");

    if (keyThrottle > 0 || keyBrake > 0 || keyLeft > 0 || keyRight > 0 || keyHandbrake) {
      this.lastUsed = "keyboard";
    }

    out.throttle = keyThrottle;
    out.brake = keyBrake;
    out.handbrake = keyHandbrake;

    // The wheel is heavier to turn the faster you are going, and springs back
    // harder. Both are what make a car feel planted instead of twitchy.
    const attack = STEER_ATTACK * (1 - STEER_ATTACK_SPEED_TAPER * speedRatio);
    const centring = STEER_RETURN + STEER_RETURN_SPEED_GAIN * speedRatio;

    const target = keyRight - keyLeft;
    const unwinding =
      target === 0 ||
      // Asking for the opposite lock: the wheel has to come back through centre
      // first, and caster is helping, so it unwinds at the centring rate.
      (this.steerSmoothed !== 0 && Math.sign(target) !== Math.sign(this.steerSmoothed));

    this.steerSmoothed = unwinding
      ? // `moveTowards` lands exactly on zero, so releasing the keys genuinely
        // returns to straight instead of asymptotically approaching it.
        moveTowards(this.steerSmoothed, 0, centring * dt)
      : moveTowards(this.steerSmoothed, target, attack * dt);

    out.steer = toVehicleSteer(this.steerSmoothed);
    return out;
  }

  /** Current steering wheel position, -1 to 1. Exposed for tests and the HUD. */
  get steerPosition(): number {
    return this.steerSmoothed;
  }

  reset(): void {
    this.keys.clear();
    this.steerSmoothed = 0;
  }

  // --------------------------------------------------------------- internals

  private pressed(...codes: string[]): boolean {
    for (const code of codes) {
      if (this.keys.has(code)) return true;
    }
    return false;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Arrows and space scroll the page; during a race that is never wanted.
    if (
      event.code.startsWith("Arrow") ||
      event.code === "Space" ||
      event.code === "Tab"
    ) {
      event.preventDefault();
    }
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  /** Alt-tabbing away must not leave the throttle stuck open. */
  private readonly onBlur = (): void => {
    this.keys.clear();
  };

  private readonly onGamepadConnected = (event: Event): void => {
    const gamepadEvent = event as GamepadEvent;
    this.gamepadIndex = gamepadEvent.gamepad.index;
    this.lastUsed = "gamepad";
  };

  private readonly onGamepadDisconnected = (): void => {
    this.gamepadIndex = null;
  };

  private readGamepad(): GamepadSample | null {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    const pad =
      (this.gamepadIndex !== null ? pads[this.gamepadIndex] : null) ??
      pads.find((p) => p !== null) ??
      null;
    if (!pad) return null;

    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;
    const a = pad.buttons[0]?.pressed ? 1 : 0;
    const b = pad.buttons[1]?.pressed ? 1 : 0;
    const handbrake = pad.buttons[2]?.pressed ?? false;
    const rawSteer = pad.axes[0] ?? 0;

    const throttle = Math.max(rt, a);
    const brake = Math.max(lt, b);
    const steer =
      Math.abs(rawSteer) < STICK_DEADZONE
        ? 0
        : // Rescale past the deadzone so the usable range is still full.
          Math.sign(rawSteer) *
          ((Math.abs(rawSteer) - STICK_DEADZONE) / (1 - STICK_DEADZONE));

    if (throttle === 0 && brake === 0 && steer === 0 && !handbrake) return null;
    return { throttle, brake, steer, handbrake };
  }
}
