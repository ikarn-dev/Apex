"use client";

/**
 * Rollup session readout.
 *
 * Always visible during a chain race, because the whole point of the game is
 * that the rollup is doing something and the player should be able to see it.
 * Tick count in particular is the number that makes the argument: watching it
 * climb into the thousands during a drift is the demo.
 */

import { Badge, LiveDot } from "@/components/ui/Panel";
import { useSession } from "@/stores/session";
import { explorerTx } from "@/chain/config";
import { formatNumber, shortenAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

const PHASE_LABEL: Record<string, string> = {
  idle: "No session",
  opening: "Opening session",
  delegating: "Delegating",
  live: "Session live",
  committing: "Committing",
  committed: "Committed",
  settling: "Settling",
  settled: "Settled",
  error: "Session error",
  simulated: "Simulated",
};

export function SessionPanel({ className }: { className?: string }) {
  const phase = useSession((s) => s.phase);
  const ticksLanded = useSession((s) => s.ticksLanded);
  const ticksInFlight = useSession((s) => s.ticksInFlight);
  const ticksDropped = useSession((s) => s.ticksDropped);
  const avgTickMs = useSession((s) => s.avgTickMs);
  const sessionPda = useSession((s) => s.sessionPda);
  const signatures = useSession((s) => s.signatures);
  const error = useSession((s) => s.error);

  if (phase === "idle") return null;

  const live = phase === "live";
  const bad = phase === "error";

  return (
    <div
      className={cn(
        "pointer-events-auto w-[248px] border border-steel bg-void/80 p-3 font-mono backdrop-blur-md",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="label">Ephemeral session</span>
        {live ? <LiveDot tone="lime" /> : null}
      </div>

      <p
        className={cn(
          "mt-1.5 text-[11px] leading-none",
          bad ? "text-ember" : live ? "text-lime" : "text-chalk",
        )}
      >
        {PHASE_LABEL[phase] ?? phase}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-steel pt-2.5 text-[10px]">
        <div>
          <dt className="text-fog">Ticks</dt>
          <dd className="tabular-nums text-chalk">{formatNumber(ticksLanded)}</dd>
        </div>
        <div>
          <dt className="text-fog">In flight</dt>
          <dd className="tabular-nums text-chalk">{ticksInFlight}</dd>
        </div>
        <div>
          <dt className="text-fog">Avg RTT</dt>
          <dd className="tabular-nums text-chalk">
            {avgTickMs > 0 ? `${Math.round(avgTickMs)}ms` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-fog">Dropped</dt>
          <dd
            className={cn(
              "tabular-nums",
              ticksDropped > 0 ? "text-amber" : "text-chalk",
            )}
          >
            {ticksDropped}
          </dd>
        </div>
      </dl>

      {sessionPda ? (
        <p className="mt-2.5 truncate text-[9px] text-fog" title={sessionPda}>
          {shortenAddress(sessionPda, 6)}
        </p>
      ) : null}

      {signatures.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-steel pt-2">
          {signatures.slice(-3).map((sig) => (
            <li key={sig.signature} className="flex items-center gap-1.5 text-[9px]">
              <Badge tone={sig.layer === "base" ? "apex" : "fog"} className="px-1 py-0.5">
                {sig.layer === "base" ? "L1" : "ER"}
              </Badge>
              <a
                href={explorerTx(sig.signature)}
                target="_blank"
                rel="noreferrer"
                className="truncate text-fog hover:text-apex hover:underline"
                title={`${sig.label} — ${sig.signature}`}
              >
                {sig.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="mt-2 border-t border-steel pt-2 text-[9px] leading-relaxed text-ember">
          {error}
        </p>
      ) : null}
    </div>
  );
}
