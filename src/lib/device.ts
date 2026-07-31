/**
 * Device capability probing.
 *
 * APEX is a desktop build, so this only has to separate a weak integrated GPU
 * from a discrete one. Everything here is best-effort and guarded: `deviceMemory`
 * is Chromium-only and the GPU renderer string is often masked. The result is a
 * starting guess that the runtime frame-time governor then corrects.
 */

import type { QualityTier } from "@/game/config/quality";

export interface DeviceProfile {
  /** GB, or null when the browser does not report it. */
  memoryGb: number | null;
  cores: number;
  pixelRatio: number;
  /** Unmasked GPU string when available. */
  gpu: string | null;
  hasWebGL2: boolean;
  prefersReducedMotion: boolean;
}

const SERVER_PROFILE: DeviceProfile = {
  memoryGb: null,
  cores: 4,
  pixelRatio: 1,
  gpu: null,
  hasWebGL2: true,
  prefersReducedMotion: false,
};

let cached: DeviceProfile | null = null;

function readGpu(): { gpu: string | null; hasWebGL2: boolean } {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return { gpu: null, hasWebGL2: false };
    const hasWebGL2 =
      typeof WebGL2RenderingContext !== "undefined" &&
      gl instanceof WebGL2RenderingContext;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = ext
      ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string | null)
      : null;
    // Free the probe context immediately; browsers cap simultaneous contexts.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { gpu, hasWebGL2 };
  } catch {
    return { gpu: null, hasWebGL2: false };
  }
}

export function getDeviceProfile(): DeviceProfile {
  if (typeof window === "undefined") return SERVER_PROFILE;
  if (cached) return cached;

  const { gpu, hasWebGL2 } = readGpu();

  cached = {
    memoryGb:
      typeof (navigator as { deviceMemory?: number }).deviceMemory === "number"
        ? (navigator as { deviceMemory?: number }).deviceMemory!
        : null,
    cores: navigator.hardwareConcurrency || 4,
    pixelRatio: window.devicePixelRatio || 1,
    gpu,
    hasWebGL2,
    prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches,
  };
  return cached;
}

const WEAK_GPU = /(intel.*(hd|uhd) graphics (5|6)|intel.*gma|microsoft basic render|llvmpipe|swiftshader)/i;

/**
 * Initial tier. High unless the device gives a concrete reason to think otherwise.
 *
 * This used to score upward from zero and needed +2 to reach `high`, which in
 * practice meant a *recognised* strong GPU string. Browsers mask
 * `WEBGL_debug_renderer_info` by default and `deviceMemory` is Chromium-only, so on
 * Safari and Firefox the GPU came back `null`, the memory came back `null`, and
 * every machine — including an M-series Mac that runs this at 120fps — landed on
 * `medium`. Defaulting to the tier almost every desktop can actually hold, and
 * demoting only on evidence, is the right way round.
 *
 * The evidence has to be specific: no WebGL2 at all, a GPU string that names a
 * known-weak part or a software rasteriser, 2GB of RAM, or two cores.
 */
export function detectQualityTier(profile = getDeviceProfile()): QualityTier {
  if (!profile.hasWebGL2) return "low";
  if (profile.gpu && WEAK_GPU.test(profile.gpu)) return "low";
  if (profile.memoryGb !== null && profile.memoryGb <= 2) return "low";
  if (profile.cores <= 2) return "low";

  // Borderline: enough to run, not enough to assume the top tier.
  if (profile.memoryGb !== null && profile.memoryGb <= 4) return "medium";
  if (profile.cores <= 4) return "medium";

  return "high";
}
