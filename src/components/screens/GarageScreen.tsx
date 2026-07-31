"use client";

import Link from "next/link";
import { useState } from "react";
import { CarStage } from "@/components/screens/CarStage";
import { CARS, CAR_IDS, type CarDefinition } from "@/game/config/cars";
import { isCarUnlocked } from "@/game/config/progression";
import { useProfile } from "@/stores/profile";
import { useRace } from "@/stores/race";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";

const STAT_ROWS = [
  { key: "acceleration", label: "Acceleration" },
  { key: "topSpeed", label: "Top speed" },
  { key: "grip", label: "Grip" },
  { key: "drift", label: "Drift" },
] as const;

/** Segments in a stat bar. `CarStats` is scored out of ten, so ten. */
const SEGMENTS = 10;

/**
 * Segmented stat bar.
 *
 * Segments rather than a continuous fill because the underlying number *is*
 * discrete — `CarStats` is an integer out of ten — and a smooth bar implies a
 * precision the data has not got.
 */
function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-cream/60">
        {label}
      </span>
      <span
        className="flex flex-1 gap-0.5"
        role="img"
        aria-label={`${label} ${value} out of ${SEGMENTS}`}
      >
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={cn("h-2.5 flex-1", i < value ? "bg-gold" : "bg-cream/12")}
          />
        ))}
      </span>
      <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-cream">
        {value}
      </span>
    </div>
  );
}

/** Label-over-value spec, in the card palette. */
function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid-cell px-3 py-2.5">
      <dt className="font-mono text-[9px] uppercase leading-none tracking-[0.14em] text-cream/50">
        {label}
      </dt>
      <dd className="mt-1.5 font-mono text-sm leading-none tabular-nums text-cream">
        {value}
      </dd>
    </div>
  );
}

/** Roster entry. Selects the car and, once there is more than one, scrolls as a strip. */
function RosterChip({
  car,
  active,
  unlocked,
  onSelect,
}: {
  car: CarDefinition;
  active: boolean;
  unlocked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!unlocked}
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "grid-cell min-w-44 border px-4 py-3 text-left transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold",
        active ? "border-gold" : "border-transparent hover:border-cream/30",
        !unlocked && "opacity-40",
      )}
    >
      <span className="block font-mono text-[9px] uppercase leading-none tracking-[0.14em] text-cream/50">
        {car.klass}
      </span>
      <span className="mt-1.5 block font-display text-base font-semibold leading-none text-cream">
        {car.name}
      </span>
      {!unlocked ? (
        <span className="mt-1.5 block font-mono text-[10px] leading-none text-coral">
          {formatNumber(car.unlockXp)} XP
        </span>
      ) : null}
    </button>
  );
}

export function GarageScreen() {
  const xpCommitted = useProfile((s) => s.xpCommitted);
  const xpPending = useProfile((s) => s.xpPending);
  const selectedCar = useRace((s) => s.selectedCar);
  const selectCar = useRace((s) => s.selectCar);

  const totalXp = xpCommitted + xpPending;
  const cars = CAR_IDS.map((id) => CARS[id]);

  // What the viewer is showing. Separate from `selectedCar` so the roster can be
  // browsed without committing the car you take to the grid.
  const [previewId, setPreviewId] = useState(selectedCar ?? CAR_IDS[0]!);
  const car = CARS[previewId] ?? cars[0]!;
  const unlocked = isCarUnlocked(car.unlockXp, totalXp);
  const isSelected = selectedCar === car.id;

  return (
    <div className="w-full px-4 py-10 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream/45">
            Garage
          </span>
          <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-cream">
            {cars.length === 1 ? "One car" : `${cars.length} cars`}
          </h1>
        </div>
        <Link
          href="/campaign"
          className="inline-flex h-11 items-center border grid-rule px-4 font-mono text-[11px] uppercase tracking-[0.16em] text-cream transition-colors hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        >
          Championship
        </Link>
      </header>

      <div className="grid-band card-glow mt-8 grid lg:grid-cols-[1.5fr_1fr]">
        {/* The car itself. */}
        <div className="grid-face relative min-h-[340px] sm:min-h-[460px]">
          <CarStage carId={car.id} className="absolute inset-0" />

          <span className="absolute left-4 top-4 inline-flex items-center gap-2 bg-void/55 px-2.5 py-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.16em] text-cream backdrop-blur-sm">
            <span
              className={cn(
                "size-1.5 rounded-full",
                isSelected ? "bg-gold" : "bg-cream/40",
              )}
              aria-hidden="true"
            />
            {isSelected ? "On the grid" : "In the garage"}
          </span>
        </div>

        {/* Identity, specs, stats. */}
        <div className="flex flex-col justify-between gap-6 p-5">
          <div>
            <span className="font-mono text-[10px] uppercase leading-none tracking-[0.16em] text-gold">
              {car.klass}
            </span>
            <h2 className="mt-2 font-display text-4xl font-bold leading-none tracking-tight text-cream">
              {car.name}
            </h2>
            <p className="mt-2 font-mono text-[11px] leading-none text-cream/50">
              {car.basedOn}
            </p>
            <p className="mt-4 font-mono text-[11px] leading-relaxed text-cream/60">
              {car.blurb}
            </p>
          </div>

          {/* Measured off the tuning the physics reads, not a spec sheet. */}
          <dl className="grid grid-cols-2 gap-px sm:grid-cols-4 lg:grid-cols-2">
            <Spec label="Top speed" value={`${Math.round(car.tuning.maxSpeed * 3.6)} km/h`} />
            <Spec label="Mass" value={`${formatNumber(car.tuning.mass)} kg`} />
            <Spec label="Layout" value="Rear wheel" />
            <Spec label="Wheelbase" value={`${car.tuning.wheelbase.toFixed(2)} m`} />
          </dl>

          <div className="flex flex-col gap-2">
            {STAT_ROWS.map((row) => (
              <StatBar key={row.key} label={row.label} value={car.stats[row.key]} />
            ))}
          </div>

          <button
            type="button"
            disabled={!unlocked || isSelected}
            onClick={() => selectCar(car.id)}
            className={cn(
              "h-11 px-4 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors duration-150",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold",
              "disabled:cursor-not-allowed disabled:opacity-40",
              "bg-gold text-navy hover:bg-cream",
            )}
          >
            {isSelected ? "On the grid" : unlocked ? "Take to the grid" : "Locked"}
          </button>
        </div>
      </div>

      {/* Roster. One entry today; a strip the moment there are more. */}
      {cars.length > 1 ? (
        <div className="mt-4 flex gap-px overflow-x-auto">
          {cars.map((entry) => (
            <RosterChip
              key={entry.id}
              car={entry}
              active={entry.id === previewId}
              unlocked={isCarUnlocked(entry.unlockXp, totalXp)}
              onSelect={() => setPreviewId(entry.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
