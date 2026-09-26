/**
 * The weather model: the one place in the codebase that decides whether a record
 * is still a candidate under the sky the traveller is standing under.
 *
 * Why this file has to exist, given the contract already carries a `weather`
 * field on the context and a `weatherSensitive` label on every record:
 *
 *   - `WeatherNow` was a display value. Nothing read it while choosing.
 *   - `weather_unsafe` was in `RejectionCode` and unreachable from anywhere.
 *   - `docs/EVAL_SPEC.md` §19 already demands that a heavy-rain context kills
 *     the outdoor records and keeps the `covered` ones, and nothing implemented it.
 *
 * A badge on the card is not a constraint. Rain has to remove the street and put
 * the traveller under a roof BEFORE the packer sees a candidate, and heat has to
 * thin out the exposed ones. That is this file, plus `pipeline.ts` which hangs it
 * off the real retrieve -> filter -> score -> pack -> replan path.
 *
 * Three rules, all load-bearing:
 *
 *  1. **Deterministic.** No `Date`, no clock, no randomness, no network. The same
 *     context and the same record always give the same verdict, which is what lets
 *     the A/B assertions in `__tests__/weather.test.ts` be real assertions about
 *     behaviour rather than about a snapshot.
 *  2. **A table, not a decision tree.** `SEAL_AT` says, per `weatherSensitive`
 *     label, the severity at which each hazard seals the record; `CONDITIONS`
 *     says, per condition, the severity of each hazard. A new condition or a new
 *     label is one row, not a new branch — and the diff shows which row changed
 *     the plan.
 *  3. **Nothing here widens the frozen contract.** The traveller's own weather
 *     sensitivity and indoor preference already arrive as `avoid` tokens
 *     (`WEATHER_TOKENS`, `INDOOR_TOKEN` from the editor, which are the names
 *     `docs/ARCHITECTURE.md` §9 requires the engine to honour), so they are read
 *     from there rather than from a new field nobody agreed to.
 *
 * Every threshold below is a documented heuristic, not truth. That is acceptable
 * here and only here: the gate is interrogable — `WeatherVerdict.reason` is the
 * sentence the traveller reads, with the condition and the record's own label in
 * it, so a wrong threshold is a bug someone can point at rather than a shrug.
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

/** Bumped whenever a threshold changes, so an old score stays auditable. */
export const WEATHER_POLICY_VERSION = "weather-1";

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
 * 33°C is "hydrate and keep moving"; 38°C is "do not stand in the open". Applied
 * on top of the condition, never instead of it, because a forecast that says
 * `clear` at 41°C is still a heatwave — `content/evaluation/scenarios.jsonl` §20
 * sets `condition: "heat"` and 41°C together and the engine must handle either.
 */
const HEAT_MILD_C = 33;
const HEAT_SEVERE_C = 38;

/**
 * One-word labels for the sentence. These duplicate the private `CONDITION_WORDS`
 * in `../discovery/context`; that map is not exported and that folder belongs to
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
 * How much of the visit is outside. 0 is the only value the gate ignores, and 2
 * is where weather starts being able to ruin the place: `covered` exists in the
 * enum precisely so a record can be outdoors and still survive a monsoon, which
 * is what `content/events/README.md` means by "a `covered` record that survives
 * the monsoon weather gate".
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
 * `docs/EVAL_SPEC.md` §19 is the test: `col-gateway-of-india` is `outdoor` +
 * `any`, and a `heavy_rain` context must kill it.
 */
const SEAL_AT: Record<Experience["weatherSensitive"], Record<HazardKind, number>> = {
  none: { rain: NEVER, heat: NEVER, wind: NEVER },
  rain: { rain: 1, heat: NEVER, wind: NEVER },
  heat: { rain: NEVER, heat: 2, wind: NEVER },
  wind: { rain: NEVER, heat: NEVER, wind: 2 },
  any: { rain: 1, heat: 2, wind: 2 },
};

/** Points per shelter level per severity step. Scaled by `CARES`, capped below. */
const PENALTY_PER_LEVEL = 4;

/**
 * The contract does not fix the engine's score scale, so an uncapped weather term
 * could swamp every other term in a breakdown whose calibration we cannot see. The
 * gate is what enforces the constraint; the penalty only has to reorder candidates
 * that are all legal, so a bounded term is enough.
 */
const MAX_PENALTY = 30;

/**
 * How much the record's own label says it cares, for the soft penalty. A record
 * that names the exact hazard cares more than one that says "any weather", and a
 * record that says "none" is driven by shelter alone.
 */
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

// ---------------------------------------------------------------------------
// The profile: the traveller's sky, resolved once per call
// ---------------------------------------------------------------------------

export type WeatherProfile = {
  condition: WeatherNow["condition"];
  tempC: number;
  /** `simulated` and `live` must produce identical verdicts. Metadata, not input. */
  source: WeatherNow["source"];
  hazards: Record<HazardKind, Severity>;
  /** Worst hazard, 0 when the sky is fine. */
  severity: Severity;
  /** Which hazard is driving the decision. Null when the sky is fine. */
  dominant: HazardKind | null;
  /** `avoid` carries `weather_averse` (the editor's "high" sensitivity). */
  averse: boolean;
  /** `avoid` carries `indoors_only`. */
  indoorOnly: boolean;
  /** "Heavy rain, 25°C" — the numbers the traveller was given, not new ones. */
  summary: string;
};

/**
 * The whole `WeatherNow` -> hazard translation. Pure, and the only place a
 * temperature threshold is applied.
 */
export function profile(weather: WeatherNow, avoid: readonly string[] = []): WeatherProfile {
  const base = CONDITIONS[weather.condition];
  const byTemp: Severity = weather.tempC >= HEAT_SEVERE_C ? 2 : weather.tempC >= HEAT_MILD_C ? 1 : 0;
  const hazards: Record<HazardKind, Severity> = {
    rain: base.rain,
    heat: Math.max(base.heat, byTemp) as Severity,
    wind: base.wind,
  };
  const worst = KINDS.reduce<Severity>((acc, kind) => (hazards[kind] > acc ? hazards[kind] : acc), 0);
  return {
    condition: weather.condition,
    tempC: weather.tempC,
    source: weather.source,
    hazards,
    severity: worst,
    dominant: worst === 0 ? null : (KINDS.find((kind) => hazards[kind] === worst) ?? null),
    averse: avoid.includes(WEATHER_TOKENS.high),
    indoorOnly: avoid.includes(INDOOR_TOKEN),
    summary: `${LABELS[weather.condition]}, ${Math.round(weather.tempC)}°C`,
  };
}

/** Convenience for the pipeline: the profile a `DiscoveryContext` implies. */
export function profileFor(ctx: DiscoveryContext): WeatherProfile {
  return profile(ctx.weather, ctx.avoid);
}

// ---------------------------------------------------------------------------
// The verdict: one record, one sky
// ---------------------------------------------------------------------------

export type WeatherVerdict = {
  id: string;
  /** True when the gate removes it from the candidate set entirely. */
  sealed: boolean;
  /**
   * What closed it. `"weather"` is a fact about the sky; `"preference"` is the
   * traveller's own `indoors_only` request, and the two are reported under
   * different `RejectionCode`s so the panel never blames the weather for a
   * decision the traveller made.
   */
  cause: "weather" | "preference" | null;
  /** The hazard responsible, or null in fine weather. */
  hazard: HazardKind | null;
  severity: Severity;
  /** Points to subtract from the engine's score. Always 0 in fine weather. */
  penalty: number;
  /** A finished sentence with the real numbers. Empty string when there is nothing to say. */
  reason: string;
  /** Ready for `FeasibleResult.rejected`. Null unless `sealed`. */
  rejection: Rejection | null;
};

/**
 * The decision. One record, one profile, no I/O.
 *
 * `sealed` is a hard constraint: the record must not reach the scorer or the
 * packer, and it must come back as a rejection so the "why you are not seeing
 * this" panel has a sentence. `penalty` is the soft half and only matters for
 * records that stay legal — the covered verandah that is still the best answer in
 * a shower, ranked under the room with the roof on it.
 *
 * The one input here that is not weather is `indoors_only`, and it is deliberate:
 * the editor lowers that preference into `avoid` because the frozen context has
 * no field for it, and a token the engine ignores is worse than no token. It seals
 * a fully open-air record whatever the sky is doing, because "nothing that needs
 * you to be outside" is a statement of intent, not a forecast.
 */
export function assess(p: WeatherProfile, exp: Experience): WeatherVerdict {
  const shelter = SHELTER[exp.indoorOutdoor];
  const exposed = shelter >= EXPOSED_AT;
  const thresholds = SEAL_AT[exp.weatherSensitive];
  // `weather_averse` lowers every threshold one step, never below 1, so a
  // traveller who has told us they hate weather is not exposed to mild anything.
  const weatherSeal: HazardKind | null = exposed
    ? (KINDS.find((kind) => p.hazards[kind] >= (p.averse ? Math.max(1, thresholds[kind] - 1) : thresholds[kind])) ?? null)
    : null;
  const indoorsOnlySeal = weatherSeal === null && p.indoorOnly && shelter >= OPEN_AIR;
  const severity: Severity = weatherSeal === null ? 0 : p.hazards[weatherSeal];
  const raw = p.severity * shelter * PENALTY_PER_LEVEL * CARES[exp.weatherSensitive] * (p.averse ? AVERSE_MULT : 1);
  const penalty = p.severity === 0 ? 0 : Math.min(MAX_PENALTY, Math.round(raw));

  const cause: WeatherVerdict["cause"] = weatherSeal !== null ? "weather" : indoorsOnlySeal ? "preference" : null;
  const reason = weatherSeal !== null
    ? `${p.summary}. ${exp.name} is ${SHELTER_TEXT[shelter]}, and its record says it is ${CARES_TEXT[exp.weatherSensitive]}, so the ${HAZARD_TEXT[weatherSeal]} takes it out of the plan.`
    : indoorsOnlySeal
      ? `${exp.name} is ${SHELTER_TEXT[shelter]}, and you asked for indoors only, so it cannot go in this plan.`
      : p.severity > 0
        ? `${p.summary}. ${exp.name} is ${SHELTER_TEXT[shelter]}, so it is down-weighted rather than dropped.`
        : "";

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
          // The two causes get the two codes they deserve: `weather_unsafe` is a
          // statement about the sky, `excluded_by_traveller` about the request.
          code: cause === "weather" ? "weather_unsafe" : "excluded_by_traveller",
          message: reason,
          shortfall: null,
          unit: null,
          // No relaxation fixes weather except changing the weather, and the
          // relaxation ladder must not offer to ignore a monsoon.
          relaxable: false,
        },
  };
}

/**
 * The score term, or `null` in fine weather so that a clear-sky breakdown is
 * byte-identical to the engine's. That is deliberate: it means "the weather did
 * not change anything" is observable rather than assumed.
 */
export function weatherComponent(verdict: WeatherVerdict): ScoreComponent | null {
  if (verdict.penalty <= 0) return null;
  return {
    key: "weather",
    label: "Weather",
    value: -verdict.penalty,
    weight: 1,
    reason: verdict.reason,
  };
}
