/**
 * Two formatters, because the contract says a `Rejection.message` and a
 * `ContextChange.narrative` must be finished sentences with real numbers in
 * them. Minutes are integer minutes from local midnight and money is integer
 * minor units, so both need a display edge somewhere. This is ours: the app
 * owns the design-system one, and may replace these.
 */
import type { Money } from "../../contracts";

/** 90 -> "1h 30m". 120 -> "2h". 45 -> "45m". */
export function hm(min: number): string {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** 84000 minor INR -> "₹840". */
export function money(value: Money | number | null | undefined): string {
  if (value === null || value === undefined) return "no limit";
  const minor = typeof value === "number" ? value : value.minor;
  const currency = typeof value === "number" ? "INR" : value.currency;
  if (currency === "INR") return `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

/** "1 stop" / "2 stops". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
