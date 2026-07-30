"use client";

/**
 * Loads the wallet stack on demand.
 *
 * Measured problem: `@solana/web3.js` is 226KB gzip and the wallet adapter
 * another 34KB. Mounting the provider tree in the root layout put all of it on
 * the critical path of every route — 457KB gzip to read the landing page, on a
 * game that is meant to work on a phone.
 *
 * So the provider tree is only mounted when it is actually needed:
 *
 *   - a returning player whose wallet the adapter remembers (autoConnect still
 *     works, which is the point of remembering),
 *   - anyone who presses Connect,
 *   - any route that cannot function without it, which calls `useRequireWallet`.
 *
 * `useWallet()` outside a provider returns a well-defined disconnected value, so
 * components read the correct "not connected" state in the meantime rather than
 * crashing.
 *
 * The trade: activating changes the element type above `children`, so React
 * remounts the subtree. That is fine on a menu screen (state lives in zustand)
 * and would not be fine mid-race, which is exactly why the race route activates
 * eagerly before the engine mounts.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";

/** The key `@solana/wallet-adapter-react` uses to remember a selection. */
const REMEMBERED_WALLET_KEY = "walletName";

interface WalletBoundaryValue {
  /** True once the real provider tree is mounted. */
  active: boolean;
  /** Mount the provider tree. Idempotent. */
  activate: () => void;
}

const WalletBoundaryContext = createContext<WalletBoundaryValue>({
  active: false,
  activate: () => {},
});

export function useWalletBoundary(): WalletBoundaryValue {
  return useContext(WalletBoundaryContext);
}

/**
 * Ensures the wallet stack is mounted. Call from any route that needs it.
 *
 * Returns whether it is ready, so callers can hold off on chain work for the one
 * render it takes to arrive.
 */
export function useRequireWallet(): boolean {
  const { active, activate } = useWalletBoundary();
  useEffect(() => {
    if (!active) activate();
  }, [active, activate]);
  return active;
}

function subscribeToNothing(): () => void {
  return () => {};
}

/** Whether the adapter has a wallet remembered from a previous visit. */
function hasRememberedWallet(): boolean {
  try {
    return localStorage.getItem(REMEMBERED_WALLET_KEY) !== null;
  } catch {
    return false;
  }
}

type ProviderComponent = ComponentType<{ children: ReactNode }>;

export function WalletBoundary({ children }: { children: ReactNode }) {
  // Read through an external store so the server renders `false` and the client
  // agrees on the hydration pass, without a setState inside an effect.
  const remembered = useSyncExternalStore(
    subscribeToNothing,
    hasRememberedWallet,
    () => false,
  );

  const [requested, setRequested] = useState(false);
  const [Providers, setProviders] = useState<ProviderComponent | null>(null);

  const activate = useCallback(() => setRequested(true), []);
  const wanted = remembered || requested;

  useEffect(() => {
    if (!wanted || Providers) return;
    let cancelled = false;
    void import("./WalletProviders").then((module) => {
      // `setProviders(fn)` would treat the component as an updater function, so
      // it has to be wrapped.
      if (!cancelled) setProviders(() => module.WalletProviders);
    });
    return () => {
      cancelled = true;
    };
  }, [wanted, Providers]);

  const value: WalletBoundaryValue = { active: Providers !== null, activate };

  return (
    <WalletBoundaryContext.Provider value={value}>
      {Providers ? <Providers>{children}</Providers> : children}
    </WalletBoundaryContext.Provider>
  );
}
