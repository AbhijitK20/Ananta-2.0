/**
 * The clock, as arithmetic. Minutes from local midnight, integers, no `Date`.
 *
 * This file exists because "when" is the second half of weather-aware planning and
 * it was missing entirely. A heat gate that cannot tell 11:00 from 19:00 is not a
 * heat gate, it is a thermometer: `docs/EVAL_SPEC.md` §20 is literally titled
 * "Heat wave, 11:00-16:00", and the traveller's `DiscoveryContext` already carries
 * everything needed to honour that title — `nowMin` and `availableMin`.
 *
 * The band table below is not a guess. It is fitted to the shipped catalogue: read
 * the first opening hour of every record in `content/experiences/*.jsonl` and group
 * it by the record's own `bestTimeOfDay`, and the clusters fall where these edges
 * are — `night` records open at 20:00 and 21:00, `morning` records at 07:00-10:00,
 * `early_morning` at 05:00-07:00. Change the table and the data stops agreeing.
 *
 * Two things this file refuses to do:
 *
 *  - **Decide anything.** It answers "what time is it" and "is this window inside
 *    those hours". Whether that matters is `model.ts`'s decision, and it is the
 *    decision that has to be auditable.
 *  - **Pretend a day is a circle.** `Minutes` is 0..1440 and a plan that starts at
 *    23:30 and ends at 00:30 has to be handled, which `content/evaluation/README.md`
 *    §85 records as an open question for the packer. Here it is just arithmetic:
 *    every helper takes a window that may cross midnight and splits it, because a
 *    gate that silently ignored the second half of a wrapping night would seal
 *    nothing at 23:30 and everything at 00:30.
 */

/** The five bands `Experience.bestTimeOfDay` is allowed to use. */
export type TimeBand = "early_morning" | "morning" | "afternoon" | "evening" | "night";

/** Circular order. `night` is followed by `early_morning` because that is the day. */
export const BAND_ORDER: readonly TimeBand[] = [
  "early_morning",
  "morning",
  "afternoon",
  "evening",
  "night",
];

/**
 * Clock edges, minutes from local midnight. `night` wraps: 20:00 to 05:00.
 *
 * Fitted to the shipped records' own opening hours (see the file header). The one
 * visible exception is 24/7 public space — the Bandstand and the sea walls declare
 * `evening` and open at 05:00 — which is correct and is exactly why `bestTimeOfDay`
 * is only ever a penalty here and never a closure: for those records the field
 * means "worth it at sunset", not "open at sunset".
 */
export const BAND_CLOCK: Record<TimeBand, { start: number; end: number }> = {
  early_morning: { start: 300, end: 480 },
  morning: { start: 480, end: 660 },
  afternoon: { start: 660, end: 1020 },
  evening: { start: 1020, end: 1200 },
  night: { start: 1200, end: 300 },
};

/**
 * When the sun is the problem rather than the thermometer. 11:00-17:00, and this
 * band is the only thing that turns a hot day into a refusal rather than a
 * penalty. Mumbai, and a documented judgement: the records that carry
 * `weatherSensitive: "heat"` describe shade, water and "not at midday", not
 * temperature as such.
 */
export const PEAK_SUN: { start: number; end: number } = { start: 660, end: 1020 };

/** The warm shoulder either side of it. Hot, but not the worst of it. */
export const WARM_SHOULDER: { start: number; end: number } = { start: 540, end: 1140 };

/** A stretch of the traveller's day. `toMin` may exceed 1440 when the day wraps. */
export type Window = { fromMin: number; toMin: number };

/**
 * No time information at all: every hour is in play, so the worst hour counts.
 * The default for a bare `WeatherNow`, and the conservative choice — a gate asked
 * "when?" with no answer must not answer "evening, conveniently".
 */
export const WHOLE_DAY: Window = { fromMin: 0, toMin: 1440 };

/** Split a possibly-wrapping clock range into linear pieces inside one day. */
function pieces(start: number, end: number): Array<[number, number]> {
  const from = ((start % 1440) + 1440) % 1440;
  const to = ((end % 1440) + 1440) % 1440;
  // A full day is expressed as 0..1440, which must stay one piece and not become
  // "wraps all the way round" — otherwise the whole day reads as zero minutes.
  if (start === 0 && end === 1440) return [[0, 1440]];
  return to <= from ? [[from, 1440], [0, to]] : [[from, to]];
}

const overlap = (a: [number, number], b: [number, number]): number =>
  Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/** Minutes of `window` that fall inside the clock range `[start, end)`. */
export function minutesInside(window: Window, start: number, end: number): number {
  const band = pieces(start, end);
  let total = 0;
  for (const span of pieces(window.fromMin, window.toMin)) {
    for (const slice of band) total += overlap(span, slice);
  }
  return total;
}

/** True when any part of the window is in those hours. */
export function overlaps(window: Window, start: number, end: number): boolean {
  return minutesInside(window, start, end) > 0;
}

/** `1020` -> `"17:00"`. The only place minutes become a clock in this feature. */
export function at(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The band a single minute falls in. */
export function timeBand(min: number): TimeBand {
  const at = ((Math.round(min) % 1440) + 1440) % 1440;
  for (const band of BAND_ORDER) {
    const { start, end } = BAND_CLOCK[band];
    if (start < end ? at >= start && at < end : at >= start || at < end) return band;
  }
  return "night";
}

/**
 * How far apart two bands are, 0 for the same one and at most 2.
 *
 * Circular, not linear: `night` and `early_morning` are neighbours (05:00 follows
 * 20:00) and a linear index would call them four bands apart, which would make an
 * early-morning walk look like a catastrophic mis-timing when it is a 05:00 start
 * on the same night.
 */
export function bandDistance(a: TimeBand, b: TimeBand): number {
  const steps = Math.abs(BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b));
  return Math.min(steps, BAND_ORDER.length - steps);
}

/** The bands in which being outside is worst, best, and in between. */
export type HeatExposure = "peak" | "high" | "none";

/**
 * How exposed the traveller's window is to the sun.
 *
 * `"peak"` is the refusal band — the gate will close an exposed record. `"high"`
 * and `"none"` only ever cost points, because 41°C at 19:00 is still 41°C and
 * refusing to send anyone outdoors because the sun is down would be the weather
 * gate lying about the weather.
 */
export function heatExposure(window: Window): HeatExposure {
  if (overlaps(window, PEAK_SUN.start, PEAK_SUN.end)) return "peak";
  return overlaps(window, WARM_SHOULDER.start, WARM_SHOULDER.end) ? "high" : "none";
}

/** Multiplier on the heat penalty. A judgement, and named so it can be argued with. */
export const HEAT_EXPOSURE_WEIGHT: Record<HeatExposure, number> = { peak: 1, high: 0.7, none: 0.45 };

/**
 * The window a context implies: `nowMin` for `availableMin` minutes.
 *
 * The only place a `DiscoveryContext` is turned into a stretch of the day. Every
 * downstream question about "when" goes through here.
 */
export function windowOf(ctx: { nowMin: number; availableMin: number }): Window {
  return { fromMin: ctx.nowMin, toMin: ctx.nowMin + ctx.availableMin };
}

/**
 * How badly the traveller's window misses the record's own best hours. 0 means at
 * least one hour in the window suits it.
 *
 * `null` when the record states no preference, which is not the same as "any time
 * is fine" — it is an absence of curation, and the contract is explicit that an
 * unpopulated field must not collapse into a confident answer.
 *
 * The minimum across the bands the window covers, not the maximum, and that is the
 * load-bearing choice: the packer picks the arrival time, so a stop is mistimed
 * only when *no* hour in the window suits it. A 16:00-18:00 window proposing an
 * `evening` record is a good suggestion, and a maximum would have called it a
 * one-band mistake.
 */
export function timingMiss(best: readonly TimeBand[], window: Window): number | null {
  if (best.length === 0) return null;
  let best_ = Number.POSITIVE_INFINITY;
  let covered = false;
  for (const band of BAND_ORDER) {
    const { start, end } = BAND_CLOCK[band];
    if (minutesInside(window, start, end) <= 0) continue;
    covered = true;
    best_ = Math.min(best_, ...best.map((preferred) => bandDistance(band, preferred)));
  }
  // Unreachable for a positive-length window, but returning a confident 0 for "I
  // could not tell what time it is" is exactly the failure this feature exists to
  // avoid, so fall back to the band the window starts in.
  return covered ? best_ : bandDistance(timeBand(window.fromMin), best[0] as TimeBand);
}
