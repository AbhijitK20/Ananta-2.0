/**
 * `src/features/weather/**` — weather as a planning constraint, not a badge.
 *
 * Six pieces, in dependency order:
 *
 *   model.ts     the policy. Sky + clock + calendar + record -> verdict. Pure.
 *   timing.ts    the clock arithmetic: bands, windows, the sun, midnight wrapping.
 *   season.ts    the calendar: `bestMonths`, monsoon months, seasonal closures.
 *   source.ts    where a sky comes from. Deterministic by default, live behind one
 *                interface so no core test needs a network.
 *   report.ts    the written half: a justification for every exposed stop, and the
 *                `weatherRisk` stress factor, read back off a finished plan.
 *   pipeline.ts  the seam. `withWeather(engine, options)` hangs the policy off the
 *                real `EnginePort` stages: filter, score, replan.
 *
 * Typical wiring, in one place in `src/app`:
 *
 * ```ts
 * const session = createSession({ engine, seed, catalogue, weights });
 * const engine  = withWeather(baseEngine, { catalogue: session.catalogue, month: 7 });
 * const first   = discover(engine, session);
 * applyOpsAndReplan(engine, first.session, [{ kind: "set_weather", condition: "heavy_rain" }]);
 * weatherReport(first.plan, session.state.ctx, { catalogue: session.catalogue, month: 7 });
 * ```
 */
export {
  EXPOSED_AT,
  WEATHER_POLICY_VERSION,
  assess,
  profile,
  profileFor,
  verdictComponents,
  type HazardKind,
  type SeasonVerdictSummary,
  type Severity,
  type TimingVerdict,
  type WeatherEnv,
  type WeatherProfile,
  type WeatherVerdict,
} from "./model";

export {
  BAND_CLOCK,
  BAND_ORDER,
  HEAT_EXPOSURE_WEIGHT,
  PEAK_SUN,
  WARM_SHOULDER,
  WHOLE_DAY,
  at,
  bandDistance,
  heatExposure,
  minutesInside,
  overlaps,
  timeBand,
  timingMiss,
  windowOf,
  type HeatExposure,
  type TimeBand,
  type Window,
} from "./timing";

export {
  FAR_OFF_SEASON,
  MONSOON_MONTHS,
  NO_SEASON,
  monsoonExposure,
  monsoonReason,
  seasonOf,
  type SeasonEnv,
  type SeasonVerdict,
} from "./season";

export {
  UNKNOWN_WEATHER,
  fixedSource,
  openMeteoSource,
  resolveWeather,
  type OpenMeteoOptions,
  type WeatherRequest,
  type WeatherSource,
} from "./source";

export {
  weatherReport,
  type ReportOptions,
  type StressFactor,
  type WeatherReport,
  type WeatherStopNote,
} from "./report";

export {
  MAX_WEATHER_REPAIRS,
  withWeather,
  type WeatherOptions,
} from "./pipeline";
