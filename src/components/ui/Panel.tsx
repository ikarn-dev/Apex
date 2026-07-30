import { cn } from "@/lib/cn";

export function Panel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border border-steel bg-asphalt/70 backdrop-blur-sm clip-notch",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  label,
  action,
  className,
}: {
  label: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-steel px-4 py-3",
        className,
      )}
    >
      <span className="label">{label}</span>
      {action}
    </div>
  );
}

/** Label-over-value block. The core unit of every telemetry readout. */
export function Stat({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "apex" | "lime" | "amber" | "ember" | "fog";
  className?: string;
}) {
  const toneClass = {
    default: "text-chalk",
    apex: "text-apex",
    lime: "text-lime",
    amber: "text-amber",
    ember: "text-ember",
    fog: "text-fog",
  }[tone];

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="label">{label}</span>
      <span className={cn("font-mono text-lg leading-none tabular-nums", toneClass)}>
        {value}
      </span>
      {hint ? <span className="text-[10px] leading-tight text-fog">{hint}</span> : null}
    </div>
  );
}

/** Horizontal progress bar. Used for rank progress and car stats. */
export function Meter({
  value,
  max = 1,
  tone = "apex",
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: "apex" | "lime" | "amber" | "ember" | "violet";
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0)) * 100;
  const barTone = {
    apex: "bg-apex",
    lime: "bg-lime",
    amber: "bg-amber",
    ember: "bg-ember",
    violet: "bg-violet",
  }[tone];

  return (
    <div
      className={cn("h-1 w-full bg-steel/60", className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={cn("h-full transition-[width] duration-500 ease-out", barTone)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Badge({
  children,
  tone = "fog",
  className,
}: {
  children: React.ReactNode;
  tone?: "apex" | "lime" | "amber" | "ember" | "violet" | "fog";
  className?: string;
}) {
  const toneClass = {
    apex: "border-apex/40 text-apex",
    lime: "border-lime/40 text-lime",
    amber: "border-amber/40 text-amber",
    ember: "border-ember/40 text-ember",
    violet: "border-violet/40 text-violet",
    fog: "border-steel text-fog",
  }[tone];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-[10px] uppercase leading-none tracking-[0.16em]",
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Small pulsing dot. Signals a live rollup session. */
export function LiveDot({ tone = "lime" }: { tone?: "lime" | "amber" | "ember" | "fog" }) {
  const toneClass = {
    lime: "bg-lime",
    amber: "bg-amber",
    ember: "bg-ember",
    fog: "bg-fog",
  }[tone];
  return (
    <span
      className={cn("inline-block size-1.5 rounded-full animate-pulse-apex", toneClass)}
      aria-hidden="true"
    />
  );
}
