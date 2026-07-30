"use client";

/**
 * Live layer status — probes the rollup for real.
 *
 * Split from `ChainStatus` so the RPC imports (and therefore web3.js) are only
 * reachable from inside the `WalletBoundary`.
 */

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Badge, LiveDot } from "@/components/ui/Panel";
import { CLUSTER } from "@/chain/config";
import { erEndpointLabel, probeEr } from "@/chain/er/connections";
import { cn } from "@/lib/cn";

type ErState = "checking" | "online" | "offline";

export function LiveChainStatus({ className }: { className?: string }) {
  const { connected } = useWallet();
  const [er, setEr] = useState<ErState>("checking");

  useEffect(() => {
    let cancelled = false;
    void probeEr().then((ok) => {
      if (!cancelled) setEr(ok ? "online" : "offline");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Badge tone="fog">
        <span className="text-chalk">L1</span> {CLUSTER}
      </Badge>
      <Badge tone={er === "online" ? "lime" : er === "checking" ? "fog" : "ember"}>
        {er === "online" ? <LiveDot tone="lime" /> : null}
        <span className="text-chalk">ER</span>{" "}
        {er === "checking"
          ? "probing…"
          : er === "online"
            ? erEndpointLabel()
            : "unreachable"}
      </Badge>
      {!connected ? <Badge tone="amber">Practice — wallet not connected</Badge> : null}
    </div>
  );
}
