/**
 * Season: the constraint that is true whether or not anyone checked the forecast.
 *
 * `docs/DATA_SPEC.md` §191 says it outright — "Monsoon is the demo's best friend.
 * Jun-Sep in `monsoonMonths` flips the weather gate, which flips recommendations,
 * which is our best replan demo" — and nothing implements it. `CITY_MANIFEST`
 * carries `monsoonMonths`, `Experience` carries `bestMonths`, and
 * `RejectionCode.seasonal_mismatch` is unreachable from anywhere in the tree.
 *
 * Two records in the shipped catalogue are the reason this is worth building:
 *
 *   col-monsoon-film-walk   covered  rain  bestMonths [6,7,8,9]  hours "Jun-Su 16:00-19:00"
 *   md-monsoon-seawall      covered  rain  bestMonths [6,7,8,9]
 *
 * They exist for six weeks a year. That is a closure statement, and it is the only
 * kind of statement this file acts on.
 *
 * The rule, in one line, because it is the whole design:
 *
 *   > A hard closure needs **all three**: out of season, on the far side of the
 *   > year, and not under a roof. Anything less is a penalty.
 *
 * Why each third matters. `bestMonths` is curation — a cafe's list says what is
 * worth doing in December, not that the shutters are down in July, and the contract
 * puts opening hours in `hours`, which is the engine's hours adapter's business and
 * not a second closure rule invented here. Distance matters because being one month
 * outside a season is a shrug and being four is a different country. And shelter
 * matters because a monsoon deluge is survivable under a roof while a December-only
 * market is not running in July whoever you are.
 *
 * So the honest hard closure is narrow: a *seasonal programme* seen in the wrong
 * half of the year. Everything else costs points, and points are reversible in a
 * way that closures are not.
 *
 * The month is injected, never read from a clock, and the default is "no month".
 * That is blast-radius control, not laziness: `DiscoveryContext` has no date by
 * design — its own header calls out the midnight boundary as an open question — so
 * a season gate that guessed the month would be applying a constraint nobody asked
 * for. With no month every function here is inert and the 31 shipped eval
 * scenarios cannot move.
 */
import type { Experience, IndoorOutdoor } from "../../contracts";

/**
 * Mumbai, June to September. `docs/DATA_SPEC.md` §191 states it, and the shipped
 * records corroborate it: both seasonal programmes are `[6,7,8,9]`.
 */
export const MONSOON_MONTHS: readonly number[] = [6, 7, 8, 9];

/** Options for the one call that resolves "what time of year is it". */
export type SeasonEnv = {
  /** 1-12, or null when nobody said. Null means the season gate does not run. */
  month: number | null;
  monsoonMonths: readonly number[];
};

/** Nothing known about the date: the whole feature stands down. */
export const NO_SEASON: SeasonEnv = { month: null, monsoonMonths: MONSOON_MONTHS };

/**
 * Months out of season before a closure is allowed.
 *
 * Five, not three, and the number was moved by the data rather than by taste. At
 * three, a clear July day closed 69 of the 133 shipped records — including
 * `ban-church-bells`, a free forty minutes of standing in a lane listening to a
 * bell, which is not a thing a July visitor should be told they cannot do. The
 * monsoon baseline penalty and the out-of-season penalty already demote all of them;
 * a hard closure is the wrong instrument. At five, only the genuinely opposite
 * season closes: `ban-kite-festival` (`bestMonths: [12,1]`) in July, which is right.
 */
export const FAR_OFF_SEASON = 5;

export type SeasonVerdict = {
  month: number;
  /** The month is in the record's own list, or the record states no preference. */
  inSeason: boolean;
  /**
   * Circular months to the nearest listed month: 0 in season, 1 for a month either
   * side, 6 for the opposite side of the year.
   */
  distance: number;
  /** The record keeps at least one of its best months inside the monsoon. */
  monsoonNative: boolean;
  /** True when the month is in the monsoon. */
  monsoon: boolean;
  /** The hard closure, decided here so the reason and the flag cannot disagree. */
  seals: boolean;
  /** 0..1. Scales the out-of-season penalty. */
  missRatio: number;
  /** A finished sentence, or null when there is nothing to say. */
  reason: string;
};

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const monthName = (month: number): string => MONTH_NAMES[month] ?? "that month";

const isRoof = (kind: IndoorOutdoor): boolean => kind === "indoor" || kind === "covered";

/** Circular month distance: 0 is the same month, 6 is the opposite one. */
function monthDistance(month: number, target: number): number {
  const raw = Math.abs(month - target) % 12;
  return Math.min(raw, 12 - raw);
}

/**
 * Render a month list for a sentence.
 *
 * Circular, because a season that wraps the year end is the normal case and not an
 * edge case: `bestMonths: [12, 1]` is a December-and-January kite festival, and
 * sorting it would print "January to December" and invert the season in the one
 * sentence the traveller reads. A scattered list — `[11,12,1,2,3,6,7,8,9]`, which
 * means "all year" — is joined rather than given a false first-to-last shape.
 */
const listMonths = (months: readonly number[]): string => {
  if (months.length === 0) return "";
  const sorted = [...months].sort((a, b) => a - b);
  // A set is one unbroken run if walking forward from some member of it visits
  // exactly the set. Checking every start is twelve comparisons and it cannot be
  // fooled by the year boundary the way a sorted-step test can: `[11,12,1,2,3]`
  // sorts to `[1,2,3,11,12]`, whose middle step is eight, and a step test would call
  // a November-to-March season a scatter.
  const isRun = (start: number): boolean =>
    Array.from({ length: sorted.length }, (_, i) => ((start - 1 + i) % 12) + 1)
      .every((month) => months.includes(month));
  const first = sorted.find(isRun);
  if (first === undefined) return sorted.map(monthName).join(", ");
  const ordered = Array.from({ length: sorted.length }, (_, i) => ((first - 1 + i) % 12) + 1);
  const last = ordered[ordered.length - 1] as number;
  return ordered.length === 1 ? monthName(first) : `${monthName(first)} to ${monthName(last)}`;
};

/**
 * The whole season question for one record. `null` when no month is known, which is
 * the only way this feature can be inert.
 *
 * Pure and total: it never returns a closure the caller has to second-guess, and it
 * never reads a clock.
 */
export function seasonOf(exp: Experience, env: SeasonEnv): SeasonVerdict | null {
  const { month, monsoonMonths } = env;
  if (month === null) return null;
  const best = exp.bestMonths;
  const inSeason = best.length === 0 || best.includes(month);
  const distance = inSeason ? 0 : Math.min(...best.map((listed) => monthDistance(month, listed)));
  const underRoof = isRoof(exp.indoorOutdoor);
  const monsoon = monsoonMonths.includes(month);
  // A record that says weather does not touch it is never closed by a calendar. That
  // label is a more specific statement than a `bestMonths` list, which on a 24/7
  // public space like the Bandstand means "worth it at sunset" rather than "runs in
  // winter". Four outdoor records carry `none`, and closing them for being in July
  // would be the calendar overruling the curator.
  const weatherIndifferent = exp.weatherSensitive === "none";
  const seals = !inSeason && distance >= FAR_OFF_SEASON && !underRoof && !weatherIndifferent;
  const missRatio = inSeason ? 0 : Math.min(1, distance / 6);
  const reason = inSeason
    ? ""
    : seals
      ? `${exp.name} is best in ${listMonths(best)} and is ${exp.indoorOutdoor}, so ${monthName(month)} is the wrong half of the year for it.`
      : `Its best months are ${listMonths(best)}, and it is ${monthName(month)} now.`;

  return {
    month,
    inSeason,
    distance,
    monsoonNative: best.some((listed) => monsoonMonths.includes(listed)),
    monsoon,
    seals,
    missRatio,
    reason,
  };
}

/**
 * The monsoon baseline: a penalty for being outdoors between June and September
 * even under a clear sky.
 *
 * The one place this feature leans on a climatology rather than an observation, so
 * it is deliberately the weakest signal here: points only, never a closure, and a
 * sentence that says "plan for rain" instead of claiming it is raining. That is the
 * difference between a hedge and a lie, and it is what makes DATA_SPEC's promise
 * hold on a day the forecast got wrong.
 */
export function monsoonExposure(exp: Experience, env: SeasonEnv): number {
  const { month, monsoonMonths } = env;
  if (month === null || !monsoonMonths.includes(month) || isRoof(exp.indoorOutdoor)) return 0;
  return exp.indoorOutdoor === "outdoor" ? 10 : 4;
}

/** The sentence that goes with `monsoonExposure`, or null when it did not apply. */
export function monsoonReason(exp: Experience, env: SeasonEnv): string | null {
  if (monsoonExposure(exp, env) === 0) return null;
  return `June to September in Mumbai: plan for rain, not for a clear sky. ${exp.name} is ${exp.indoorOutdoor}.`;
}
