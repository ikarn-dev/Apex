import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/Button";
import { Panel, Badge } from "@/components/ui/Panel";
import { ChainStatus } from "@/components/wallet/ChainStatus";
import { CAMPAIGN_ORDER, LEVELS } from "@/game/config/levels";

export const metadata: Metadata = {
  title: "APEX: Zero Latency",
  description:
    "Race inside a MagicBlock Ephemeral Rollup at 10ms, then commit your run to Solana. Speed is free, permanence is not.",
};

const PILLARS = [
  {
    label: "The problem",
    heading: "400ms is not a game",
    body: "One three-lap race produces 80 to 500 state transitions. On the Solana base layer that is unaffordable and far too slow to drive. Most on-chain games solve this by not putting the game on-chain.",
  },
  {
    label: "The rollup",
    heading: "10ms, no toll",
    body: "Your race account is delegated to a MagicBlock Ephemeral Rollup for the duration of the run. Every checkpoint, every tick of a drift, every collision is a real write — at roughly ten milliseconds, and free to you.",
  },
  {
    label: "The stakes",
    heading: "Commit, or it never happened",
    body: "Nothing is permanent until you commit it back to the Settlement Layer. Crash out, disconnect, or get greedy chasing a multiplier, and the session is discarded with your XP still inside it.",
  },
] as const;

export default function LandingPage() {
  const acts = CAMPAIGN_ORDER.map((id) => LEVELS[id]);

  return (
    <div className="relative overflow-hidden">
      {/* Backdrop: a grid that reads as a track surface receding to a horizon. */}
      <div
        className="pointer-events-none absolute inset-0 grid-floor opacity-60"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-apex/8 to-transparent"
        aria-hidden="true"
      />

      <section className="relative mx-auto w-full max-w-7xl px-4 pb-16 pt-12 sm:px-6 sm:pt-20">
        <Badge tone="apex">Solana · MagicBlock Ephemeral Rollups</Badge>

        <h1 className="mt-6 max-w-4xl font-display text-5xl font-bold leading-[0.95] tracking-tight text-chalk sm:text-7xl lg:text-8xl">
          Speed is free.
          <br />
          <span className="text-apex">Permanence is not.</span>
        </h1>

        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-fog sm:text-base">
          An arcade street racer that settles on Solana. You race inside an
          Ephemeral Session where state updates every ten milliseconds and costs
          you nothing. Cross the line and you choose: commit the run and keep the
          XP forever, or push for a bigger multiplier and risk losing all of it.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <ButtonLink href="/campaign" variant="primary" size="lg">
            Start Act I
          </ButtonLink>
          <ButtonLink href="/garage" variant="secondary" size="lg">
            View Garage
          </ButtonLink>
        </div>

        <ChainStatus className="mt-8" />

        <p className="mt-4 max-w-xl text-xs leading-relaxed text-fog">
          No wallet? Every track is playable in Practice mode. XP earned there is
          local and cannot be settled — connect a wallet when you want a run to
          count.
        </p>
      </section>

      <section className="relative mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6">
        <div className="grid gap-4 md:grid-cols-3">
          {PILLARS.map((pillar) => (
            <Panel key={pillar.label} className="p-5">
              <span className="label">{pillar.label}</span>
              <h2 className="mt-3 font-display text-xl font-semibold text-chalk">
                {pillar.heading}
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-fog">{pillar.body}</p>
            </Panel>
          ))}
        </div>
      </section>

      <section className="relative mx-auto w-full max-w-7xl px-4 pb-24 sm:px-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <span className="label">The campaign</span>
            <h2 className="mt-2 font-display text-2xl font-semibold text-chalk sm:text-3xl">
              Five acts, five primitives
            </h2>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-fog">
              Each act teaches one part of the rollup lifecycle through a
              mechanic rather than a tutorial box. By Act V you will have
              delegated, ticked, committed and undelegated an account without
              once being told what those words mean.
            </p>
          </div>
        </div>

        <ol className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {acts.map((level) => (
            <li key={level.id}>
              <Panel className="flex h-full flex-col p-4">
                <span className="label text-apex">{level.actLabel}</span>
                <h3 className="mt-2 font-display text-base font-semibold text-chalk">
                  {level.title}
                </h3>
                <code className="mt-2 block text-[10px] leading-tight text-amber">
                  {level.concept}
                </code>
                <p className="mt-3 text-[11px] leading-relaxed text-fog">
                  {level.conceptDetail}
                </p>
              </Panel>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
