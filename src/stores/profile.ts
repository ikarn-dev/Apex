"use client";

/**
 * Driver profile.
 *
 * Two sources of truth, deliberately kept distinct so the UI can never imply
 * something settled when it did not:
 *
 * - `chain`  — read from the `DriverProfile` PDA on the base layer.
 * - `local`  — Practice / Simulation mode. Persisted in localStorage, and
 *              labelled as unsettled everywhere it is shown.
 *
 * `pendingRuns` holds finished runs whose commit has not landed yet. They are
 * retryable from the Profile screen, so a dropped transaction costs the player
 * a button press rather than the run.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_CAR, type CarId } from "@/game/config/cars";
import type { LevelId } from "@/game/config/levels";
import type { RaceResult } from "@/game/types";

export type ProfileSource = "chain" | "local";

export interface PendingRun {
  id: string;
  result: RaceResult;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  /**
   * Session nonce, as a decimal string.
   *
   * Needed to re-derive the `RaceSession` PDA when retrying a failed claim, so a
   * dropped transaction costs the player a button press rather than the run.
   * `null` for Practice and Simulation runs, which have no session to claim.
   */
  sessionNonce: string | null;
}

export interface DriverProfileData {
  /** XP settled on the base layer. */
  xpCommitted: number;
  /** XP live in the rollup, not yet settled. */
  xpPending: number;
  racesFinished: number;
  bestTimesMs: Partial<Record<LevelId, number>>;
  clearedLevels: LevelId[];
  unlockedCars: CarId[];
}

interface ProfileState extends DriverProfileData {
  source: ProfileSource;
  /** Base58 pubkey the chain data belongs to, for cache invalidation. */
  owner: string | null;
  /**
   * Whether a wallet is currently connected.
   *
   * Mirrored into the store by `ProfileSync` so menu screens can branch on it
   * without importing `@solana/wallet-adapter-react` — that package, and the
   * web3.js behind it, is 260KB gzip and has no business being in the bundle of
   * a level-select screen.
   */
  walletConnected: boolean;
  loading: boolean;
  error: string | null;
  pendingRuns: PendingRun[];
  setWalletConnected: (connected: boolean) => void;

  /** Replace everything with data read from the chain. */
  hydrateFromChain: (owner: string, data: DriverProfileData) => void;
  /** Drop chain data and fall back to the persisted local profile. */
  resetToLocal: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  /** Credit XP locally (Practice / Simulation mode only). */
  creditLocalXp: (result: RaceResult) => void;
  markLevelCleared: (levelId: LevelId, timeMs: number) => void;

  queuePendingRun: (result: RaceResult, sessionNonce: string | null) => string;
  resolvePendingRun: (id: string, xpCommitted: number) => void;
  failPendingRun: (id: string, error: string) => void;
  dropPendingRun: (id: string) => void;
}

const EMPTY: DriverProfileData = {
  xpCommitted: 0,
  xpPending: 0,
  racesFinished: 0,
  bestTimesMs: {},
  clearedLevels: [],
  unlockedCars: [DEFAULT_CAR],
};

export const useProfile = create<ProfileState>()(
  persist(
    (set, get) => ({
      ...EMPTY,
      source: "local",
      owner: null,
      walletConnected: false,
      loading: false,
      error: null,
      pendingRuns: [],

      setWalletConnected: (walletConnected) => set({ walletConnected }),

      hydrateFromChain: (owner, data) =>
        set({ ...data, owner, source: "chain", loading: false, error: null }),

      resetToLocal: () => set({ source: "local", owner: null, error: null }),

      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error, loading: false }),

      creditLocalXp: (result) =>
        set((s) => {
          const best = s.bestTimesMs[result.levelId];
          return {
            xpCommitted: s.xpCommitted + result.xp.total,
            racesFinished: s.racesFinished + 1,
            bestTimesMs:
              best === undefined || result.totalMs < best
                ? { ...s.bestTimesMs, [result.levelId]: result.totalMs }
                : s.bestTimesMs,
            clearedLevels:
              result.cleared && !s.clearedLevels.includes(result.levelId)
                ? [...s.clearedLevels, result.levelId]
                : s.clearedLevels,
          };
        }),

      markLevelCleared: (levelId, timeMs) =>
        set((s) => {
          const best = s.bestTimesMs[levelId];
          return {
            clearedLevels: s.clearedLevels.includes(levelId)
              ? s.clearedLevels
              : [...s.clearedLevels, levelId],
            bestTimesMs:
              best === undefined || timeMs < best
                ? { ...s.bestTimesMs, [levelId]: timeMs }
                : s.bestTimesMs,
          };
        }),

      queuePendingRun: (result, sessionNonce) => {
        const id = `${result.levelId}-${Date.now().toString(36)}`;
        set((s) => ({
          pendingRuns: [
            ...s.pendingRuns,
            {
              id,
              result,
              createdAt: Date.now(),
              attempts: 0,
              lastError: null,
              sessionNonce,
            },
          ],
          xpPending: s.xpPending + result.xp.total,
        }));
        return id;
      },

      resolvePendingRun: (id, xpCommitted) => {
        const run = get().pendingRuns.find((r) => r.id === id);
        set((s) => ({
          pendingRuns: s.pendingRuns.filter((r) => r.id !== id),
          xpCommitted,
          xpPending: Math.max(0, s.xpPending - (run?.result.xp.total ?? 0)),
          racesFinished: s.racesFinished + 1,
        }));
      },

      failPendingRun: (id, error) =>
        set((s) => ({
          pendingRuns: s.pendingRuns.map((r) =>
            r.id === id ? { ...r, attempts: r.attempts + 1, lastError: error } : r,
          ),
        })),

      dropPendingRun: (id) => {
        const run = get().pendingRuns.find((r) => r.id === id);
        set((s) => ({
          pendingRuns: s.pendingRuns.filter((r) => r.id !== id),
          xpPending: Math.max(0, s.xpPending - (run?.result.xp.total ?? 0)),
        }));
      },
    }),
    {
      name: "apex.profile.v1",
      // Chain-sourced values are never persisted — they are re-read on connect,
      // so a stale cache can never masquerade as settled state.
      partialize: (s) =>
        s.source === "local"
          ? {
              xpCommitted: s.xpCommitted,
              racesFinished: s.racesFinished,
              bestTimesMs: s.bestTimesMs,
              clearedLevels: s.clearedLevels,
              unlockedCars: s.unlockedCars,
              pendingRuns: s.pendingRuns,
            }
          : { pendingRuns: s.pendingRuns },
    },
  ),
);

/** Total XP for gating purposes: settled plus in-flight. */
export function useTotalXp(): number {
  return useProfile((s) => s.xpCommitted + s.xpPending);
}
