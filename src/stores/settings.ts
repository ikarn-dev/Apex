"use client";

/**
 * Persisted player settings.
 *
 * Graphics quality is deliberately **not** here. It is detected from the device
 * and then owned by the runtime governor, which may only ever demote — see
 * `game/config/quality`. Letting a player pin a tier fought that governor: they
 * could select HIGH on hardware that could not hold it, and the only thing the
 * frame-time watchdog is allowed to do is step down, so the setting either did
 * nothing or produced a permanently stuttering race. Removing the choice makes
 * the automatic path the only path.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ControlScheme } from "@/game/types";

/**
 * Bumped whenever the persisted shape changes.
 *
 * v2 dropped `qualityOverride`. Without a matching `migrate`, zustand finds a
 * version it does not recognise, logs "State loaded from storage couldn't be
 * migrated", and silently discards every other saved setting with it — so the
 * player loses their volume and controls for an unrelated change.
 */
const SETTINGS_VERSION = 2;

interface SettingsState {
  controls: ControlScheme | null;
  masterVolume: number;
  sfxEnabled: boolean;
  musicEnabled: boolean;
  showTelemetry: boolean;
  reducedMotion: boolean;
  /** Set once the intro has been seen so returning players skip it. */
  seenIntro: boolean;

  setControls: (scheme: ControlScheme | null) => void;
  setMasterVolume: (volume: number) => void;
  toggleSfx: () => void;
  toggleMusic: () => void;
  toggleTelemetry: () => void;
  setReducedMotion: (value: boolean) => void;
  markIntroSeen: () => void;
}

type PersistedSettings = Pick<
  SettingsState,
  | "controls"
  | "masterVolume"
  | "sfxEnabled"
  | "musicEnabled"
  | "showTelemetry"
  | "reducedMotion"
  | "seenIntro"
>;

const DEFAULTS: PersistedSettings = {
  controls: null,
  masterVolume: 0.7,
  sfxEnabled: true,
  musicEnabled: true,
  showTelemetry: true,
  reducedMotion: false,
  seenIntro: false,
};

/**
 * Carry forward what is still recognised and fall back to defaults for the rest.
 *
 * Field-by-field rather than a spread, so an unknown key from an older build —
 * `qualityOverride`, or anything a future version drops — cannot survive into the
 * live store, and a corrupted value cannot either.
 */
function migrate(persisted: unknown): PersistedSettings {
  if (typeof persisted !== "object" || persisted === null) return { ...DEFAULTS };
  const saved = persisted as Partial<PersistedSettings>;

  const volume =
    typeof saved.masterVolume === "number" && Number.isFinite(saved.masterVolume)
      ? Math.min(1, Math.max(0, saved.masterVolume))
      : DEFAULTS.masterVolume;

  const bool = (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback;

  return {
    controls:
      saved.controls === "keyboard" || saved.controls === "gamepad"
        ? saved.controls
        : DEFAULTS.controls,
    masterVolume: volume,
    sfxEnabled: bool(saved.sfxEnabled, DEFAULTS.sfxEnabled),
    musicEnabled: bool(saved.musicEnabled, DEFAULTS.musicEnabled),
    showTelemetry: bool(saved.showTelemetry, DEFAULTS.showTelemetry),
    reducedMotion: bool(saved.reducedMotion, DEFAULTS.reducedMotion),
    seenIntro: bool(saved.seenIntro, DEFAULTS.seenIntro),
  };
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,

      setControls: (scheme) => set({ controls: scheme }),
      setMasterVolume: (volume) =>
        set({ masterVolume: Math.min(1, Math.max(0, volume)) }),
      toggleSfx: () => set((s) => ({ sfxEnabled: !s.sfxEnabled })),
      toggleMusic: () => set((s) => ({ musicEnabled: !s.musicEnabled })),
      toggleTelemetry: () => set((s) => ({ showTelemetry: !s.showTelemetry })),
      setReducedMotion: (value) => set({ reducedMotion: value }),
      markIntroSeen: () => set({ seenIntro: true }),
    }),
    {
      name: "apex.settings.v1",
      version: SETTINGS_VERSION,
      migrate,
      // Actions are recreated on load; only persist the data.
      partialize: (s): PersistedSettings => ({
        controls: s.controls,
        masterVolume: s.masterVolume,
        sfxEnabled: s.sfxEnabled,
        musicEnabled: s.musicEnabled,
        showTelemetry: s.showTelemetry,
        reducedMotion: s.reducedMotion,
        seenIntro: s.seenIntro,
      }),
    },
  ),
);
