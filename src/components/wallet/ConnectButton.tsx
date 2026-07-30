"use client";

/**
 * Wallet connect control.
 *
 * Wraps the adapter's modal rather than reimplementing wallet discovery, but
 * renders our own trigger so the design language holds. This is the only sign-in
 * affordance in the app — there is no email or social path to fall back to.
 *
 * Before the wallet stack is mounted this is a plain button whose only job is to
 * ask `WalletBoundary` to load it; see that file for why the 260KB of Solana
 * libraries are not on every route. Once mounted, `LiveConnectButton` takes over.
 */

import dynamic from "next/dynamic";
import { Button } from "@/components/ui/Button";
import { useWalletBoundary } from "@/components/providers/WalletBoundary";
import { useHydrated } from "@/hooks/useHydrated";

/** Dynamic for the same reason as `LiveChainStatus` — see that file. */
const LiveConnectButton = dynamic(
  () => import("./LiveConnectButton").then((m) => m.LiveConnectButton),
  { ssr: false },
);

export function ConnectButton({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const { active, activate } = useWalletBoundary();
  // The adapter reads browser globals, so the first client render must match the
  // server's. A stable placeholder until hydration avoids the mismatch.
  const hydrated = useHydrated();

  if (!hydrated) {
    return (
      <Button variant="secondary" size={size} className={className} disabled>
        Connect
      </Button>
    );
  }

  if (!active) {
    return (
      <Button variant="primary" size={size} className={className} onClick={activate}>
        Connect Wallet
      </Button>
    );
  }

  return <LiveConnectButton className={className} size={size} />;
}
