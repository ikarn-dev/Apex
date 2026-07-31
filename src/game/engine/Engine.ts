/**
 * The engine.
 *
 * Owns the render loop and every subsystem under it. React mounts this, hands it
 * a `RaceConfig` and a `GameBridge`, and then stays out of the way — no React
 * state is touched at frame rate.
 *
 * ## The loop
 *
 * ```
 * accumulator += min(elapsed, 100ms)      // clamp: a long GC pause must not
 * while (accumulator >= 1/60) step()      //   spend 40 steps catching up
 * render(alpha = accumulator / (1/60))    // interpolate for smooth visuals
 * ```
 *
 * A fixed step is what makes the simulation deterministic, and interpolated
 * rendering is what stops a 144Hz monitor from looking juddery when the
 * simulation only advances 60 times a second.
 */

import { Group, Vector3, type Scene } from "three";
import { CARS } from "../config/cars";
import { rivalLivery } from "../config/drivers";
import { getLevel } from "../config/levels";
import { QUALITY_PRESETS, demote, type QualityTier } from "../config/quality";
import { CarView, carDetailFor, type CarDetail } from "../entities/CarView";
import { FIXED_STEP, RaceDirector } from "../race/RaceDirector";
import { CircuitView } from "../track/CircuitView";
import type {
  ControlScheme,
  EngineHandle,
  GameBridge,
  RaceConfig,
  Telemetry,
} from "../types";
import { AudioEngine } from "./Audio";
import { ChaseCamera } from "./ChaseCamera";
import { InputManager } from "./Input";
import { Renderer } from "./Renderer";
import { Resources } from "./Resources";
import { buildWorld } from "./World";
import { Scenery } from "../world/Scenery";
import { clamp, lerp } from "@/lib/math";

/** Clamp on catch-up work after a stall, ms. */
const MAX_FRAME_MS = 100;
/** HUD publication interval. Rendering itself stays independent of it. */
const TELEMETRY_INTERVAL_SECONDS = 0.1;

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Container whose size the renderer tracks. */
  container: HTMLElement;
  config: RaceConfig;
  bridge: GameBridge;
}

interface RacerVisual {
  view: CarView;
  /** Previous and current physics positions, for interpolation. */
  previous: Vector3;
  current: Vector3;
}

export class Engine implements EngineHandle {
  private readonly renderer: Renderer;
  private readonly resources: Resources;
  private readonly input = new InputManager();
  private readonly audio = new AudioEngine();
  private readonly camera = new ChaseCamera();
  private readonly bridge: GameBridge;
  private readonly container: HTMLElement;

  private readonly world: ReturnType<typeof buildWorld>;
  private readonly circuit: CircuitView;
  private readonly scenery: Scenery;
  private scene: Scene;
  private disposeWorld: () => void;
  private carGroup = new Group();

  private director: RaceDirector;
  private visuals: RacerVisual[] = [];

  private config: RaceConfig;
  private quality: QualityTier;

  private rafHandle: number | null = null;
  private lastFrameTime = 0;
  private accumulator = 0;
  private running = false;
  private paused = false;
  private disposed = false;
  private modelsReady = false;

  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private lastCountdownValue = -1;
  private telemetryAccumulator = 0;

  private readonly scratch = new Vector3();
  /** Fixed offset of the shadow light from the player. */
  private readonly sunOffset = new Vector3(-140, 190, -110);
  private readonly sunPosition = new Vector3();
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: EngineOptions) {
    this.config = options.config;
    this.bridge = options.bridge;
    this.container = options.container;
    this.quality = options.config.quality;

    const level = getLevel(options.config.levelId);
    if (!level) throw new Error(`unknown level: ${options.config.levelId}`);
    const quality = QUALITY_PRESETS[this.quality];

    this.renderer = new Renderer(options.canvas, quality, {
      onDemoteRequested: (reason) => this.handleDemote(reason),
    });
    this.resources = new Resources();

    this.director = new RaceDirector({
      level,
      carId: options.config.carId,
      driverName: options.config.driverName,
      seed: BigInt(options.config.seed),
      maxRivals: quality.maxRivals,
      bridge: options.bridge,
      practice: options.config.practice,
    });

    // The circuit is generated from the route, and its run-off decides where the
    // ground plane belongs, so it is built before the world that has to meet it.
    this.circuit = new CircuitView(this.director.track, level.env, quality);

    this.world = buildWorld(
      level.env,
      quality,
      this.director.track.boundsRadius,
      this.renderer.renderer,
      this.circuit.groundHeight,
    );
    this.scene = this.world.scene;
    this.disposeWorld = this.world.dispose;
    this.scene.add(this.circuit.group);

    this.scenery = new Scenery(
      this.director.track,
      quality,
      this.circuit.groundHeight,
      level.env,
    );
    this.scene.add(this.scenery.group);
    // The camera-facing landscape is a sibling of the world-space tree line;
    // `render` positions and aims it independently every frame.
    this.scene.add(this.scenery.backdrop);

    this.carGroup.name = "cars";
    this.scene.add(this.carGroup);
    this.buildCarViews();

    this.camera.motionScale = options.config.reducedMotion ? 0 : 1;
    this.camera.reset(this.director.player.sim.state);

    this.input.attach();
    this.input.setScheme(options.config.controls);
    this.audio.init(options.config.masterVolume, options.config.sfxEnabled);

    this.observeResize();
    void this.loadModels();
  }

  // -------------------------------------------------------------------- setup

  /**
   * Pick a detail level per car.
   *
   * The player always gets the rigged variant: it is the car on screen for the
   * whole race, and it is the only one whose wheels and steering are close enough
   * to read.
   *
   * Rivals used to always get `zagato-lq.glb`, whose rig is collapsed — 30 flat
   * meshes with no `WHEEL_**` nodes at all. `CarView.bindRig` then finds nothing
   * and their wheels are welded to the bodyshell, which is plainly visible: a car
   * alongside you at 300km/h with stationary tyres. That trade is only worth making
   * on the lowest tier, where the draw calls actually matter.
   *
   * It costs less than it looks like, too. Above `low` the whole field shares one
   * cached GLB, so the race downloads 3.9MB instead of 5.3MB and holds 21MB of
   * texture memory instead of 30MB — the saving was never in the bytes, only in the
   * draw calls.
   */
  private detailFor(isPlayer: boolean): CarDetail {
    return carDetailFor(isPlayer, this.quality);
  }

  private buildCarViews(): void {
    const quality = QUALITY_PRESETS[this.quality];
    let rivalIndex = 0;
    for (const racer of this.director.racers) {
      const view = new CarView(
        CARS[racer.carId],
        quality,
        this.detailFor(racer.isPlayer),
        // The player keeps the car's factory paint; rivals get team colours so a
        // one-car roster still fields a grid rather than six identical cars.
        racer.isPlayer ? null : rivalLivery(rivalIndex++),
      );
      const position = new Vector3(
        racer.sim.state.x,
        racer.sim.state.y,
        racer.sim.state.z,
      );
      view.sync(racer.sim.state, position);
      this.carGroup.add(view.group);
      this.visuals.push({
        view,
        previous: position.clone(),
        current: position.clone(),
      });
    }
  }

  /**
   * Load the real car models after the scene is already rendering.
   *
   * The race is playable with placeholders from the first frame; models upgrade
   * in place. This is why a slow connection delays fidelity rather than the
   * green light.
   */
  private async loadModels(): Promise<void> {
    // Only the cars are downloaded. The circuit is generated, so it is complete
    // before the first frame and has nothing to wait for.
    //
    // `allSettled`, not `all`: one asset failing must not leave the rest of the
    // field as placeholders forever, and the race still has to be startable. But
    // the failure is reported rather than swallowed.
    const results = await Promise.allSettled([
      ...this.visuals.map((visual) => visual.view.attachModel(this.resources)),
      // Scenery is cosmetic, so it is loaded alongside rather than gated on: a
      // missing tree pack costs a bare roadside, not a race.
      this.scenery.load(this.resources),
    ]);
    if (this.disposed) return;

    const failure = results.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      const reason =
        failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
      this.bridge.onEvent({ type: "load-failed", reason });
    }

    this.modelsReady = true;
    this.bridge.onTelemetry?.(this.snapshot());
    this.bridge.onEvent({ type: "loaded" });
  }

  /** Whether every car has finished attaching its model (or failed trying). */
  get ready(): boolean {
    return this.modelsReady;
  }

  private observeResize(): void {
    const apply = () => {
      const rect = this.container.getBoundingClientRect();
      this.renderer.resize(rect.width, rect.height);
    };
    apply();

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(apply);
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener("resize", apply);
    }
  }

  // ------------------------------------------------------------------ control

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.paused = false;
    this.lastFrameTime = performance.now();
    this.accumulator = 0;
    void this.audio.resume();
    this.director.beginCountdown();
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.audio.suspend();
    this.input.reset();
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    // Reset the clock: the wall time spent paused must not be simulated.
    this.lastFrameTime = performance.now();
    this.accumulator = 0;
    void this.audio.resume();
  }

  restart(): void {
    const level = getLevel(this.config.levelId);
    if (!level) return;
    const quality = QUALITY_PRESETS[this.quality];

    for (const visual of this.visuals) {
      this.carGroup.remove(visual.view.group);
      visual.view.dispose();
    }
    this.visuals = [];

    this.director = new RaceDirector({
      level,
      carId: this.config.carId,
      driverName: this.config.driverName,
      seed: BigInt(this.config.seed),
      maxRivals: quality.maxRivals,
      bridge: this.bridge,
      practice: this.config.practice,
    });

    this.buildCarViews();
    void this.loadModels();

    this.camera.reset(this.director.player.sim.state);
    this.input.reset();
    this.accumulator = 0;
    this.lastFrameTime = performance.now();
    this.lastCountdownValue = -1;
    this.director.beginCountdown();
  }

  retire(): void {
    this.director.retire();
  }

  markBanked(): void {
    this.director.markBanked();
  }



  setControls(scheme: ControlScheme): void {
    this.config = { ...this.config, controls: scheme };
    this.input.setScheme(scheme);
  }

  setVolume(volume: number): void {
    this.config = { ...this.config, masterVolume: volume };
    this.audio.setVolume(volume);
  }

  /** Rename the player mid-flight. Cosmetic; see `RaceDirector.setDriverName`. */
  setDriverName(name: string): void {
    this.config = { ...this.config, driverName: name };
    this.director.setDriverName(name);
  }

  get telemetry(): Readonly<Telemetry> {
    return this.director.telemetry;
  }

  /** Exposed so the race shell can read the replay digest at the finish. */
  get race(): RaceDirector {
    return this.director;
  }

  private handleDemote(reason: string): void {
    const next = demote(this.quality);
    if (next === this.quality) return;
    this.quality = next;
    this.renderer.setQuality(QUALITY_PRESETS[next]);
    this.bridge.onEvent({ type: "quality", tier: next, reason });
  }

  // --------------------------------------------------------------------- loop

  private readonly frame = (now: number): void => {
    if (!this.running || this.disposed) return;
    this.rafHandle = requestAnimationFrame(this.frame);

    const rawElapsed = now - this.lastFrameTime;
    this.lastFrameTime = now;

    if (this.paused) return;

    const elapsed = Math.min(rawElapsed, MAX_FRAME_MS);
    this.renderer.observeFrame(rawElapsed);

    this.fpsAccumulator += rawElapsed;
    this.fpsFrames += 1;
    if (this.fpsAccumulator >= 500) {
      this.director.telemetry.fps = Math.round(
        (this.fpsFrames * 1000) / this.fpsAccumulator,
      );
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }

    this.accumulator += elapsed / 1000;

    // Snapshot positions before stepping so rendering can interpolate.
    let stepped = false;
    while (this.accumulator >= FIXED_STEP) {
      if (!stepped) {
        for (let i = 0; i < this.visuals.length; i += 1) {
          const racer = this.director.racers[i]!;
          this.visuals[i]!.previous.set(
            racer.sim.state.x,
            racer.sim.state.y,
            racer.sim.state.z,
          );
        }
        stepped = true;
      }
      this.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
    }

    if (stepped) {
      for (let i = 0; i < this.visuals.length; i += 1) {
        const racer = this.director.racers[i]!;
        this.visuals[i]!.current.set(
          racer.sim.state.x,
          racer.sim.state.y,
          racer.sim.state.z,
        );
      }
    }

    this.render(this.accumulator / FIXED_STEP, elapsed / 1000);
  };

  private step(dt: number): void {
    this.director.setPlayerInput(
      this.input.sample(dt, this.director.player.sim.state.speed),
    );
    this.director.update(dt);

    const countdown = this.director.telemetry.countdown;
    if (
      this.director.currentPhase === "countdown" &&
      countdown !== this.lastCountdownValue
    ) {
      this.lastCountdownValue = countdown;
      if (countdown > 0) this.audio.beep(false);
    } else if (
      this.director.currentPhase === "racing" &&
      this.lastCountdownValue !== 0
    ) {
      this.lastCountdownValue = 0;
      this.audio.beep(true);
    }
  }

  private render(alpha: number, dt: number): void {
    const blend = clamp(alpha, 0, 1);

    for (let i = 0; i < this.visuals.length; i += 1) {
      const visual = this.visuals[i]!;
      const racer = this.director.racers[i]!;
      this.scratch.set(
        lerp(visual.previous.x, visual.current.x, blend),
        lerp(visual.previous.y, visual.current.y, blend),
        lerp(visual.previous.z, visual.current.z, blend),
      );
      visual.view.sync(racer.sim.state, this.scratch);
    }

    const player = this.director.player;
    const car = CARS[player.carId];
    this.camera.update(
      this.renderer.camera,
      player.sim.state,
      car.tuning.maxSpeed,
      dt,
      player.sim.state.y,
    );

    // Follow the player with the shadow frustum so its resolution is spent where
    // the camera is rather than spread over a 2km circuit.
    const sun = this.world.sun;
    if (sun.castShadow) {
      sun.target.position.set(
        player.sim.state.x,
        player.sim.state.y,
        player.sim.state.z,
      );
      sun.target.updateMatrixWorld();
      this.sunPosition
        .set(player.sim.state.x, player.sim.state.y, player.sim.state.z)
        .add(this.sunOffset);
      sun.position.copy(this.sunPosition);
    }

    // Park the sky on the camera. A sky at infinity must not parallax, and keeping
    // it centred is also what guarantees it stays inside the far plane instead of
    // being sliced into a visible arc by it.
    const camera = this.renderer.camera;
    this.world.sky.position.copy(camera.position);

    // Centre the desert horizon on the camera. It is a full ring standing on the
    // ground plane, so unlike the authored chunk it replaced there is no heading
    // to aim it at and no facing to get wrong.
    this.scenery.syncBackdrop(camera.position);

    const state = player.sim.state;
    this.audio.update(
      state.rpm,
      this.director.telemetry.throttle,
      Math.abs(state.slipAngle),
      state.speed,
    );

    this.renderer.render(this.scene);

    // The HUD is DOM, so it is fed a snapshot on an interval instead of being
    // drawn in this frame. Ten copies a second is measurably cheaper than a second
    // GL context, and it keeps React off the render path entirely.
    this.telemetryAccumulator += dt;
    if (this.telemetryAccumulator >= TELEMETRY_INTERVAL_SECONDS) {
      this.telemetryAccumulator %= TELEMETRY_INTERVAL_SECONDS;
      this.bridge.onTelemetry?.(this.snapshot());
    }
  }

  /**
   * A snapshot React can hold on to.
   *
   * Shallow for the scalars, but `standings` has to be copied a level deeper: the
   * director mutates those rows in place every step to avoid allocating inside the
   * fixed step, so a shared reference would mean every snapshot React ever received
   * showed the current order. Six small objects ten times a second.
   */
  private snapshot(): Telemetry {
    const telemetry = this.director.telemetry;
    return {
      ...telemetry,
      standings: telemetry.standings.map((row) => ({ ...row })),
    };
  }

  /** Camera shake and an audible thud on contact. Called by the race shell. */
  registerImpact(severity: number): void {
    this.camera.impulse(severity);
    this.audio.impact(severity);
  }

  // ------------------------------------------------------------------ cleanup

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;

    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;

    this.input.detach();
    this.audio.dispose();
    this.resizeObserver?.disconnect();

    for (const visual of this.visuals) visual.view.dispose();
    this.visuals = [];

    this.circuit.dispose();
    this.scenery.dispose();
    this.disposeWorld();
    this.resources.dispose();
    this.renderer.dispose();
    this.scene.clear();
  }
}
