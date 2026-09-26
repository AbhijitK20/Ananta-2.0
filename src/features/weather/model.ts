/**
 * The weather model: the one place in the codebase that decides whether a record is
 * still a candidate under the sky the traveller is standing under.
 *
 * Why this file has to exist, given the contract already carries a `weather` field
 * on the context and a `weatherSensitive` label on every record:
 *
 *   - `WeatherNow` was a display value. Nothing read it while choosing.
 *   - `weather_unsafe` was in `RejectionCode` and unreachable from anywhere.
 *   - `docs/EVAL_SPEC.md` §19 already demands that a heavy-rain context kills the
 *     outdoor records and keeps the `covered` ones, and nothing implemented it.
 *
 * A badge on the card is not a constraint. Rain has to remove the street and put
 * the traveller under a roof BEFORE the packer sees a candidate, and heat has to
 * thin out the exposed ones. That is this file, plus `pipeline.ts` which hangs it
 * off the real retrieve -> filter -> score -> pack -> replan path.
 *
 * Four rules, all load-bearing:
 *
 *  1. **Deterministic.** No `Date`, no clock, no randomness, no network. The same
 *     context and the same record always give the same verdict, which is what lets
 *     the A/B assertions in `__tests__` be real assertions about behaviour rather
 *     than about a snapshot.
 *  2. **A table, not a decision tree.** `SEAL_AT` says, per `weatherSensitive`
 *     label, the severity at which each hazard seals the record; `CONDITIONS` says,
 *     per condition, the severity of each hazard. A new condition or a new label
 *     is one row, not a new branch — and the diff shows which row moved the plan.
 *  3. **Nothing here widens the frozen contract.** The traveller's own weather
 *     sensitivity and indoor preference already arrive as `avoid` tokens
 *     (`WEATHER_TOKENS`, `INDOOR_TOKEN` from the editor, which are the names
 *     `docs/ARCHITECTURE.md` §9 requires the engine to honour), so they are read
 *     from there rather than from a new field nobody agreed to.
 *  4. **When, not just what.** The context carries `nowMin` and `availableMin`, and
 *     `docs/EVAL_SPEC.md` §20 is titled "Heat wave, 11:00-16:00". A heat gate that
 *     cannot tell 11:00 from 19:00 is a thermometer, not a gate: the same 41°C is a
 *     refusal at noon and a merely bad idea after sunset. The clock arithmetic is
 *     `timing.ts`, the calendar arithmetic is `season.ts`, and this file decides.
 *
 * Every threshold below is a documented heuristic, not truth. That is acceptable
 * here and only here: the gate is interrogable — `WeatherVerdict.reason` is the
 * sentence the traveller reads, with the condition, the hour and the record's own
 * label in it, so a wrong threshold is a bug someone can point at rather than a
 * shrug.
 */
import {
  type DiscoveryContext,
  type Experience,
  type IndoorOutdoor,
  type Rejection,
  type ScoreComponent,
  type WeatherNow,
} from "../../contracts";
import { INDOOR_TOKEN, WEATHER_TOKENS } from "../discovery/context";
import {
  type SeasonEnv,
  NO_SEASON,
  monsoonExposure,
  monsoonReason,
  seasonOf,
} from "./season";
import {
  type HeatExposure,
  type TimeBand,
  type Window,
  WHOLE_DAY,
  HEAT_EXPOSURE_WEIGHT,
  at,
  heatExposure,
  timingMiss,
  windowOf,
} from "./timing";

/** Bumped whenever a threshold changes, so an old score stays auditable. */
export const WEATHER_POLICY_VERSION = "weather-2";

export type HazardKind = "rain" | "heat" | "wind";

/** 0 nothing to avoid · 1 degraded · 2 ruins the visit. Nothing goes above 2. */
export type Severity = 0 | 1 | 2;

/**
 * A severity no condition can reach, so `weatherSensitive: "none"` is a row in
 * `SEAL_AT` like the others instead of a special case in the loop.
 */
const NEVER = 3;

const KINDS: readonly HazardKind[] = ["rain", "heat", "wind"];

/** What each `WeatherNow.condition` does to each hazard. The whole input table. */
const CONDITIONS: Record<WeatherNow["condition"], Record<HazardKind, Severity>> = {
  clear: { rain: 0, heat: 0, wind: 0 },
  cloudy: { rain: 0, heat: 0, wind: 0 },
  light_rain: { rain: 1, heat: 0, wind: 0 },
  heavy_rain: { rain: 2, heat: 0, wind: 0 },
  storm: { rain: 2, heat: 0, wind: 2 },
  heat: { rain: 0, heat: 2, wind: 0 },
  wind: { rain: 0, heat: 0, wind: 1 },
};

/**
 * 33°C is "hydrate and keep moving"; 38°C is "do not stand in the open". Applied on
 * top of the condition, never instead of it, because a forecast that says `clear`
 * at 41°C is still a heatwave — `content/evaluation/scenarios.jsonl` §20 sets
 * `condition: "heat"` and 41°C together and the engine must handle either.
 */
const HEAT_MILD_C = 33;
const HEAT_SEVERE_C = 38;

/**
 * One-word labels for the sentence. These duplicate the private `CONDITION_WORDS` in
 * `../discovery/context`; that map is not exported and that folder belongs to
 * another stream, so a seven-string duplication beats editing their file. If the
 * contract ever grows a display-name field, both maps die together.
 */
const LABELS: Record<WeatherNow["condition"], string> = {
  clear: "Clear skies",
  cloudy: "Overcast",
  light_rain: "Light rain",
  heavy_rain: "Heavy rain",
  storm: "A storm",
  heat: "Peak heat",
  wind: "High wind",
};

const HAZARD_TEXT: Record<HazardKind, string> = {
  rain: "rain",
  heat: "heat",
  wind: "wind",
};

/**
 * How much of the visit is outside. 0 is the only value the gate ignores, and 2 is
 * where weather starts being able to ruin the place: `covered` exists in the enum
 * precisely so a record can be outdoors and still survive a monsoon, which is what
 * `content/events/README.md` means by "a `covered` record that survives the monsoon
 * weather gate".
 */
const SHELTER: Record<IndoorOutdoor, number> = {
  indoor: 0,
  covered: 1,
  mixed: 2,
  outdoor: 3,
};

/** Shelter at or above this is enough outside for the weather to ruin it. */
export const EXPOSED_AT = 2;

/** Fully open air. The one shelter level `indoors_only` forbids outright. */
const OPEN_AIR = 3;

/**
 * The gate. Per `weatherSensitive` label, the severity of each hazard at which the
 * record leaves the candidate set. `NEVER` sits above the `Severity` range on
 * purpose, so "this label does not care about that hazard" is a value in the table
 * rather than a missing key.
 *
 *  - `none` — the record says weather does not touch it. Never sealed.
 *  - `rain` / `heat` / `wind` — sealed by its own hazard only, and `heat`/`wind`
 *    need severity 2: 33°C does not close the Bandstand, 41°C does.
 *  - `any` — "true when weather ruins it", the contract's own words, so any real
 *    rain seals it and heat/wind need severity 2.
 *
 * `docs/EVAL_SPEC.md` §19 is the test: `col-gateway-of-india` is `outdoor` + `any`,
 * and a `heavy_rain` context must kill it.
 */
/**
 * The gate. Per `weatherSensitive` label, the severity at which the record's *own*
 * named hazard seals it. `NEVER` sits above the `Severity` range on purpose, so
 * "this label does not care about that hazard" is a value in the table rather than
 * a missing key.
 *
 *  - `none` — the record says weather does not touch it. Sealed only by the severe
 *    floor below, never by a label.
 *  - `rain` / `heat` / `wind` — sealed by its own hazard, and only when that hazard
 *    is *severe*. This is the shipped eval's position rather than a preference:
 *    `content/evaluation/scenarios.jsonl` §1 keeps `col-sassoon-steps-sketch` — an
 *    open-air life-drawing class — in the acceptable set for a `light_rain`
 *    context, under an assertion called `noOutdoorStopWithoutJustification`. The
 *    eval is saying a shower costs a stop points and demands a written reason, and
 *    only a downpour closes it.
 *  - `any` — "true when weather ruins it", the contract's own words, so any
 *    non-zero hazard seals it.
 *
 * A threshold of 2 for a named hazard is also what makes `adj-banganga` behave: a
 * stepped tank in the open, labelled `heat`, which §19 forbids under `heavy_rain`
 * with the reason `weather_unsafe`. A record that only admits to heat is still
 * standing in the rain.
 */
const SEAL_AT: Record<Experience["weatherSensitive"], Record<HazardKind, number>> = {
  none: { rain: NEVER, heat: NEVER, wind: NEVER },
  rain: { rain: 2, heat: NEVER, wind: NEVER },
  heat: { rain: NEVER, heat: 2, wind: NEVER },
  wind: { rain: NEVER, heat: NEVER, wind: 2 },
  any: { rain: 1, heat: 1, wind: 1 },
};

/**
 * The severe floor: a hazard at severity 2 closes open air whatever the record says
 * about itself.
 *
 * A physical minimum rather than a curation rule — a 45-minute downpour or a 41°C
 * afternoon does not care that a record was labelled for some other hazard — and it
 * is what the shipped eval assumes. It is also what keeps the `none` label honest:
 * 58 indoor records and four outdoor ones say weather does not touch them, and none
 * of them can talk their way out of a storm.
 */
const SEVERE = 2;

/** Points per shelter level per severity step. Scaled by `CARES`, capped below. */
const PENALTY_PER_LEVEL = 4;

/**
 * The contract does not fix the engine's score scale, so an uncapped weather term
 * could swamp every other term in a breakdown whose calibration we cannot see. The
 * gate is what enforces the constraint; the penalty only has to reorder candidates
 * that are all legal, so a bounded term is enough.
 */
const MAX_PENALTY = 30;

/** One band of `bestTimeOfDay` missed. Two is the worst that is still soft. */
const TIMING_PER_BAND = 8;

/** How much the record's own label says it cares, for the soft penalty. A record
 *  that names the exact hazard cares more than one that says "any weather", and a
 *  record that says "none" is driven by shelter alone. */
const CARES: Record<Experience["weatherSensitive"], number> = {
  none: 1,
  rain: 1.5,
  heat: 1.5,
  wind: 1.5,
  any: 1.25,
};

/** `weather_averse` in `avoid`: one step less tolerance, twice the penalty. */
const AVERSE_MULT = 2;

const SHELTER_TEXT: Record<number, string> = {
  0: "indoors",
  1: "covered",
  2: "partly outside",
  3: "outdoors",
};

const CARES_TEXT: Record<Experience["weatherSensitive"], string> = {
  none: "fine in any weather",
  rain: "ruined by rain",
  heat: "ruined by heat",
  wind: "ruined by wind",
  any: "ruined by any weather",
};

const BAND_TEXT: Record<TimeBand, string> = {
  early_morning: "early morning",
  morning: "morning",
  afternoon: "afternoon",
  evening: "evening",
  night: "night",
};

// ---------------------------------------------------------------------------
// The profile: the traveller's sky, place and hour, resolved once per call
// ---------------------------------------------------------------------------

/** What the caller knows beyond the `WeatherNow` on the context. All optional. */
export type WeatherEnv = {
  /** When the traveller will actually be out. Defaults to the whole day. */
  window?: Window;
  /** 1-12, or null/undefined when nobody said. The season gate stands down. */
  month?: number | null;
  monsoonMonths?: readonly number[];
};

export type WeatherProfile = {
  condition: WeatherNow["condition"];
  tempC: number;
  /** `simulated` and `live` must produce identical verdicts. Metadata, not input. */
  source: WeatherNow["source"];
  hazards: Record<HazardKind, Severity>;
  /** Worst hazard, 0 when the sky is fine. Time-invariant: it is the air, not the clock. */
  severity: Severity;
  /** Which hazard is driving the decision. Null when the sky is fine. */
  dominant: HazardKind | null;
  /** When the traveller will be out, and therefore how much sun they meet. */
  window: Window;
  heatExposure: HeatExposure;
  season: SeasonEnv;
  /** `avoid` carries `weather_averse` (the editor's "high" sensitivity). */
  averse: boolean;
  /** `avoid` carries `indoors_only`. */
  indoorOnly: boolean;
  /** "Heavy rain, 25°C" — the numbers the traveller was given, not new ones. */
  summary: string;
};

/**
 * The whole `WeatherNow` -> hazard translation, plus the clock and the calendar.
 * Pure, and the only place a temperature threshold is applied.
 *
 * Note what `profile()` deliberately does NOT do: it does not soften a hazard
 * because the hour is convenient. 41°C at 19:00 is still 41°C, and pretending
 * otherwise would be the gate lying about the weather. The hour is carried
 * separately as `heatExposure` and used to decide severity of *exposure*, not of
 * temperature.
 */
export function profile(weather: WeatherNow, avoid: readonly string[] = [], env: WeatherEnv = {}): WeatherProfile {
  const base = CONDITIONS[weather.condition];
  const byTemp: Severity = weather.tempC >= HEAT_SEVERE_C ? 2 : weather.tempC >= HEAT_MILD_C ? 1 : 0;
  const hazards: Record<HazardKind, Severity> = {
    rain: base.rain,
    heat: Math.max(base.heat, byTemp) as Severity,
    wind: base.wind,
  };
  const worst = KINDS.reduce<Severity>((acc, kind) => (hazards[kind] > acc ? hazards[kind] : acc), 0);
  const window = env.window ?? WHOLE_DAY;
  return {
    condition: weather.condition,
    tempC: weather.tempC,
    source: weather.source,
    hazards,
    severity: worst,
    dominant: worst === 0 ? null : (KINDS.find((kind) => hazards[kind] === worst) ?? null),
    window,
    heatExposure: heatExposure(window),
    season: env.month === undefined || env.month === null
      ? NO_SEASON
      : { month: env.month, monsoonMonths: env.monsoonMonths ?? NO_SEASON.monsoonMonths },
    averse: avoid.includes(WEATHER_TOKENS.high),
    indoorOnly: avoid.includes(INDOOR_TOKEN),
    summary: `${LABELS[weather.condition]}, ${Math.round(weather.tempC)}°C`,
  };
}

/** The profile a `DiscoveryContext` implies: its window, its sky, its preferences. */
export function profileFor(ctx: DiscoveryContext, env: WeatherEnv = {}): WeatherProfile {
  return profile(ctx.weather, ctx.avoid, { ...env, window: env.window ?? windowOf(ctx) });
}

/**
 * The lowest severity that is allowed to close a street.
 *
 * `docs/FEATURES.md` §125: "Never silently presented as a live forecast." The same
 * honesty applies to enforcement — we do not refuse to show someone the Gateway on
 * the strength of a forecast we do not have. So an `unknown` source can still refuse
 * on severe weather (a storm is worth acting on even if we are unsure) but never on
 * a mild one. A `simulated` forecast is treated exactly like a live one, because a
 * demo that plans differently from production is a demo that lies.
 */
function sealingFloor(p: WeatherProfile): number {
  return p.source === "unknown" ? 2 : 1;
}

/** How badly a hazard weighs on the soft penalty. Heat depends on the sun. */
function hazardWeight(p: WeatherProfile, kind: HazardKind): number {
  return kind === "heat" ? HEAT_EXPOSURE_WEIGHT[p.heatExposure] : 1;
}

// ---------------------------------------------------------------------------
// The verdict: one record, one sky, one hour, one month
// ---------------------------------------------------------------------------

export type SeasonVerdictSummary = {
  sealed: boolean;
  penalty: number;
  reason: string;
  inSeason: boolean;
  /** True for June-September, and the record keeps its best months there. */
  monsoon: boolean;
};

export type TimingVerdict = {
  /** Bands of `bestTimeOfDay` missed, 0-2. Null when the record states none. */
  miss: number | null;
  penalty: number;
  reason: string;
};

export type WeatherVerdict = {
  id: string;
  /** True when the gate removes it from the candidate set entirely. */
  sealed: boolean;
  /**
   * What closed it. `"weather"` is a fact about the sky, `"season"` about the
   * calendar, `"preference"` is the traveller's own `indoors_only` request, and the
   * three are reported under different `RejectionCode`s so the panel never blames
   * the weather for a decision the calendar or the traveller made.
   */
  cause: "weather" | "season" | "preference" | null;
  /** The hazard responsible, or null in fine weather. */
  hazard: HazardKind | null;
  severity: Severity;
  /** Weather points to subtract from the engine's score. 0 in fine weather. */
  penalty: number;
  /** A finished sentence with the real numbers. Empty when there is nothing to say. */
  reason: string;
  /** Ready for `FeasibleResult.rejected`. Null unless `sealed`. */
  rejection: Rejection | null;
  /** The calendar half. Null when no month is known or the record is in season. */
  season: SeasonVerdictSummary | null;
  /** The clock half. Null when the record states no `bestTimeOfDay`. */
  timing: TimingVerdict | null;
  /** 0-3, for the report and for anything that wants to rank by exposure. */
  shelter: number;
};

/**
 * The decision. One record, one profile, no I/O.
 *
 * `sealed` is a hard constraint: the record must not reach the scorer or the
 * packer, and it must come back as a rejection so the "why you are not seeing this"
 * panel has a sentence. `penalty` is the soft half and only matters for records that
 * stay legal — the covered verandah that is still the best answer in a shower,
 * ranked under the room with the roof on it.
 *
 * One input here is not weather and not the calendar: `indoors_only`. That is
 * deliberate. The editor lowers the preference into `avoid` because the frozen
 * context has no field for it, and a token the engine ignores is worse than no
 * token. It seals a fully open-air record whatever the sky is doing, because
 * "nothing that needs you to be outside" is a statement of intent, not a forecast.
 */
export function assess(p: WeatherProfile, exp: Experience): WeatherVerdict {
  const shelter = SHELTER[exp.indoorOutdoor];
  const exposed = shelter >= EXPOSED_AT;
  const thresholds = SEAL_AT[exp.weatherSensitive];
  const floor = sealingFloor(p);

  /**
   * Heat closes a record only when the traveller is out in the sun. The air does not
   * cool because the evening came round, so the hazard stays at 2 and the *penalty*
   * is scaled down instead — but refusing to send anyone out at 19:00 because the
   * sun is down would be the gate lying about the weather, which is the one thing
   * this feature exists to avoid.
   */
  const closing = (kind: HazardKind): Severity =>
    kind === "heat" && p.heatExposure !== "peak" ? 0 : p.hazards[kind];

  // `weather_averse` lowers every threshold one step, never below 1, so a traveller
  // who has told us they hate weather is not exposed to mild anything. The severe
  // floor is not a threshold and does not move: a storm is a storm whatever the
  // traveller is used to.
  const weatherSeal: HazardKind | null = exposed
    ? (KINDS.find((kind) => {
      const hazard = closing(kind);
      if (hazard >= floor && hazard >= SEVERE) return true;
      const wanted = p.averse ? Math.max(1, thresholds[kind] - 1) : thresholds[kind];
      return hazard >= wanted && hazard >= floor;
    }) ?? null)
    : null;
  const season = seasonOf(exp, p.season);
  const seasonClose = season !== null && season.seals;
  const indoorsOnlySeal = weatherSeal === null && !seasonClose && p.indoorOnly && shelter >= OPEN_AIR;

  const severity: Severity = weatherSeal === null ? 0 : closing(weatherSeal);
  const hazardLoad = KINDS.reduce((sum, kind) => sum + p.hazards[kind] * hazardWeight(p, kind), 0);
  const raw = p.severity === 0
    ? 0
    : shelter * PENALTY_PER_LEVEL * CARES[exp.weatherSensitive] * (p.averse ? AVERSE_MULT : 1) * hazardLoad;
  const penalty = p.severity === 0 ? 0 : Math.min(MAX_PENALTY, Math.round(raw));

  const cause: WeatherVerdict["cause"] = weatherSeal !== null
    ? "weather"
    : seasonClose
      ? "season"
      : indoorsOnlySeal
        ? "preference"
        : null;

  const hour = `${at(p.window.fromMin)} to ${at(p.window.toMin)}`;
  const reason = weatherSeal === "heat"
    ? `${p.summary}, and you are out ${hour} with the sun up. ${exp.name} is ${SHELTER_TEXT[shelter]}, so the heat takes it out of the plan.`
    : weatherSeal !== null
      ? `${p.summary}. ${exp.name} is ${SHELTER_TEXT[shelter]}, and its record says it is ${CARES_TEXT[exp.weatherSensitive]}, so the ${HAZARD_TEXT[weatherSeal]} takes it out of the plan.`
      : indoorsOnlySeal
        ? `${exp.name} is ${SHELTER_TEXT[shelter]}, and you asked for indoors only, so it cannot go in this plan.`
        : p.severity > 0
          ? `${p.summary}. ${exp.name} is ${SHELTER_TEXT[shelter]}, so it is down-weighted rather than dropped.`
          : "";

  const miss = timingMiss(exp.bestTimeOfDay, p.window);
  const timing: TimingVerdict | null = miss === null || miss === 0
    ? null
    : {
      miss,
      penalty: miss * TIMING_PER_BAND,
      reason: `It is best in the ${exp.bestTimeOfDay.map((band) => BAND_TEXT[band] ?? band).join(" or ")}, and you are looking at ${hour}.`,
    };
  const monsoonPoints = seasonClose ? 0 : monsoonExposure(exp, p.season) + Math.round((season?.missRatio ?? 0) * 12);

  return {
    id: exp.id,
    sealed: cause !== null,
    cause,
    hazard: weatherSeal,
    severity,
    penalty,
    reason,
    rejection: cause === null
      ? null
      : {
          experienceId: exp.id,
          // Three causes, three codes they deserve: a statement about the sky, one
          // about the calendar, one about the traveller's own request.
          code: cause === "weather"
            ? "weather_unsafe"
            : cause === "season"
              ? "seasonal_mismatch"
              : "excluded_by_traveller",
          message: cause === "season" && season ? season.reason : reason,
          shortfall: null,
          unit: null,
          // No relaxation fixes weather except changing the weather, and the
          // relaxation ladder must not offer to ignore a monsoon.
          relaxable: false,
        },
    season: season === null || (season.inSeason && monsoonPoints === 0)
      ? null
      : {
        sealed: seasonClose,
        penalty: Math.min(MAX_PENALTY, monsoonPoints),
        reason: seasonClose
          ? (season.reason ?? reason)
          : [season.reason, monsoonReason(exp, p.season)].filter(Boolean).join(" "),
        inSeason: season.inSeason,
        monsoon: season.monsoon && season.monsoonNative,
      },
    timing,
    shelter,
  };
}

/**
 * Every score term this feature contributes, in ledger order: the sky, then the
 * calendar, then the clock. Empty in fine weather at a sensible hour in season, so
 * a clear-sky breakdown is byte-identical to the engine's and "the weather did not
 * change anything" stays an observable fact rather than an assumption.
 */
export function verdictComponents(verdict: WeatherVerdict): ScoreComponent[] {
  const out: ScoreComponent[] = [];
  if (verdict.penalty > 0) {
    out.push({ key: "weather", label: "Weather", value: -verdict.penalty, weight: 1, reason: verdict.reason });
  }
  const season = verdict.season;
  if (season && season.penalty > 0) {
    out.push({ key: "season", label: "Season", value: -season.penalty, weight: 1, reason: season.reason });
  }
  const timing = verdict.timing;
  if (timing) {
    out.push({ key: "timing", label: "Time of day", value: -timing.penalty, weight: 1, reason: timing.reason });
  }
  return out;
}
