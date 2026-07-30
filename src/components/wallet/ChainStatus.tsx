"use client";

/**
 * Chain status strip.
 *
 * Deliberately blunt about which mode the game is in. If the program is not
 * deployed or the rollup is unreachable, the player is told that their XP is
 * local — the alternative, silently pretending a run settled, is the one
 * behaviour a game with an on-chain score can never have.
 *
 * The live variant probes the rollup, which means an RPC connection, which means
 * web3.js. So it is only rendered once the wallet stack is mounted; until then
 * this shows the static truth, which is that the player is in Practice mode.
 * That keeps 226KB off the landing page without hiding anything from them.
 */

import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/Panel";
import { useWalletBoundary } from "@/components/providers/WalletBoundary";
import { CHAIN_ENABLED, CLUSTER } from "@/chain/config";
import { cn } from "@/lib/cn";

/**
 * Dynamic, not a plain import.
 *
 * A static `import { LiveChainStatus }` would put web3.js in this module's chunk
 * whether or not the branch below ever renders it — measured at +212KB gzip on
 * the landing page. Conditional rendering does not split a bundle; a dynamic
 * import does.
 */
const LiveChainStatus = dynamic(
  () => import("./LiveChainStatus").then((m) => m.LiveChainStatus),
  { ssr: false },
);

export function ChainStatus({ className }: { className?: string }) {
  const { active } = useWalletBoundary();

  if (!CHAIN_ENABLED) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)}>
        <Badge tone="amber">Simulation mode</Badge>
        <span className="text-[10px] leading-tight text-fog">
          No program deployed — XP is stored locally and cannot be settled.
        </span>
      </div>
    );
  }

  if (!active) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)}>
        <Badge tone="fog">
          <span className="text-chalk">L1</span> {CLUSTER}
        </Badge>
        <Badge tone="amber">Practice — wallet not connected</Badge>
      </div>
    );
  }

  return <LiveChainStatus className={className} />;
}
