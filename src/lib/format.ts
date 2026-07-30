/** Formatting helpers shared by the HUD, results screen and profile. */

/** `92345` -> `1:32.345`. Race clocks and lap times. */
export function formatLapTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "--:--.---";
  const total = Math.floor(ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;
}

/** Signed delta against a reference time: `-0.482` / `+1.204`. */
export function formatDelta(ms: number): string {
  if (!Number.isFinite(ms)) return "--.---";
  const sign = ms < 0 ? "-" : "+";
  const abs = Math.abs(ms);
  return `${sign}${(abs / 1000).toFixed(3)}`;
}

/** `1234567` -> `1,234,567`. XP and drift scores. */
export function formatNumber(value: number | bigint): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** Compact XP for tight HUD space: `12.4K`, `1.2M`. */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** `7xKq...9Fh2` — wallet pubkeys and signatures. */
export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** Ordinal race position: 1st, 2nd, 3rd, 4th. */
export function formatOrdinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]!);
}

/** m/s -> km/h, rounded. The speedometer unit. */
export function msToKph(metersPerSecond: number): number {
  return Math.round(metersPerSecond * 3.6);
}
