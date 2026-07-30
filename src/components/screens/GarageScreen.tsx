"use client";

import { useRouter } from "next/navigation";
import { Badge, Meter, Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { CARS, CAR_IDS, type CarDefinition } from "@/game/config/cars";
import { isCarUnlocked } from "@/game/config/progression";
import { useProfile } from "@/stores/profile";
import { useRace } from "@/stores/race";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";

const STAT_ROWS = [
  { key: "acceleration", label: "Accel" },
  { key: "topSpeed", label: "Top" },
  { key: "grip", label: "Grip" },
  { key: "drift", label: "Drift" },
] as const;

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function CarCard({
  car,
  selected,
  unlocked,
  onSelect,
}: {
  car: CarDefinition;
  selected: boolean;
  unlocked: boolean;
  onSelect: () => void;
}) {
  return (
    <Panel
      className={cn(
        "flex flex-col p-5 transition-colors",
        selected && "border-apex/70 glow-apex",
        !unlocked && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="label">{car.klass}</span>
          <h2
            className="mt-1.5 font-display text-2xl font-semibold leading-tight"
            style={{ color: hex(car.accent) }}
          >
            {car.name}
          </h2>
          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-fog">
            {car.basedOn}
          </p>
        </div>
        {selected ? (
          <Badge tone="apex">Selected</Badge>
        ) : !unlocked ? (
          <Badge tone="amber">{formatNumber(car.unlockXp)} XP</Badge>
        ) : null}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-fog">{car.blurb}</p>

      <dl className="mt-5 flex flex-col gap-2.5">
        {STAT_ROWS.map((row) => (
          <div key={row.key} className="flex items-center gap-3">
            <dt className="label w-14 shrink-0">{row.label}</dt>
            <dd className="flex-1">
              <Meter
                value={car.stats[row.key]}
                max={10}
                tone="apex"
                label={`${row.label} ${car.stats[row.key]} of 10`}
              />
            </dd>
            <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-chalk">
              {car.stats[row.key]}
            </span>
          </div>
        ))}
      </dl>

      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-steel pt-4">
        <div>
          <dt className="label">Mass</dt>
          <dd className="mt-1 font-mono text-xs tabular-nums text-chalk">
            {car.tuning.mass} kg
          </dd>
        </div>
        <div>
          <dt className="label">Top speed</dt>
          <dd className="mt-1 font-mono text-xs tabular-nums text-chalk">
            {Math.round(car.tuning.maxSpeed * 3.6)} km/h
          </dd>
        </div>
        <div>
          <dt className="label">Wheelbase</dt>
          <dd className="mt-1 font-mono text-xs tabular-nums text-chalk">
            {car.tuning.wheelbase.toFixed(2)} m
          </dd>
        </div>
      </dl>

      <Button
        variant={selected ? "secondary" : "primary"}
        size="sm"
        block
        className="mt-5"
        disabled={!unlocked || selected}
        onClick={onSelect}
      >
        {selected ? "In the garage" : unlocked ? "Select" : "Locked"}
      </Button>
    </Panel>
  );
}

export function GarageScreen() {
  const router = useRouter();
  const xpCommitted = useProfile((s) => s.xpCommitted);
  const xpPending = useProfile((s) => s.xpPending);
  const selectedCar = useRace((s) => s.selectedCar);
  const selectCar = useRace((s) => s.selectCar);

  const totalXp = xpCommitted + xpPending;
  const cars = CAR_IDS.map((id) => CARS[id]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="label">Garage</span>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
            Three cars, three arguments
          </h1>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-fog">
            Handling numbers here are the real physics values the simulation
            uses, not marketing. Cars unlock with settled XP.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => router.push("/campaign")}>
          Back to campaign
        </Button>
      </header>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        {cars.map((car) => (
          <CarCard
            key={car.id}
            car={car}
            selected={selectedCar === car.id}
            unlocked={isCarUnlocked(car.unlockXp, totalXp)}
            onSelect={() => selectCar(car.id)}
          />
        ))}
      </div>

      <p className="mt-8 max-w-2xl text-[10px] leading-relaxed text-fog">
        Models are shipped in two variants. Your car loads the full-detail build;
        rivals load a reduced one, because nothing five car lengths ahead
        resolves a 1K texture and a phone should not pay for six of them.
      </p>
    </div>
  );
}
