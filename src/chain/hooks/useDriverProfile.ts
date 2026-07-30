"use client";

/**
 * Reads the on-chain `DriverProfile` and pushes it into the profile store.
 *
 * Deliberately not a subscription: the profile only changes when the player
 * claims, so it is fetched on connect and after a claim. One less websocket to
 * keep alive during a race.
 */

import { useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { CARS, CAR_IDS } from "@/game/config/cars";
import { LEVEL_IDS, LEVEL_INDEX } from "@/game/config/levels";
import type { LevelId } from "@/game/config/levels";
import type { CarId } from "@/game/config/cars";
import { useProfile } from "@/stores/profile";
import { CHAIN_ENABLED } from "../config";
import { fetchDriverProfile } from "../er/session";
import { clearedLevelIndices } from "../program/state";
import type { DriverProfileAccount } from "../program/state";

function toStoreShape(account: DriverProfileAccount) {
  const bestTimesMs: Partial<Record<LevelId, number>> = {};
  for (const levelId of LEVEL_IDS) {
    const index = LEVEL_INDEX[levelId];
    const value = account.bestTimesMs[index];
    if (value !== undefined && value > 0) bestTimesMs[levelId] = value;
  }

  const clearedIndices = new Set(clearedLevelIndices(account.clearedLevels));
  const clearedLevels = LEVEL_IDS.filter((id) => clearedIndices.has(LEVEL_INDEX[id]));

  const unlockedCars: CarId[] = CAR_IDS.filter(
    (id) => account.xpCommitted >= CARS[id].unlockXp,
  );

  return {
    xpCommitted: account.xpCommitted,
    xpPending: 0,
    racesFinished: account.racesFinished,
    bestTimesMs,
    clearedLevels,
    unlockedCars,
  };
}

export function useDriverProfile() {
  const { publicKey, connected } = useWallet();
  const hydrateFromChain = useProfile((s) => s.hydrateFromChain);
  const resetToLocal = useProfile((s) => s.resetToLocal);
  const setLoading = useProfile((s) => s.setLoading);
  const setError = useProfile((s) => s.setError);
  const setWalletConnected = useProfile((s) => s.setWalletConnected);

  // Guards against a late response from a previous wallet overwriting the
  // current one after a fast disconnect/reconnect.
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!CHAIN_ENABLED || !publicKey) return;
    const token = ++requestRef.current;
    setLoading(true);
    try {
      const account = await fetchDriverProfile(publicKey);
      if (token !== requestRef.current) return;
      if (!account) {
        // No profile yet. Not an error — it is minted with the first race.
        setLoading(false);
        return;
      }
      hydrateFromChain(publicKey.toBase58(), toStoreShape(account));
    } catch (error) {
      if (token !== requestRef.current) return;
      setError(error instanceof Error ? error.message : "Failed to read driver profile");
    }
  }, [publicKey, hydrateFromChain, setLoading, setError]);

  useEffect(() => {
    // Mirror connection state into the store so screens outside the wallet
    // boundary can branch on it without importing the adapter.
    setWalletConnected(connected && publicKey !== null);

    if (!connected || !publicKey) {
      resetToLocal();
      return;
    }
    void refresh();
  }, [connected, publicKey, refresh, resetToLocal, setWalletConnected]);

  return { refresh };
}
