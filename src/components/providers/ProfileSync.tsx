"use client";

import { useDriverProfile } from "@/chain/hooks/useDriverProfile";

/**
 * Headless. Keeps the driver profile in step with the connected wallet for the
 * whole app, so no screen has to remember to fetch it.
 */
export function ProfileSync() {
  useDriverProfile();
  return null;
}
