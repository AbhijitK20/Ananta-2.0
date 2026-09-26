/**
 * `src/features/weather/**` — weather as a planning constraint, not a badge.
 *
 * The three pieces, in dependency order:
 *
 *   model.ts     the policy. `WeatherNow` -> hazards, record -> verdict. Pure.
 *   source.ts    where a sky comes from. Deterministic by default, live behind
 *                one interface so no core test needs a network.
 *   pipeline.ts  the seam. `withWeather(engine, catalogue)` hangs the policy off
 *                the real `EnginePort` stages: filter, score, replan.
 *
 * Typical wiring, in one place in `src/app`:
 *
 * ```ts
 * const session = createSession({ engine, seed, catalogue, weights });
 * const engine  = withWeather(baseEngine, session.catalogue);
 * const first   = discover(engine, session);
 * applyOpsAndReplan(engine, first.session, [{ kind: "set_weather", condition: "heavy_rain" }]);
 * ```
 */
export {
  EXPOSED_AT,
  WEATHER_POLICY_VERSION,
  assess,
  profile,
  profileFor,
  weatherComponent,
  type HazardKind,
  type Severity,
  type WeatherProfile,
  type WeatherVerdict,
} from "./model";

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
  MAX_WEATHER_REPAIRS,
  withWeather,
  type WeatherOptions,
} from "./pipeline";
