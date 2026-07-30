"use client";

import { useProfile } from "@/stores/profile";
import { rankForXp } from "@/game/config/progression";
import { formatCompact } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * Header XP readout.
 *
 * Shows settled and pending XP as visibly different things. A single merged
 * number would be a lie: pending XP lives in the rollup and evaporates if a run
 * is never committed.
 */
export function XpPill({ className }: { className?: string }) {
  const xpCommitted = useProfile((s) => s.xpCommitted);
  const xpPending = useProfile((s) => s.xpPending);
  const source = useProfile((s) => s.source);
  const rank = rankForXp(xpCommitted);

  return (
    <div
      className={cn(
        "flex items-center gap-2 border border-steel px-2.5 py-1.5 font-mono text-[10px] leading-none",
        className,
      )}
      title={
        source === "chain"
          ? "Settled on Solana"
          : "Local only — connect a wallet to settle XP on-chain"
      }
    >
      <span
        className="uppercase tracking-[0.16em]"
        style={{ color: rank.cssAccent }}
      >
        {rank.name}
      </span>
      <span className="text-steel" aria-hidden="true">
        |
      </span>
      <span className="tabular-nums text-chalk">{formatCompact(xpCommitted)}</span>
      {xpPending > 0 ? (
        <span className="tabular-nums text-amber" title="Pending in the rollup">
          +{formatCompact(xpPending)}
        </span>
      ) : null}
      {source === "local" ? (
        <span className="hidden text-fog sm:inline" aria-label="local only">
          local
        </span>
      ) : null}
    </div>
  );
}
