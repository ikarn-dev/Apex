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

/** Digital steering ramp, units per second. */
const STEER_ATTACK = 3.4;
const STEER_RELEASE = 5.6;

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

  /** Called once per fixed step. Returns a reused object — do not retain it. */
  sample(dt: number): VehicleInput {
    const out = this.output;

    const pad = this.readGamepad();
    if (pad) {
      out.throttle = pad.throttle;
      out.brake = pad.brake;
      out.handbrake = pad.handbrake;
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

    // Digital keys ramp toward full lock so a tap is a nudge, not a snap.
    const digitalTarget = keyRight - keyLeft;
    if (digitalTarget !== 0) {
      this.steerSmoothed = moveTowards(
        this.steerSmoothed,
        digitalTarget,
        STEER_ATTACK * dt,
      );
    } else {
      this.steerSmoothed = moveTowards(this.steerSmoothed, 0, STEER_RELEASE * dt);
    }

    out.steer = toVehicleSteer(this.steerSmoothed);
    return out;
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
