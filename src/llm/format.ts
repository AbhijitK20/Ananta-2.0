/**
 * Format helpers. The seam for `src/lib/money` and `src/lib/time` when those
 * land — three pure functions, no state, nothing to migrate.
 *
 * Money is integer minor units (the contract's rule). Floats never touch a
 * price here, and a price is never rendered without its currency.
 */

const MINUTES_PER_UNIT: Record<string, number> = {
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
};

/** "95 min" / "2 h 30 min". Never "0 min" — a zero-length window is a bug. */
export function formatMinutes(min: number): string {
  const total = Math.max(0, Math.round(min));
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

/** `100000` minor INR -> "₹1,000". Null money renders as "no cost". */
export function formatMoney(minor: number, currency = "INR"): string {
  const major = Math.round(minor) / 100;
  const body = major.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return `${SYMBOLS[currency] ?? `${currency} `}${body}`;
}

/** 570 -> "9:30am". Used in replies about "until 6pm". */
export function formatClock(minFromMidnight: number): string {
  const m = ((Math.round(minFromMidnight) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")}${suffix}`;
}

/** "1h30m" -> 90. The only place we accept a compact duration literal. */
export function parseDurationLiteral(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  const hm = /^(\d{1,2})\s*h(?:ours?|rs?)?\s*(\d{1,2})\s*m(?:in(?:utes?)?)?$/.exec(s);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const single = /^(\d{1,4}(?:\.\d+)?)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(s);
  if (!single) return null;
  const value = Number(single[1]);
  const unit = single[2] ?? "";
  const factor = MINUTES_PER_UNIT[unit];
  if (!factor || !Number.isFinite(value)) return null;
  return Math.round(value * factor);
}

/** Joins clauses into one sentence: ["a","b","c"] -> "a, b and c". */
export function sentence(parts: string[]): string {
  const clean = parts.map((p) => p.trim().replace(/[.\s]+$/, "")).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return `${clean[0]}.`;
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}.`;
}
