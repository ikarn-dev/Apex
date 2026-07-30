"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { QualityTier } from "@/game/config/quality";
import type { ControlScheme } from "@/game/types";

interface SettingsState {
  /** `null` means "trust auto-detection". */
  qualityOverride: QualityTier | null;
  controls: ControlScheme | null;
  masterVolume: number;
  sfxEnabled: boolean;
  musicEnabled: boolean;
  showTelemetry: boolean;
  reducedMotion: boolean;
  /** Set once the intro has been seen so returning players skip it. */
  seenIntro: boolean;

  setQuality: (tier: QualityTier | null) => void;
  setControls: (scheme: ControlScheme | null) => void;
  setMasterVolume: (volume: number) => void;
  toggleSfx: () => void;
  toggleMusic: () => void;
  toggleTelemetry: () => void;
  setReducedMotion: (value: boolean) => void;
  markIntroSeen: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      qualityOverride: null,
      controls: null,
      masterVolume: 0.7,
      sfxEnabled: true,
      musicEnabled: true,
      showTelemetry: true,
      reducedMotion: false,
      seenIntro: false,

      setQuality: (tier) => set({ qualityOverride: tier }),
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
      // Actions are recreated on load; only persist the data.
      partialize: (s) => ({
        qualityOverride: s.qualityOverride,
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
