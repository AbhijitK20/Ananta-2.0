/**
 * Formatting for analytics copy. Feature-local on purpose: `src/lib` is another
 * stream's file and may not exist yet, and a broken import in a parallel
 * session is worse than twenty lines of duplication.
 *
 * Deterministic on purpose too: no `Intl`/`toLocaleString`, because grouping
 * separators depend on the ICU build and we assert on these strings in tests.
 */
import type { TimeBucket } from "./types";

/** Integer minor units to a rupee string. 50000 -> "₹500", 150000 -> "₹1,500". */
export function formatInr(minor: number | null): string {
  if (minor === null) return "no limit stated";
  const rupees = Math.round(minor / 100);
  return `₹${group(Math.abs(rupees))}${rupees < 0 ? "-" : ""}`;
}

function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Minutes from midnight to "17:00". */
export function formatClock(min: number): string {
  const clamped = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 95 -> "1h 35m", 60 -> "1h", 45 -> "45m". */
export function formatMinutes(min: number): string {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? "no data" : `${Math.round(ratio * 100)}%`;
}

export function formatCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** ISO datetime -> "26 Sep". Used on trend axes. */
export function formatDay(isoDate: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [, m, d] = isoDate.split("-");
  const month = months[Number(m) - 1] ?? m;
  return `${Number(d)} ${month}`;
}

// --- time windows ---------------------------------------------------------
// Reuses the contract's `bestTimeOfDay` vocabulary instead of inventing hours.

export const TIME_BUCKETS: readonly TimeBucket[] = [
  "early_morning",
  "morning",
  "afternoon",
  "evening",
  "night",
] as const;

const BUCKET_RANGE: Record<TimeBucket, { from: number; to: number; label: string }> = {
  early_morning: { from: 0, to: 480, label: "Early morning, 00:00-08:00" },
  morning: { from: 480, to: 720, label: "Morning, 08:00-12:00" },
  afternoon: { from: 720, to: 960, label: "Afternoon, 12:00-16:00" },
  evening: { from: 960, to: 1200, label: "Evening, 16:00-20:00" },
  night: { from: 1200, to: 1440, label: "Night, 20:00-24:00" },
};

/** Minutes from midnight -> the contract's time-of-day bucket. */
export function timeBucketOf(minFromMidnight: number): TimeBucket {
  const m = ((Math.round(minFromMidnight) % 1440) + 1440) % 1440;
  for (const bucket of TIME_BUCKETS) {
    const range = BUCKET_RANGE[bucket];
    if (m >= range.from && m < range.to) return bucket;
  }
  return "night";
}

export function timeBucketLabel(bucket: TimeBucket): string {
  return BUCKET_RANGE[bucket].label;
}

/** Three-letter axis label. "eve" reads on a heat grid; "16:00-20:00" does not. */
export function timeBucketShort(bucket: TimeBucket): string {
  switch (bucket) {
    case "early_morning":
      return "early";
    case "morning":
      return "morn";
    case "afternoon":
      return "aft";
    case "evening":
      return "eve";
    case "night":
      return "night";
  }
}

/**
 * The slot we would suggest for a time-of-day demand bucket. A documented
 * heuristic, not a claim about the traveller — the demand is the count, the
 * hour is our suggestion, and the UI says which is which.
 */
export function suggestedWindow(bucket: TimeBucket): { from: number; to: number } {
  switch (bucket) {
    case "early_morning":
      return { from: 420, to: 540 };
    case "morning":
      return { from: 600, to: 720 };
    case "afternoon":
      return { from: 900, to: 1020 };
    case "evening":
      return { from: 1020, to: 1140 };
    case "night":
      return { from: 1200, to: 1320 };
  }
}

export function describeWindow(from: number, to: number): string {
  return `${formatClock(from)}-${formatClock(to)}`;
}
