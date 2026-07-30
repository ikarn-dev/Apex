"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Badge, LiveDot, Meter, Panel, PanelHeader, Stat } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { ChainStatus } from "@/components/wallet/ChainStatus";
import { CAMPAIGN_ORDER, LEVELS, LEVEL_IDS } from "@/game/config/levels";
import { CARS, CAR_IDS } from "@/game/config/cars";
import { RANKS, nextRank, rankForXp, rankProgress } from "@/game/config/progression";
import { useProfile } from "@/stores/profile";
import { useClaimRun } from "@/chain/hooks/useClaimRun";
import { useDriverProfile } from "@/chain/hooks/useDriverProfile";
import { CHAIN_ENABLED, explorerAddress } from "@/chain/config";
import { formatLapTime, formatNumber, shortenAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

export function ProfileScreen() {
  const { publicKey, connected } = useWallet();
  const { refresh } = useDriverProfile();
  const { claim, discard, canClaim } = useClaimRun();

  const xpCommitted = useProfile((s) => s.xpCommitted);
  const xpPending = useProfile((s) => s.xpPending);
  const racesFinished = useProfile((s) => s.racesFinished);
  const bestTimesMs = useProfile((s) => s.bestTimesMs);
  const clearedLevels = useProfile((s) => s.clearedLevels);
  const pendingRuns = useProfile((s) => s.pendingRuns);
  const source = useProfile((s) => s.source);
  const loading = useProfile((s) => s.loading);
  const error = useProfile((s) => s.error);

  const [busyRun, setBusyRun] = useState<string | null>(null);

  const rank = rankForXp(xpCommitted);
  const upcoming = nextRank(xpCommitted);
  const progress = rankProgress(xpCommitted);

  const handleClaim = async (runId: string, nonce: string | null) => {
    setBusyRun(runId);
    await claim(runId, nonce);
    await refresh();
    setBusyRun(null);
  };

  const handleDiscard = async (runId: string, nonce: string | null) => {
    setBusyRun(runId);
    await discard(runId, nonce);
    setBusyRun(null);
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="label">Driver profile</span>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
            {connected && publicKey ? shortenAddress(publicKey.toBase58(), 6) : "Unsigned"}
          </h1>
          <p className="mt-2 text-xs text-fog">
            {source === "chain"
              ? "Read from your DriverProfile account on Solana."
              : "Local profile. Nothing here has been settled."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Reading…" : "Refresh"}
            </Button>
          ) : null}
          <ConnectButton size="sm" />
        </div>
      </header>

      <ChainStatus className="mt-6" />

      {error ? (
        <Panel className="mt-6 border-ember/40 p-4">
          <p className="text-xs text-ember">{error}</p>
        </Panel>
      ) : null}

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <Panel className="p-5 lg:col-span-2">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <span className="label">Rank</span>
              <p
                className="mt-1.5 font-display text-4xl font-bold leading-none"
                style={{ color: rank.cssAccent }}
              >
                {rank.name}
              </p>
            </div>
            <div className="text-right">
              <span className="label">Settled XP</span>
              <p className="mt-1.5 font-mono text-3xl leading-none tabular-nums text-chalk">
                {formatNumber(xpCommitted)}
              </p>
              {xpPending > 0 ? (
                <p className="mt-1 font-mono text-xs tabular-nums text-amber">
                  +{formatNumber(xpPending)} pending
                </p>
              ) : null}
            </div>
          </div>

          <Meter value={progress} className="mt-5" />
          <p className="mt-2 text-[10px] text-fog">
            {upcoming
              ? `${formatNumber(upcoming.xp - xpCommitted)} XP to ${upcoming.name}`
              : "Top rank reached."}
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-steel pt-5 sm:grid-cols-4">
            <Stat label="Races" value={formatNumber(racesFinished)} />
            <Stat
              label="Cleared"
              value={`${clearedLevels.length}/${CAMPAIGN_ORDER.length}`}
            />
            <Stat
              label="Cars"
              value={`${CAR_IDS.filter((id) => xpCommitted >= CARS[id].unlockXp).length}/${CAR_IDS.length}`}
            />
            <Stat
              label="Source"
              value={source === "chain" ? "On-chain" : "Local"}
              tone={source === "chain" ? "lime" : "amber"}
            />
          </dl>
        </Panel>

        <Panel className="p-0">
          <PanelHeader label="Rank ladder" />
          <ul className="divide-y divide-steel">
            {RANKS.map((tier) => {
              const reached = xpCommitted >= tier.xp;
              return (
                <li
                  key={tier.id}
                  className={cn(
                    "flex items-center justify-between gap-3 px-4 py-3",
                    !reached && "opacity-50",
                  )}
                >
                  <div>
                    <p
                      className="font-mono text-[11px] uppercase tracking-[0.16em]"
                      style={{ color: tier.cssAccent }}
                    >
                      {tier.name}
                    </p>
                    <p className="mt-0.5 text-[10px] text-fog">
                      {tier.unlocks.join(" · ")}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-fog">
                    {formatNumber(tier.xp)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      {pendingRuns.length > 0 ? (
        <Panel className="mt-8 p-0">
          <PanelHeader
            label="Unsettled runs"
            action={
              <Badge tone="amber">
                <LiveDot tone="amber" />
                {pendingRuns.length}
              </Badge>
            }
          />
          <div className="px-4 py-3">
            <p className="text-[11px] leading-relaxed text-fog">
              These runs finished but their XP never reached the Settlement Layer.
              The state is still in the session account, so a retry is all that is
              needed. Discarding closes the session and forfeits the XP.
            </p>
          </div>
          <ul className="divide-y divide-steel">
            {pendingRuns.map((run) => {
              const level = LEVELS[run.result.levelId];
              const busy = busyRun === run.id;
              return (
                <li key={run.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs text-chalk">
                      {level.actLabel} · {level.title}
                    </p>
                    <p className="mt-1 font-mono text-[10px] tabular-nums text-fog">
                      {formatLapTime(run.result.totalMs)} · P{run.result.position} ·{" "}
                      {formatNumber(run.result.xp.total)} XP · {run.result.ticks} ticks
                    </p>
                    {run.lastError ? (
                      <p className="mt-1 truncate text-[10px] text-ember" title={run.lastError}>
                        {run.lastError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy || !canClaim || run.sessionNonce === null}
                      onClick={() => void handleClaim(run.id, run.sessionNonce)}
                    >
                      {busy ? "Claiming…" : "Claim"}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleDiscard(run.id, run.sessionNonce)}
                    >
                      Discard
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}

      <Panel className="mt-8 p-0">
        <PanelHeader label="Best times" />
        <ul className="divide-y divide-steel">
          {LEVEL_IDS.map((id) => {
            const level = LEVELS[id];
            const best = bestTimesMs[id];
            const cleared = clearedLevels.includes(id);
            return (
              <li key={id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-chalk">
                    <span className="text-fog">{level.actLabel}</span> {level.title}
                  </p>
                  <p className="mt-0.5 text-[10px] text-fog">
                    Par {formatLapTime(level.parMs)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {cleared ? <Badge tone="lime">Cleared</Badge> : null}
                  <span
                    className={cn(
                      "font-mono text-xs tabular-nums",
                      best && best < level.parMs ? "text-lime" : "text-chalk",
                    )}
                  >
                    {best ? formatLapTime(best) : "--:--.---"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      {connected && publicKey && CHAIN_ENABLED ? (
        <p className="mt-6 text-[10px] text-fog">
          <a
            href={explorerAddress(publicKey.toBase58())}
            target="_blank"
            rel="noreferrer"
            className="text-apex hover:underline"
          >
            View wallet on Solana Explorer
          </a>
        </p>
      ) : null}
    </div>
  );
}
