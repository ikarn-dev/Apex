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
 * **Only ever scale down.** When frame time is bad for a sustained window we drop
 * resolution, then quality tier. We never scale back up. Bidirectional scaling
 * oscillates: a device that just recovered gets promoted, immediately falls over
 * again, and the player sees the resolution pump. A one-way ratchet settles.
 */

import type { Scene} from "three";
import {
  ACESFilmicToneMapping,
  PerspectiveCamera,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";
import type { QualitySettings } from "../config/quality";

/** Frame time above which a frame counts as bad, ms. */
const BAD_FRAME_MS = 21;
/** Consecutive bad frames before acting. */
const BAD_FRAME_LIMIT = 45;
/** Lowest resolution multiplier we will fall to. */
const MIN_SCALE = 0.62;
const SCALE_STEP = 0.12;

export interface RendererCallbacks {
  /** Fired when the governor gives up on the current tier. */
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
      // Decay rather than reset: an intermittently bad device should still
      // eventually trip the limit.
      if (this.badFrames > 0) this.badFrames -= 1;
      return;
    }

    this.badFrames += 1;
    if (this.badFrames < BAD_FRAME_LIMIT) return;
    this.badFrames = 0;

    if (this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale - SCALE_STEP);
      this.resize(this.width, this.height);
      return;
    }

    // Out of resolution headroom — the tier itself has to give.
    this.callbacks.onDemoteRequested?.(
      `sustained frame time above ${BAD_FRAME_MS}ms at minimum resolution`,
    );
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
