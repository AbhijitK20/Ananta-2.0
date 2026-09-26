/**
 * The Date <-> minutes-from-midnight boundary. The canonical helper is Abhijit's
 * `src/lib/time.ts`; this is the provider-local stand-in so nothing lands in his
 * directory. Delete and re-export the moment that file exists.
 *
 * ponytail: ceiling — local ISO-date strings only (`YYYY-MM-DD`), no timezone
 * handling. Add date-fns-free zone maths only when a booking must survive a
 * flight between the provider and the traveller.
 */
export const MINUTES_PER_DAY = 1440;

/** `"09:30"` -> `570`. `"24:00"` -> `1440`. Null when unparsable. */
export function hhmmToMin(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (minutes > 59) return null;
  if (hours > 24 || (hours === 24 && minutes > 0)) return null;
  return hours * 60 + minutes;
}

/** `570` -> `"09:30"`. Minutes are integers by contract, so no rounding. */
export function minToHHMM(min: number): string {
  const hours = Math.floor(min / 60);
  const minutes = min % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** `"09:30"` -> `"9:30"`. Display only. */
export function minToLabel(min: number): string {
  return minToHHMM(min).replace(/^0/, "");
}

/** True only for a real calendar date, so `2026-02-31` is rejected. */
export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** ISO dates sort lexicographically, so this is a real comparison. */
export function isOnOrAfter(date: string, today: string): boolean {
  return date >= today;
}

export function isISODateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}
