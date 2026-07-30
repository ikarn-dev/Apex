"use client";

/**
 * Mounts the wallet stack before the profile screen renders.
 *
 * The profile reads `publicKey` and the on-chain driver account, so unlike the
 * campaign or garage it cannot show anything truthful without the chain layer.
 * Waiting one render avoids both a console warning from reading wallet state
 * outside a provider and a flash of "Unsigned" for a connected player.
 */

import { useRequireWallet } from "@/components/providers/WalletBoundary";
import { ProfileScreen } from "./ProfileScreen";

export default function ProfileGate() {
  const ready = useRequireWallet();

  if (!ready) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
        <span className="label">Driver profile</span>
        <div className="mt-4 h-1 w-40 overflow-hidden bg-steel/60">
          <div className="h-full w-1/3 animate-pulse-apex bg-apex" />
        </div>
      </div>
    );
  }

  return <ProfileScreen />;
}

export { ProfileGate };
