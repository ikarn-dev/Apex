"use client";

/**
 * Race selection and outcome.
 *
 * Only discrete race state lives here. Per-frame values (speed, rpm, slip) are
 * kept in the engine's mutable `Telemetry` object and never enter React — a
 * zustand write at 60Hz would re-render the tree 60 times a second for numbers
 * the Pixi HUD already draws.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CarId } from "@/game/config/cars";
import { DEFAULT_CAR } from "@/game/config/cars";
import { DEFAULT_DRIVER_NAME, sanitiseDriverName } from "@/game/config/drivers";
import type { LevelId } from "@/game/config/levels";
import type { RacePhase, RaceResult, FailureReason } from "@/game/types";

interface RaceState {
  selectedCar: CarId;
  selectedLevel: LevelId | null;
  /**
   * The player's display name.
   *
   * Persisted here and nowhere else. It is not on the chain and it is not sent
   * anywhere: the program identifies a driver by their wallet's `DriverProfile`
   * PDA, so a name is purely a label this browser puts on the leaderboard. That
   * also means it does not survive a change of device, which is the correct
   * trade for something nobody else can see.
   */
  driverName: string;
  /** Practice skips the whole chain lifecycle. */
  practice: boolean;

  phase: RacePhase;
  countdown: number;
  lap: number;
  totalLaps: number;
  position: number;
  totalRacers: number;
  lastLapMs: number;
  bestLapMs: number;
  /** Whether banking is currently offered (Act IV, at a lap line). */
  bankAvailable: boolean;

  result: RaceResult | null;
  failure: FailureReason | null;
  /** Latest story line to display, if any. */
  story: { speaker: string; line: string; at: number } | null;

  selectCar: (car: CarId) => void;
  selectLevel: (level: LevelId | null) => void;
  setDriverName: (name: string) => void;
  setPractice: (practice: boolean) => void;

  setPhase: (phase: RacePhase) => void;
  setCountdown: (value: number) => void;
  setLap: (lap: number, totalLaps: number) => void;
  setPosition: (position: number, totalRacers: number) => void;
  setLapTimes: (lastLapMs: number, bestLapMs: number) => void;
  setBankAvailable: (available: boolean) => void;
  setStory: (speaker: string, line: string) => void;
  clearStory: () => void;
  finish: (result: RaceResult) => void;
  fail: (reason: FailureReason) => void;
  resetRace: () => void;
}

const RACE_RUNTIME_DEFAULTS = {
  phase: "loading" as RacePhase,
  countdown: 0,
  lap: 1,
  totalLaps: 1,
  position: 1,
  totalRacers: 1,
  lastLapMs: 0,
  bestLapMs: 0,
  bankAvailable: false,
  result: null,
  failure: null,
  story: null,
};

export const useRace = create<RaceState>()(
  persist(
    (set) => ({
      selectedCar: DEFAULT_CAR,
      selectedLevel: null,
      driverName: DEFAULT_DRIVER_NAME,
      practice: false,
      ...RACE_RUNTIME_DEFAULTS,

      selectCar: (selectedCar) => set({ selectedCar }),
      selectLevel: (selectedLevel) => set({ selectedLevel }),
      // Sanitised on the way in, not on the way out, so what is persisted is
      // already safe to render into a panel drawn over the race.
      setDriverName: (name) => set({ driverName: sanitiseDriverName(name) }),
      setPractice: (practice) => set({ practice }),

      setPhase: (phase) => set({ phase }),
      setCountdown: (countdown) => set({ countdown }),
      setLap: (lap, totalLaps) => set({ lap, totalLaps }),
      setPosition: (position, totalRacers) => set({ position, totalRacers }),
      setLapTimes: (lastLapMs, bestLapMs) => set({ lastLapMs, bestLapMs }),
      setBankAvailable: (bankAvailable) => set({ bankAvailable }),
      setStory: (speaker, line) => set({ story: { speaker, line, at: Date.now() } }),
      clearStory: () => set({ story: null }),
      finish: (result) => set({ result, phase: "finished", bankAvailable: false }),
      fail: (failure) => set({ failure, phase: "failed", bankAvailable: false }),
      resetRace: () => set({ ...RACE_RUNTIME_DEFAULTS }),
    }),
    {
      name: "apex.race.v1",
      // Only the player's garage/level choice and their name survive a reload.
      partialize: (s) => ({
        selectedCar: s.selectedCar,
        selectedLevel: s.selectedLevel,
        driverName: s.driverName,
      }),
      // `driverName` was added after v1 shipped, so stored state predating it has
      // no such key. Merging over the defaults rather than replacing them is what
      // keeps that from arriving as `undefined` and rendering a blank row.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<RaceState> | undefined),
        driverName: sanitiseDriverName(
          (persisted as Partial<RaceState> | undefined)?.driverName ?? current.driverName,
        ),
      }),
    },
  ),
);
