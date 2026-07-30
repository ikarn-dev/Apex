"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Meter, Panel } from "@/components/ui/Panel";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ChainStatus } from "@/components/wallet/ChainStatus";
import { CAMPAIGN_ORDER, LEVELS, type LevelDefinition } from "@/game/config/levels";
import { CARS } from "@/game/config/cars";
import { isLevelUnlocked } from "@/game/config/progression";
import { useProfile } from "@/stores/profile";
import { useRace } from "@/stores/race";
import { formatLapTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";

function LevelCard({
  level,
  unlocked,
  cleared,
  bestMs,
  onPlay,
}: {
  level: LevelDefinition;
  unlocked: boolean;
  cleared: boolean;
  bestMs: number | undefined;
  onPlay: (practice: boolean) => void;
}) {
  const car = CARS[level.recommendedCar];

  return (
    <Panel
      className={cn(
        "flex flex-col p-5 transition-colors",
        unlocked ? "hover:border-apex/50" : "opacity-55",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="label text-apex">{level.actLabel}</span>
          <h2 className="mt-1.5 font-display text-2xl font-semibold leading-tight text-chalk">
            {level.title}
          </h2>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {cleared ? <Badge tone="lime">Cleared</Badge> : null}
          {!unlocked ? (
            <Badge tone="amber">{formatNumber(level.unlockXp)} XP</Badge>
          ) : null}
          {level.bossRace ? <Badge tone="ember">Boss</Badge> : null}
        </div>
      </div>

      <code className="mt-3 block text-[10px] leading-tight text-amber">
        {level.concept}
      </code>
      <p className="mt-2 text-[11px] leading-relaxed text-fog">
        {level.conceptDetail}
      </p>

      <dl className="mt-4 grid grid-cols-4 gap-3 border-t border-steel pt-4">
        <div>
          <dt className="label">Laps</dt>
          <dd className="mt-1 font-mono text-sm tabular-nums text-chalk">
            {level.laps}
          </dd>
        </div>
        <div>
          <dt className="label">Rivals</dt>
          <dd className="mt-1 font-mono text-sm tabular-nums text-chalk">
            {level.rivals}
          </dd>
        </div>
        <div>
          <dt className="label">Par</dt>
          <dd className="mt-1 font-mono text-sm tabular-nums text-chalk">
            {formatLapTime(level.parMs)}
          </dd>
        </div>
        <div>
          <dt className="label">Target</dt>
          <dd className="mt-1 font-mono text-sm tabular-nums text-chalk">
            P{level.targetPosition}
          </dd>
        </div>
      </dl>

      {level.driftTarget > 0 ? (
        <p className="mt-3 text-[10px] uppercase tracking-[0.14em] text-amber">
          Drift gate · {formatNumber(level.driftTarget)}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between text-[10px] text-fog">
        <span>
          Recommended: <span className="text-chalk">{car.name}</span>
        </span>
        {bestMs ? (
          <span className="tabular-nums">Best {formatLapTime(bestMs)}</span>
        ) : null}
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button
          variant="primary"
          size="sm"
          block
          disabled={!unlocked}
          onClick={() => onPlay(false)}
        >
          {level.erEnabled ? "Jack in" : "Race"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          block
          disabled={!unlocked}
          onClick={() => onPlay(true)}
        >
          Practice
        </Button>
      </div>
    </Panel>
  );
}

export function CampaignScreen() {
  const router = useRouter();
  // Read the mirrored flag rather than `useWallet()`: this screen must not pull
  // the wallet adapter into its bundle. See `stores/profile.walletConnected`.
  const connected = useProfile((s) => s.walletConnected);
  const xpCommitted = useProfile((s) => s.xpCommitted);
  const xpPending = useProfile((s) => s.xpPending);
  const clearedLevels = useProfile((s) => s.clearedLevels);
  const bestTimesMs = useProfile((s) => s.bestTimesMs);
  const selectLevel = useRace((s) => s.selectLevel);
  const setPractice = useRace((s) => s.setPractice);

  const totalXp = xpCommitted + xpPending;
  const acts = CAMPAIGN_ORDER.map((id) => LEVELS[id]);
  const endless = LEVELS["endless-time-attack"];
  const clearedCount = acts.filter((level) => clearedLevels.includes(level.id)).length;

  const start = (level: LevelDefinition, practice: boolean) => {
    selectLevel(level.id);
    // Practice is forced when there is no wallet: there is nothing to settle to.
    setPractice(practice || !connected);
    router.push(`/race/${level.id}`);
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="label">Campaign</span>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
            The Ephemeral
          </h1>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-fog">
            Five acts. Each one hands you one more piece of the rollup and lets
            you work out what it is for at speed.
          </p>
        </div>
        <div className="w-full sm:w-64">
          <div className="flex items-baseline justify-between">
            <span className="label">Progress</span>
            <span className="font-mono text-xs tabular-nums text-chalk">
              {clearedCount}/{acts.length}
            </span>
          </div>
          <Meter value={clearedCount} max={acts.length} className="mt-2" />
        </div>
      </header>

      <ChainStatus className="mt-6" />

      <div className="mt-8 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {acts.map((level) => (
          <LevelCard
            key={level.id}
            level={level}
            unlocked={isLevelUnlocked(level.unlockXp, totalXp)}
            cleared={clearedLevels.includes(level.id)}
            bestMs={bestTimesMs[level.id]}
            onPlay={(practice) => start(level, practice)}
          />
        ))}
      </div>

      <section className="mt-10">
        <span className="label">Endless</span>
        <div className="mt-3 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <LevelCard
            level={endless}
            unlocked
            cleared={clearedLevels.includes(endless.id)}
            bestMs={bestTimesMs[endless.id]}
            onPlay={(practice) => start(endless, practice)}
          />
        </div>
      </section>

      {!connected ? (
        <Panel className="mt-10 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-relaxed text-fog">
            You are in Practice mode. Runs are fully playable but the XP stays on
            this device and never reaches the Settlement Layer.
          </p>
          <ButtonLink href="/profile" variant="secondary" size="sm">
            Connect to settle
          </ButtonLink>
        </Panel>
      ) : null}

      <p className="mt-10 text-[10px] text-fog">
        Story and design notes live in{" "}
        <Link href="/settings" className="text-apex hover:underline">
          settings
        </Link>
        .
      </p>
    </div>
  );
}
