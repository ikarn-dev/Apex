"use client";

import { useSyncExternalStore } from "react";

/** No-op subscribe: the value never changes after the first client render. */
function subscribe(): () => void {
  return () => {};
}

/**
 * `true` once running on the client, `false` during server render and the
 * hydration pass.
 *
 * `useSyncExternalStore` rather than the usual `useState(false)` +
 * `useEffect(() => setMounted(true))`: it gets the same result without a
 * setState during an effect, so it does not trigger the cascading render that
 * React's lint rules (correctly) flag.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
