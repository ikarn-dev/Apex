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
const STRONG_GPU = /(rtx|radeon rx|arc a[0-9]|apple m[1-9]|geforce gtx 1[0-9]{3})/i;

/** Initial tier guess before any frames have been measured. */
export function detectQualityTier(profile = getDeviceProfile()): QualityTier {
  if (!profile.hasWebGL2) return "low";

  let score = 0;

  if (profile.gpu) {
    if (WEAK_GPU.test(profile.gpu)) score -= 3;
    else if (STRONG_GPU.test(profile.gpu)) score += 2;
  }

  if (profile.memoryGb !== null) {
    if (profile.memoryGb <= 2) score -= 3;
    else if (profile.memoryGb <= 4) score -= 1;
    else if (profile.memoryGb >= 8) score += 1;
  }

  if (profile.cores <= 2) score -= 2;
  else if (profile.cores >= 8) score += 1;

  if (score >= 2) return "high";
  if (score >= -1) return "medium";
  return "low";
}
