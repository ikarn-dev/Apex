"use client";

import { useRouter } from "next/navigation";
import { ChainStatus } from "@/components/wallet/ChainStatus";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import {
  CAMPAIGN_ORDER,
  COMING_SOON_ACT,
  LEVELS,
  type ComingSoonAct,
  type LevelDefinition,
} from "@/game/config/levels";
import { OUTLINE_VIEWBOX } from "@/game/track/outline";
import { isLevelUnlocked } from "@/game/config/progression";
import { useProfile } from "@/stores/profile";
import { useRace } from "@/stores/race";
import { formatLapTime } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Every act runs the one circuit, so the card names it rather than implying a pick. */
const CIRCUIT_NAME = "APEX International";

type CardStatus = "open" | "cleared" | "locked" | "soon";

/**
 * Overrides for the card's bottom glow.
 *
 * `--glow` is read by the `.card-glow` utility. Declared here as typed constants
 * because React's `CSSProperties` has no slot for custom properties, and the cast
 * belongs in one named place rather than inline at every call site.
 */
const GLOW_LOCKED = {
  "--glow": "color-mix(in srgb, var(--color-coral) 24%, transparent)",
} as React.CSSProperties;

const GLOW_INERT = {
  "--glow": "color-mix(in srgb, var(--color-cream) 10%, transparent)",
} as React.CSSProperties;

const STATUS_LABEL: Record<CardStatus, string> = {
  open: "Entry open",
  cleared: "Cleared",
  locked: "Locked",
  soon: "In development",
};

/**
 * Status dot and label.
 *
 * One indicator per card, top left. It replaces the three stacked badges the old
 * card could show at once — cleared, XP requirement, boss — which competed with the
 * act title for the eye and repeated what the disabled buttons already said.
 */
function StatusPill({ status }: { status: CardStatus }) {
  const dot: Record<CardStatus, string> = {
    open: "bg-gold",
    cleared: "bg-cream",
    locked: "bg-coral",
    soon: "bg-cream/40",
  };

  return (
    <span className="inline-flex items-center gap-2 bg-void/55 px-2.5 py-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.16em] text-cream backdrop-blur-sm">
      <span className={cn("size-1.5 rounded-full", dot[status])} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The circuit's plan view, laid into the card face. */
function TrackOutline({ path, muted }: { path: string; muted?: boolean }) {
  return (
    <svg
      viewBox={`0 0 ${OUTLINE_VIEWBOX} ${OUTLINE_VIEWBOX}`}
      className="absolute inset-0 size-full"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinejoin="round"
        className={muted ? "text-cream/20" : "text-cream/70"}
      />
    </svg>
  );
}

/**
 * A card action.
 *
 * Local rather than the shared `Button`, on purpose. `Button`'s variants each set a
 * background and a notched `clip-path` from the neon-industrial palette, so using
 * one here meant overriding `bg-apex` with `bg-gold` and `clip-path` with `none` —
 * two utilities setting the same property in the same cascade layer, where the
 * winner is decided by Tailwind's output order rather than by the class list. That
 * works until it silently does not. These cards are square-edged and use the grid
 * palette, so they get their own control.
 */
function CardAction({
  tone,
  disabled,
  onClick,
  children,
}: {
  tone: "solid" | "quiet";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // 44px tall: this is a touch target on mobile.
        "h-11 px-4 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold",
        "disabled:cursor-not-allowed disabled:opacity-40",
        tone === "solid"
          ? "bg-gold text-navy hover:bg-cream"
          : "grid-cell text-cream/70 hover:text-gold",
      )}
    >
      {children}
    </button>
  );
}

/** One cell of the stat strip. */
function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "gold";
}) {
  return (
    <div className="grid-cell flex flex-col gap-1.5 px-3 py-2.5">
      <span className="font-mono text-[9px] uppercase leading-none tracking-[0.14em] text-cream/50">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-sm leading-none tabular-nums",
          tone === "gold" ? "text-gold" : "text-cream",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function ActCard({
  level,
  index,
  outline,
  unlocked,
  cleared,
  bestMs,
  onPlay,
}: {
  level: LevelDefinition;
  index: number;
  outline: string;
  unlocked: boolean;
  cleared: boolean;
  bestMs: number | undefined;
  onPlay: (practice: boolean) => void;
}) {
  const status: CardStatus = !unlocked ? "locked" : cleared ? "cleared" : "open";

  return (
    <article
      className="card-glow flex flex-col overflow-hidden border border-transparent grid-band"
      style={status === "locked" ? GLOW_LOCKED : undefined}
    >
      {/* Face: the circuit, the act number, and what the act is called. */}
      <div className="grid-face relative aspect-[4/3] p-4">
        <TrackOutline path={outline} />

        <div className="relative flex items-start justify-between gap-3">
          <StatusPill status={status} />
          <span className="font-display text-lg font-bold leading-none tracking-[0.06em] text-cream">
            {String(index + 1).padStart(2, "0")}
          </span>
        </div>

        <div className="absolute inset-x-4 bottom-4">
          <h2 className="font-display text-3xl font-bold leading-none tracking-tight text-cream">
            {level.title}
          </h2>
          <p className="mt-2 font-mono text-[11px] leading-none text-cream/60">
            {CIRCUIT_NAME}
          </p>
        </div>
      </div>

      {/* The one number that matters before you drive: what you are chasing. */}
      <div className="flex items-end justify-between gap-3 px-4 py-3.5">
        <div>
          <p className="font-mono text-[11px] leading-none text-cream">Par time</p>
          <p className="mt-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-cream/50">
            {level.concept}
          </p>
        </div>
        <span className="font-mono text-2xl leading-none tabular-nums text-cream">
          {formatLapTime(level.parMs)}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-px">
        <Cell label="Laps" value={String(level.laps)} />
        <Cell label="Rivals" value={String(level.rivals)} />
        <Cell label="Target" value={`P${level.targetPosition}`} />
        <Cell
          label="Your best"
          value={bestMs ? formatLapTime(bestMs) : "--"}
          tone={bestMs ? "gold" : undefined}
        />
      </div>

      <div className="grid grid-cols-[2fr_1fr] gap-px">
        <CardAction
          tone="solid"
          disabled={!unlocked}
          onClick={() => onPlay(false)}
        >
          Race
        </CardAction>
        <CardAction tone="quiet" disabled={!unlocked} onClick={() => onPlay(true)}>
          Practice
        </CardAction>
      </div>
    </article>
  );
}

/**
 * The roadmap card.
 *
 * Same frame and the same three bands as a playable act, so the grid reads as one
 * set. What it does not do is imitate data it has not got: the stat strip states
 * the reason it is empty instead of showing dashes that look like a loading bug.
 */
function ComingSoonCard({
  act,
  index,
  outline,
}: {
  act: ComingSoonAct;
  index: number;
  outline: string;
}) {
  return (
    <article
      aria-disabled="true"
      className="card-glow flex flex-col overflow-hidden border border-dashed grid-rule grid-band"
      // An inert card gets a colourless bloom: the glow says "live", so the one
      // card you cannot race should not have it.
      style={GLOW_INERT}
    >
      <div className="grid-face relative aspect-[4/3] p-4 opacity-70">
        <TrackOutline path={outline} muted />

        <div className="relative flex items-start justify-between gap-3">
          <StatusPill status="soon" />
          <span className="font-display text-lg font-bold leading-none tracking-[0.06em] text-cream/50">
            {String(index + 1).padStart(2, "0")}
          </span>
        </div>

        <div className="absolute inset-x-4 bottom-4">
          <h2 className="font-display text-3xl font-bold leading-none tracking-tight text-cream/70">
            {act.title}
          </h2>
          <p className="mt-2 font-mono text-[11px] leading-none text-cream/40">
            {act.concept}
          </p>
        </div>
      </div>

      <div className="px-4 py-3.5">
        <p className="font-mono text-[11px] leading-relaxed text-cream/50">
          {act.conceptDetail}
        </p>
      </div>
    </article>
  );
}

/**
 * @param outline The circuit's plan view as an SVG path.
 *
 * Passed in rather than imported: `circuitOutlinePath` reaches `track/layout`, and
 * importing that here would ship the spline builder and its 34 control points to
 * the browser to draw one static shape. The page computes it at build time.
 */
export function CampaignScreen({ outline }: { outline: string }) {
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

  const start = (level: LevelDefinition, practice: boolean) => {
    selectLevel(level.id);
    // Practice is forced when there is no wallet: there is nothing to settle to.
    setPractice(practice || !connected);
    router.push(`/race/${level.id}`);
  };

  return (
    <div className="w-full px-4 py-10 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream/45">
            Campaign
          </span>
          <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-cream">
            Championship
          </h1>
        </div>
        <ChainStatus />
      </header>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {acts.map((level, index) => (
          <ActCard
            key={level.id}
            level={level}
            index={index}
            outline={outline}
            unlocked={isLevelUnlocked(level.unlockXp, totalXp)}
            cleared={clearedLevels.includes(level.id)}
            bestMs={bestTimesMs[level.id]}
            onPlay={(practice) => start(level, practice)}
          />
        ))}
        <ComingSoonCard
          act={COMING_SOON_ACT}
          index={acts.length}
          outline={outline}
        />
      </div>

      {!connected ? (
        <div className="grid-band card-glow mt-4 flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-ui text-xs leading-relaxed text-cream/60">
            Offline mode. Every round is fully playable, but your times and XP are
            saved on this device only.
          </p>
          {/*
            The real control, not a link to a page that explained it. This used to
            point at /profile, which no longer exists — and sending someone to another
            screen to press the button that is already in the header was a detour
            either way.
          */}
          <ConnectButton size="sm" className="shrink-0" />
        </div>
      ) : null}
    </div>
  );
}
