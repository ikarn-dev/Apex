"use client";

import { useSyncExternalStore } from "react";
import { getDeviceProfile, type DeviceProfile } from "@/lib/device";

function subscribe(): () => void {
  return () => {};
}

/**
 * The device profile, or `null` during server render.
 *
 * Safe as an external store because `getDeviceProfile` caches: it returns the
 * same object on every call, so `getSnapshot` is referentially stable and React
 * will not loop.
 */
export function useDeviceProfile(): DeviceProfile | null {
  return useSyncExternalStore<DeviceProfile | null>(
    subscribe,
    getDeviceProfile,
    () => null,
  );
}
