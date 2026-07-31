/**
 * Renderer and the adaptive resolution governor.
 *
 * Two ideas here.
 *
 * **Clamp the pixel ratio.** A modern phone reports devicePixelRatio 3, which
 * means rendering nine times the pixels of a CSS-pixel buffer. No mobile GPU can
 * push a 3D scene at that resolution and hold 60fps, and the visual difference at
 * arm's length is slight. The tier caps it at 1.0-1.5.
 *
 * **Only ever scale down, and only when it is really needed.** A sustained 25fps
 * softens the resolution as far as 75%; nothing here changes the quality tier any
 * more. We never scale back up either, because bidirectional scaling oscillates: a
 * device that just recovered gets promoted, immediately falls over again, and the
 * player watches the resolution pump.
 *
 * The thresholds used to be far more eager — a 21ms frame counted as bad, which is
 * 58fps — so a machine holding 60fps with ordinary jitter was quietly downgraded
 * mid-race, tier and all. Protecting a weak device is worth a softer image; taking
 * shadows and draw distance away from a capable one is not.
 */

import type { Scene} from "three";
import {
  ACESFilmicToneMapping,
  PerspectiveCamera,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";
import type { QualitySettings } from "../config/quality";

/**
 * Frame time above which a frame counts as bad, ms.
 *
 * 40ms is 25fps — genuinely unplayable, not merely short of 60. This was 21ms,
 * which is a *58fps* frame: any machine holding a normal 60fps with the usual
 * scheduling jitter tripped it constantly, so the governor spent races quietly
 * dropping resolution and then the quality tier on hardware that was running fine.
 * That is what "the fps drops on its own" looked like from the driver's seat.
 */
const BAD_FRAME_MS = 40;
/** Bad frames before acting. At 25fps this is about three seconds of them. */
const BAD_FRAME_LIMIT = 75;
/** Lowest resolution multiplier we will fall to. */
const MIN_SCALE = 0.75;
const SCALE_STEP = 0.12;

export interface RendererCallbacks {
  /**
   * Fired when the governor gives up on the current tier.
   *
   * Retained as the escape hatch for a device that genuinely cannot cope, but
   * `observeFrame` no longer raises it: an automatic mid-race tier change is more
   * disruptive than the frame rate it is trying to protect. The tier is chosen once,
   * up front, by `lib/device`.
   */
  onDemoteRequested?: (reason: string) => void;
}

export class Renderer {
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;

  private scale = 1;
  private badFrames = 0;
  private quality: QualitySettings;
  private width = 1;
  private height = 1;
  private contextLost = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    quality: QualitySettings,
    private readonly callbacks: RendererCallbacks = {},
  ) {
    this.quality = quality;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: quality.antialias,
      // A racing game never composites with the page behind it, and an opaque
      // buffer is measurably cheaper.
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });

    // Daylight clear colour, matching the scene's haze so the horizon is seamless.
    this.renderer.setClearColor(0xcfe2e9, 1);
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Filmic tone mapping: a bright sky plus a sun bright enough to light car
    // paint clips badly without it, and clipped highlights read as flat grey.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = quality.shadowMapSize > 0;
    this.renderer.shadowMap.autoUpdate = quality.shadowMapSize > 0;

    this.camera = new PerspectiveCamera(62, 1, 0.4, quality.drawDistance);

    canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.renderer.shadowMap.enabled = quality.shadowMapSize > 0;
    this.renderer.shadowMap.autoUpdate = quality.shadowMapSize > 0;
    this.camera.far = quality.drawDistance;
    this.camera.updateProjectionMatrix();
    // A tier change resets the resolution ladder; the new tier deserves a
    // fair first look at full resolution.
    this.scale = 1;
    this.badFrames = 0;
    this.resize(this.width, this.height);
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.width = Math.max(1, cssWidth);
    this.height = Math.max(1, cssHeight);

    const dpr = Math.min(
      typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
      this.quality.maxPixelRatio,
    );

    this.renderer.setPixelRatio(dpr * this.scale);
    this.renderer.setSize(this.width, this.height, false);

    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  render(scene: Scene): void {
    if (this.contextLost) return;
    this.renderer.render(scene, this.camera);
  }

  /**
   * Feed the governor. Call once per rendered frame with the measured frame
   * time.
   */
  observeFrame(frameMs: number): void {
    if (frameMs <= BAD_FRAME_MS) {
      // Decay faster than it accumulates, so a couple of stutters — a shader
      // compile, a garbage collection, the tab being backgrounded — cannot add up
      // over a whole race into a downgrade the player never needed.
      if (this.badFrames > 0) this.badFrames -= 2;
      return;
    }

    this.badFrames += 1;
    if (this.badFrames < BAD_FRAME_LIMIT) return;
    this.badFrames = 0;

    // Resolution only, and only down to 75%. The tier is left alone deliberately:
    // demoting it swaps shadow maps, rival count and draw distance mid-race, which
    // is far more visible than a slightly softer image and is not something to do
    // to a player who never asked for it. A device that cannot hold 25fps at 75%
    // resolution needs a lower tier chosen up front, not during a race.
    if (this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale - SCALE_STEP);
      this.resize(this.width, this.height);
    }
  }

  get resolutionScale(): number {
    return this.scale;
  }

  get info(): { calls: number; triangles: number } {
    const render = this.renderer.info.render;
    return { calls: render.calls, triangles: render.triangles };
  }

  private readonly onContextLost = (event: Event): void => {
    // Preventing the default is what allows a restore to happen at all.
    event.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.resize(this.width, this.height);
  };

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.renderer.dispose();
  }
}
