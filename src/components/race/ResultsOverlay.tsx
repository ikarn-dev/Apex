"use client";

/**
 * Post-race results and settlement.
 *
 * The XP breakdown is shown term by term on purpose. The player just spent three
 * minutes earning a number that is about to be written to a public ledger; they
 * should be able to see exactly how it was derived, and it is the same formula
 * the program runs, so nothing here can disagree with what gets committed.
 */

import { Badge, Panel, PanelHeader } from "@/components/ui/Panel";
import { Button, ButtonLink } from "@/components/ui/Button";
import type { LevelDefinition } from "@/game/config/levels";
import type { RaceResult, FailureReason } from "@/game/types";
import { RISK_PER_DEFERRED_LAP, XP_PER_CONTACT } from "@/game/scoring/xp";
import { useSession } from "@/stores/session";
import { explorerTx } from "@/chain/config";
import { formatLapTime, formatNumber, formatOrdinal } from "@/lib/format";
import { cn } from "@/lib/cn";

export type SettleState =
  | "idle"
  | "settling"
  | "claiming"
  | "settled"
  | "error"
  | "unavailable";

const FAILURE_COPY: Record<FailureReason, { title: string; body: string }> = {
  retired: {
    title: "Flatline",
    body: "You pulled out. The session is discarded and nothing reaches the Settlement Layer — that is what uncommitted means.",
  },
  "drift-target-missed": {
    title: "Drift gate missed",
    body: "The run finished but the drift score fell short, so the act is not cleared.",
  },
  "position-target-missed": {
    title: "Position missed",
    body: "The run finished outside the target position, so the act is not cleared.",
  },
  timeout: {
    title: "Session expired",
    body: "The run exceeded the maximum session duration.",
  },
};

function XpRow({
  label,
  value,
  hint,
  tone = "chalk",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "chalk" | "fog" | "amber" | "lime" | "ember";
}) {
  const toneClass = {
    chalk: "text-chalk",
    fog: "text-fog",
    amber: "text-amber",
    lime: "text-lime",
    ember: "text-ember",
  }[tone];

  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="font-mono text-[11px] text-fog">
        {label}
        {hint ? <span className="ml-1.5 text-[9px] text-steel">{hint}</span> : null}
      </span>
      <span className={cn("font-mono text-xs tabular-nums", toneClass)}>{value}</span>
    </div>
  );
}

export function ResultsOverlay({
  level,
  result,
  failure,
  practice,
  chainEnabled,
  settleState,
  settleError,
  baseSignature,
  onSettle,
  onRetry,
  onDiscard,
}: {
  level: LevelDefinition;
  result: RaceResult | null;
  failure: FailureReason | null;
  practice: boolean;
  chainEnabled: boolean;
  settleState: SettleState;
  settleError: string | null;
  baseSignature: string | null;
  onSettle: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  // Confirmed rollup transactions, as counted by the tick queue.
  const ticksLanded = useSession((s) => s.ticksLanded);

  if (!result) {
    const copy = failure ? FAILURE_COPY[failure] : FAILURE_COPY.retired;
    return (
      <Shell>
        <span className="label text-ember">{level.actLabel}</span>
        <h2 className="mt-2 font-display text-4xl font-bold text-ember">{copy.title}</h2>
        <p className="mt-3 max-w-md text-xs leading-relaxed text-fog">{copy.body}</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button variant="primary" size="md" onClick={onRetry}>
            Run it again
          </Button>
          <ButtonLink href="/campaign" variant="secondary" size="md">
            Back to campaign
          </ButtonLink>
        </div>
      </Shell>
    );
  }

  const { xp } = result;
  const settled = settleState === "settled";
  const busy = settleState === "settling" || settleState === "claiming";

  return (
    <Shell wide>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="label text-apex">{level.actLabel}</span>
          <h2 className="mt-2 font-display text-4xl font-bold leading-none text-chalk sm:text-5xl">
            {result.cleared ? "Cleared" : "Finished"}
          </h2>
          <p className="mt-2 font-mono text-xs text-fog">
            {formatOrdinal(result.position)} of {result.totalRacers} ·{" "}
            {formatLapTime(result.totalMs)} · best lap{" "}
            {formatLapTime(result.bestLapMs)}
          </p>
        </div>
        <div className="text-right">
          <span className="label">XP earned</span>
          <p className="mt-1 font-mono text-4xl leading-none tabular-nums text-apex">
            {formatNumber(xp.total)}
          </p>
          {!result.cleared ? (
            <Badge tone="amber" className="mt-2">
              Objective not met
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Panel className="p-0">
          <PanelHeader label="XP breakdown" />
          <div className="divide-y divide-steel/60 px-4 py-2">
            <XpRow
              label="Pace"
              hint={`par ${formatLapTime(level.parMs)}`}
              value={formatNumber(xp.pace)}
            />
            <XpRow
              label="Drift"
              hint={`${formatNumber(result.driftScore)} score`}
              value={formatNumber(xp.drift)}
            />
            <XpRow
              label="Clean run"
              hint={result.collisions === 0 ? "no contact" : `${result.collisions} hits`}
              value={formatNumber(xp.clean)}
              tone={xp.clean > 0 ? "lime" : "fog"}
            />
            <XpRow
              label="Overtakes"
              hint={`${result.overtakes} × 25`}
              value={formatNumber(xp.overtakes)}
            />
            <XpRow label="Placing" value={formatNumber(xp.placing)} />
            <XpRow
              label="Contact penalty"
              hint={
                result.collisions === 0
                  ? "clean"
                  : `${result.collisions} × ${XP_PER_CONTACT}`
              }
              value={xp.penalty > 0 ? `−${formatNumber(xp.penalty)}` : "0"}
              tone={xp.penalty > 0 ? "ember" : "fog"}
            />
            <XpRow
              label="Risk multiplier"
              hint={
                result.bankDeferredLaps > 0
                  ? `${result.bankDeferredLaps} unbanked lap(s) × ${RISK_PER_DEFERRED_LAP}%`
                  : "banked"
              }
              value={`×${(xp.riskPercent / 100).toFixed(2)}`}
              tone={xp.riskPercent > 100 ? "amber" : "fog"}
            />
            <div className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-chalk">
                Total
              </span>
              <span className="font-mono text-lg tabular-nums text-apex">
                {formatNumber(xp.total)}
              </span>
            </div>
          </div>
        </Panel>

        <Panel className="p-0">
          <PanelHeader label="Session" />
          <div className="space-y-3 px-4 py-4">
            <dl className="grid grid-cols-2 gap-3 font-mono text-[10px]">
              <div>
                {/* Two distinct numbers, deliberately not merged: the engine
                    produced this many state transitions, and the queue coalesced
                    them into that many confirmed rollup transactions. */}
                <dt className="text-fog">State transitions</dt>
                <dd className="mt-0.5 tabular-nums text-chalk">
                  {formatNumber(result.ticks)}
                </dd>
              </div>
              <div>
                <dt className="text-fog">Rollup writes</dt>
                <dd className="mt-0.5 tabular-nums text-chalk">
                  {chainEnabled ? formatNumber(ticksLanded) : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-fog">Checkpoints</dt>
                <dd className="mt-0.5 tabular-nums text-chalk">
                  {result.checkpointsHit}
                </dd>
              </div>
              <div>
                <dt className="text-fog">Laps</dt>
                <dd className="mt-0.5 tabular-nums text-chalk">
                  {result.lapTimesMs.length}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-fog">Seed</dt>
                <dd className="mt-0.5 truncate tabular-nums text-chalk" title={result.seed}>
                  {result.seed}
                </dd>
              </div>
            </dl>

            <div>
              <dt className="font-mono text-[10px] text-fog">Replay hash</dt>
              <dd
                className="mt-1 break-all font-mono text-[9px] leading-relaxed text-steel"
                title={result.replayHash}
              >
                {result.replayHash}
              </dd>
            </div>

            {practice ? (
              <p className="border-t border-steel pt-3 text-[10px] leading-relaxed text-amber">
                Practice run. Nothing was written to the rollup and this XP cannot
                be settled.
              </p>
            ) : !chainEnabled ? (
              <p className="border-t border-steel pt-3 text-[10px] leading-relaxed text-amber">
                Simulation mode — no program deployed. XP is credited locally only.
              </p>
            ) : settled ? (
              <div className="border-t border-steel pt-3">
                <p className="text-[10px] leading-relaxed text-lime">
                  Committed and claimed. This run is on the Settlement Layer.
                </p>
                {baseSignature ? (
                  <a
                    href={explorerTx(baseSignature)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-block font-mono text-[10px] text-apex hover:underline"
                  >
                    View transaction
                  </a>
                ) : null}
              </div>
            ) : settleState === "error" ? (
              <div className="border-t border-steel pt-3">
                <p className="text-[10px] leading-relaxed text-ember">
                  {settleError ?? "Settlement failed."}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-fog">
                  The run is queued on your profile and can be retried there.
                </p>
              </div>
            ) : (
              <p className="border-t border-steel pt-3 text-[10px] leading-relaxed text-fog">
                The run is finished inside the rollup. Commit it to make the XP
                permanent.
              </p>
            )}
          </div>
        </Panel>
      </div>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        {!practice && chainEnabled && !settled ? (
          <Button variant="primary" size="lg" onClick={onSettle} disabled={busy}>
            {settleState === "settling"
              ? "Committing…"
              : settleState === "claiming"
                ? "Claiming…"
                : "Settle run"}
          </Button>
        ) : null}
        <Button variant="secondary" size="lg" onClick={onRetry} disabled={busy}>
          Run it again
        </Button>
        <ButtonLink href="/campaign" variant="ghost" size="lg" className="sm:ml-auto">
          Back to campaign
        </ButtonLink>
        {!practice && chainEnabled && !settled ? (
          <Button variant="danger" size="lg" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
        ) : null}
      </div>
    </Shell>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-void/85 p-4 backdrop-blur-md">
      <div
        className={cn(
          "safe-t safe-b w-full animate-rise",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <Panel className="p-6 sm:p-8">{children}</Panel>
      </div>
    </div>
  );
}
