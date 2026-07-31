import type { Metadata } from "next";
import Link from "next/link";
import { CarStage } from "@/components/screens/CarStage";
import { DEFAULT_CAR } from "@/game/config/cars";

export const metadata: Metadata = {
  title: "APEX: Zero Latency",
  description:
    "An arcade racer on a 5.86km desert circuit, powered by MagicBlock Ephemeral Rollups on Solana. Race at rollup speed, settle only when it counts.",
};

/** A neutral bloom for the informational cards, which are not a live race round. */
const GLOW_INERT = {
  "--glow": "color-mix(in srgb, var(--color-cream) 12%, transparent)",
} as React.CSSProperties;

/**
 * The player-facing account of how a run reaches the chain.
 *
 * Written as three plain steps rather than the SDK's vocabulary — delegate, tick,
 * commit_and_undelegate — because a landing page has to be understood by someone
 * who has never heard those words. The mechanics behind each line are real; only
 * the names are the game's.
 */
const STEPS = [
  {
    title: "Pick a round and drive",
    body: "Two rounds on one 5.86km desert circuit, in a rear-drive grand tourer. Standard arcade controls, a full grid of rivals, and a par time to chase.",
  },
  {
    title: "Race at rollup speed",
    body: "Your race lives in a MagicBlock Ephemeral Rollup for the length of the run. Every checkpoint and drift is written to it in milliseconds, at no cost to you — so it feels like a local game, not a blockchain one.",
  },
  {
    title: "Settle when it counts",
    body: "Cross the line and the run commits to Solana as one result: your time, your score, yours for good. Bin a bad lap and nothing is spent. Permanence is the choice, not the default.",
  },
] as const;

/** Rollup facts, stated as figures. Sourced from `chain/config`, not invented. */
const FACTS = [
  { value: "~10ms", label: "Per write" },
  { value: "0", label: "Cost to race" },
  { value: "1", label: "Settled result" },
] as const;

/**
 * "Powered by" chip for the hero.
 *
 * A raised pill rather than a flat outline: a top highlight and a bottom shadow
 * inside the border make it read as a physical button pressed out of the surface,
 * and a soft drop shadow lifts it off the page. The status dot is gone — this is a
 * credit, not a live indicator, so a pulsing light was saying the wrong thing.
 */
function PoweredBy() {
  return (
    <span
      className="inline-flex items-center rounded-full px-5 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-cream/80"
      style={{
        // Navy body with a lighter top and darker bottom, so the fill itself has a
        // curve to it rather than sitting flat.
        backgroundImage:
          "linear-gradient(to bottom, color-mix(in srgb, var(--color-navy) 90%, var(--color-cream)), color-mix(in srgb, var(--color-navy) 80%, var(--color-void)))",
        boxShadow:
          // Inset highlight along the top edge, inset shade along the bottom, then a
          // soft cast shadow underneath.
          "inset 0 1px 0 color-mix(in srgb, var(--color-cream) 22%, transparent), inset 0 -2px 3px color-mix(in srgb, var(--color-void) 55%, transparent), 0 6px 16px -6px color-mix(in srgb, var(--color-void) 80%, transparent)",
      }}
    >
      Powered by MagicBlock
      <span className="mx-1.5 text-cream/30">·</span>
      Solana
    </span>
  );
}

export default function LandingPage() {
  return (
    <>
      {/* ------------------------------------------------------------------ hero */}
      {/*
        Sized to the viewport rather than to its contents, so the whole hero is
        there on load without a scroll.

        `svh`, not `vh`: on mobile `vh` resolves against the *largest* viewport, so a
        `100vh` hero sits partly behind the browser's own toolbars until they retract.
        The shell's chrome is subtracted too — a 4rem sticky header everywhere, plus
        the 3.5rem bottom nav that only exists below `md`. `min-h` keeps it usable on
        a landscape phone, where the remainder is too short to lay anything out in and
        scrolling is the right answer.
      */}
      <section className="relative isolate flex h-[calc(100svh-7.5rem)] min-h-[520px] w-full flex-col overflow-hidden px-4 pb-5 sm:px-8 md:h-[calc(100svh-4rem)]">
        <div className="hero-glow pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />

        <h1 className="sr-only">APEX: Zero Latency</h1>

        {/* Eyebrow: what powers the thing, stated once. Close to the wordmark it
            introduces — it is a label on the title, not a separate band. */}
        <div className="flex shrink-0 justify-center pt-10 sm:pt-14">
          <PoweredBy />
        </div>

        {/*
          The reference stacks the car in front of an oversized wordmark, the roof
          crossing the middle of the letters. Both live in one grid cell so they
          overlap; the wordmark is anchored to the *top* of the cell and the car
          fills it, so the car rises through the lower half of the type rather than
          floating over the centre.

          `min-h-0` lets this cell surrender height on a short screen instead of
          pushing the subtitle and buttons past the fold.
        */}
        <div className="relative grid min-h-0 flex-1 grid-cols-1 grid-rows-1">
          {/*
            Capped against height as well as width, or a short wide window drives the
            letters straight through the car. Fades to transparent at the baseline so
            the car emerges from the type instead of standing on a solid block of it.
          */}
          <span
            aria-hidden="true"
            className="col-start-1 row-start-1 mt-[3%] select-none justify-self-center self-start bg-gradient-to-b from-cream via-gold to-transparent bg-clip-text font-display text-[clamp(4rem,min(20vw,32vh),18rem)] font-black leading-[0.74] tracking-[-0.05em] text-transparent"
          >
            APEX
          </span>
          {/*
            Nudged left of centre so the nose reads into the open right-hand side of
            the frame, as it does in the reference. Done on the canvas rather than in
            the camera because the fit leaves almost no horizontal slack to aim into —
            the car's width is what sets the distance.
          */}
          <CarStage
            carId={DEFAULT_CAR}
            spin={false}
            className="col-start-1 row-start-1 mx-auto size-full max-w-[1240px] -translate-x-[4%] self-end"
          />
        </div>

        <div className="shrink-0">
          {/*
            One line at desktop widths, and no bottom fade. The fade was masking the
            lower half of whatever line landed last — on a two-line paragraph that
            read as text dissolving mid-sentence rather than as a soft edge.
          */}
          <p className="mx-auto max-w-3xl text-balance text-center text-base leading-snug text-cream/70 sm:text-lg">
            One grand tourer, one desert circuit, every lap settled on Solana.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/campaign"
              className="inline-flex h-12 items-center rounded-full bg-gold px-7 font-mono text-[11px] uppercase tracking-[0.16em] text-navy transition-colors hover:bg-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              Race now
            </Link>
            <Link
              href="/garage"
              className="inline-flex h-12 items-center rounded-full border border-cream/25 px-7 font-mono text-[11px] uppercase tracking-[0.16em] text-cream transition-colors hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              Garage
            </Link>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- how it works */}
      <section className="w-full px-4 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-[1500px]">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gold">
            How it works
          </span>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-extrabold leading-tight tracking-tight text-cream sm:text-4xl">
            A blockchain game that plays like an arcade one.
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-cream/60">
            A normal on-chain game makes you wait for the chain. APEX does not. Your
            car races inside a MagicBlock Ephemeral Rollup, where the game state
            updates in milliseconds and costs you nothing — then settles to Solana
            only when you decide the run counts.
          </p>

          <ol className="mt-10 grid gap-4 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="grid-band card-glow flex flex-col gap-4 p-6"
              >
                <span className="font-display text-sm font-bold leading-none text-gold">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="font-display text-xl font-bold leading-tight tracking-tight text-cream">
                  {step.title}
                </h3>
                <p className="text-sm leading-relaxed text-cream/60">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* -------------------------------------------------------------- the numbers */}
      <section className="w-full px-4 pb-20 sm:px-8">
        <div className="mx-auto grid w-full max-w-[1500px] gap-4 md:grid-cols-[1.4fr_1fr]">
          <div className="grid-band card-glow flex flex-col justify-between gap-10 p-8">
            <div>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gold">
                Why a rollup
              </span>
              <h2 className="mt-3 font-display text-3xl font-extrabold leading-tight tracking-tight text-cream">
                One race is thousands of writes.
              </h2>
              <p className="mt-4 max-w-xl text-base leading-relaxed text-cream/60">
                Every checkpoint, every tick of a drift, every wall you clip is a
                real state change. On Solana&apos;s base layer that many writes would
                be unaffordable and far too slow to drive against. The Ephemeral
                Rollup absorbs them at speed, then commits a single settled result
                back to the chain.
              </p>
            </div>
            <dl className="grid grid-cols-3 gap-px">
              {FACTS.map((fact) => (
                <div key={fact.label} className="grid-cell px-4 py-4">
                  <dd className="font-display text-2xl font-bold leading-none text-cream">
                    {fact.value}
                  </dd>
                  <dt className="mt-2 font-mono text-[9px] uppercase leading-none tracking-[0.14em] text-cream/45">
                    {fact.label}
                  </dt>
                </div>
              ))}
            </dl>
          </div>

          <div
            className="grid-band card-glow flex flex-col justify-between gap-8 p-8"
            style={GLOW_INERT}
          >
            <div>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream/50">
                No wallet?
              </span>
              <h2 className="mt-3 font-display text-2xl font-bold leading-tight tracking-tight text-cream">
                Play anyway.
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-cream/60">
                Every round runs in Offline mode with the full game intact. Your
                times and XP are kept on the device. Connect a wallet whenever you
                want a run to settle for good.
              </p>
            </div>
            <Link
              href="/campaign"
              className="inline-flex h-12 w-fit items-center rounded-full bg-gold px-7 font-mono text-[11px] uppercase tracking-[0.16em] text-navy transition-colors hover:bg-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              Start the championship
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
