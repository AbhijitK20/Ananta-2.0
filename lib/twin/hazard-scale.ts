/**
 * Where the numbers are that turn a reading into a severity.
 *
 * This file exists because the same eleven physical thresholds were about to be
 * written in three places — the observation reader, the what-if controls and the
 * cascade — and the first time one of them moved the twin would report "heavy
 * rain" on one panel and "a shower" on another for the same weather.
 *
 * That is not a hypothetical. `lib/plan/route.ts` documents the same class of bug
 * in a different shape: the planner's day colours are asserted against a
 * separate list so the two cannot drift. This is the same defence, at a smaller
 * scale.
 *
 * The thresholds are a stated engineering judgement about outdoor hospitality, in
 * each hazard's own unit, and they are the single place a reader can go to argue
 * with them. They are not measurements, and the model says so wherever it reports.
 */

import type { HazardKind, ImpactSeverity } from "./types";

/**
 * The three step boundaries per hazard, in that hazard's unit.
 *
 *   rain  mm/h sustained      drizzle · proper wet · downpour
 *   heat  °C above 30         warm · oppressive · dangerous
 *   wind  km/h gust           fresh · gale · storm-force
 *   flood cm standing water   a low road goes · roads go · a city does
 *   storm hours remaining     an afternoon · a day · a multi-day event
 *
 * `heat` is measured against a 30 °C ceiling rather than an absolute temperature
 * because the relevant question is not "how hot" but "how far past what the trade
 * copes with", and a 34 °C day in a monsoon city is normal while the same day in
 * the Alps is not.
 *
 * `flood` is the outlier: the first step is only 5 cm, because 5 cm of standing
 * water is enough to close a low underpass. Nothing else in this table closes
 * anything at its lowest band.
 */
export const SEVERITY_THRESHOLDS: Readonly<Record<HazardKind, readonly [number, number, number]>> = {
  rain: [0.5, 7.5, 20],
  heat: [2, 6, 10],
  wind: [25, 50, 80],
  flood: [5, 20, 50],
  storm: [1, 4, 10],
};

/**
 * A step function, and deliberately so.
 *
 * The prior table in ./impact is written in whole severity steps, so a smoother
 * bridge would invent precision the prior does not have. The difference between
 * 40 and 60 mm/h is real, and it is carried in `HazardReading.intensity` and
 * printed in the UI — but it is not a claim that the prior resolves that finely,
 * and rounding it here is what keeps the two honest about each other.
 */
export function severityFromIntensity(hazard: HazardKind, intensity: number): ImpactSeverity {
  const [low, mid, high] = SEVERITY_THRESHOLDS[hazard];
  if (intensity < low) return 0;
  if (intensity < mid) return 1;
  if (intensity < high) return 2;
  return 3;
}

/** The unit each hazard is reported in. Also in one place, for the same reason. */
export const HAZARD_UNITS: Readonly<Record<HazardKind, string>> = {
  rain: "mm/h",
  heat: "°C over 30",
  wind: "km/h gust",
  flood: "cm standing",
  storm: "h remaining",
};
