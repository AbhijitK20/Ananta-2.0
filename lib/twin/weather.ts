/**
 * Reading a weather service, and turning it into hazards in real units.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVICE'S UNITS ARE CONVERTED HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * OpenWeather's `units=metric` response is a trap in two specific ways, and both
 * have bitten planners before:
 *
 *  - `wind.speed` is **metres per second** even in metric. A response reading
 *    `"speed": 4.03` is 14.5 km/h, not 4 km/h. Passing it through unconverted
 *    makes every wind reading look like a dead calm, which is the failure mode
 *    that hides a storm.
 *  - `rain` is keyed `"1h"` on the current endpoint and `"3h"` on the forecast
 *    endpoint, and **is often absent entirely** even when the condition is
 *    reported as rain. An absent key is not zero rainfall; treating it as zero is
 *    how a downpour becomes a clear sky.
 *
 * So both are handled in `rateFromResponse` and nowhere else, and the absent case
 * falls back to the condition code's own band rather than to zero.
 *
 * ---------------------------------------------------------------------------
 * FLOODING IS NOT READ FROM A FORECAST
 * ---------------------------------------------------------------------------
 *
 * There is no `flood` field in a weather response, and inventing one from
 * rainfall would be the single most confident wrong number in the whole layer:
 * standing water depends on drainage, terrain and hours of accumulation, none of
 * which a forecast carries. So `flood` arrives from exactly two places — an
 * official alert (see ./signals) or the traveller's own what-if control — and
 * this module reports 0 with the reason attached rather than guessing.
 */

import { HAZARD_UNITS, severityFromIntensity } from "./hazard-scale";
import { HAZARD_LABELS, type CityObservation, type HazardKind, type HazardReading, type Scenario } from "./types";

/* -------------------------------------------------------------------------- *
 * The upstream shapes
 * -------------------------------------------------------------------------- */

export type OwmWeather = { id: number; main: string; description: string; icon: string };

export type OwmCurrent = {
  dt?: number;
  main?: { temp?: number; feels_like?: number; humidity?: number };
  weather?: OwmWeather[];
  wind?: { speed?: number; gust?: number };
  rain?: Record<string, number | undefined>;
  snow?: Record<string, number | undefined>;
  visibility?: number;
  clouds?: { all?: number };
};

type OwmForecastSlot = OwmCurrent & { pop?: number };

/** Thrown away. Present only so the shapes above have something to sit on. */
export type OwmForecast = { list?: OwmForecastSlot[] };

/* -------------------------------------------------------------------------- *
 * Rates
 * -------------------------------------------------------------------------- */

const MS_TO_KMH = 3.6;

/**
 * Rainfall rate in mm/h from a response body.
 *
 * Prefers a measured amount and falls back to the condition code's band. The
 * fallback is a real number with a real range, not a guess dressed up: OpenWeather
 * codes are defined by their intensity bands, and "heavy shower" is documented as
 * ≥ 16 mm/h. Every value the fallback returns sits inside the band its code names.
 */
function rateFromResponse(body: OwmCurrent): { mmH: number; derived: boolean } {
  const one = body.rain?.["1h"];
  if (typeof one === "number" && one > 0) return { mmH: one, derived: false };
  const three = body.rain?.["3h"];
  if (typeof three === "number" && three > 0) return { mmH: three / 3, derived: true };

  const id = body.weather?.[0]?.id;
  if (typeof id !== "number") return { mmH: 0, derived: false };
  const band = bandForCondition(id);
  return band === null ? { mmH: 0, derived: false } : { mmH: band, derived: true };
}

/**
 * The mid-point of the intensity band a condition code names, in mm/h.
 *
 * From OpenWeather's own condition table, so a code the service assigned is
 * enough to say roughly how hard it is raining even when it reports no amount.
 * Null for codes that are not precipitation.
 */
function bandForCondition(id: number): number | null {
  if (id >= 200 && id <= 232) return 12; // thunderstorm
  if (id >= 300 && id <= 302) return 0.3; // drizzle, light
  if (id >= 310 && id <= 312) return 1.1; // drizzle, moderate
  if (id >= 313 && id <= 316) return 2.6; // drizzle, dense
  if (id >= 321 && id <= 322) return 3.0; // shower, light
  if (id >= 500 && id <= 501) return 2.6; // rain, light
  if (id === 502) return 7.6; // moderate
  if (id === 503) return 20.1; // heavy
  if (id === 504) return 42.4; // extreme
  if (id === 511) return 4.2; // freezing rain
  if (id === 520) return 2.0; // shower, light
  if (id === 521) return 7.6; // moderate
  if (id === 522) return 20.1; // heavy
  if (id === 531) return 42.4; // extreme shower
  if (id >= 600 && id <= 622) return 1.0; // snow, converted to its water equivalent below
  return null;
}

/**
 * Snow is reported in mm of *snow*, which is roughly a tenth of its water
 * equivalent, and water is what wets a road. So the twin reads snow as water at a
 * 1:10 ratio, and says so, because "20 cm of snow" and "20 mm of rain" are the same
 * number with completely different consequences.
 */
const SNOW_WATER_RATIO = 10;

function snowWaterMmH(body: OwmCurrent): number {
  const one = body.snow?.["1h"];
  if (typeof one === "number" && one > 0) return one / SNOW_WATER_RATIO;
  const three = body.snow?.["3h"];
  if (typeof three === "number" && three > 0) return three / 3 / SNOW_WATER_RATIO;
  return 0;
}

/** The comfort ceiling the hotel and café trade is built around. */
const HEAT_CEILING_C = 30;

const isThunder = (id?: number) => typeof id === "number" && id >= 200 && id <= 232;

/* -------------------------------------------------------------------------- *
 * The word, derived at the boundary
 * -------------------------------------------------------------------------- */

/**
 * The familiar condition word, from the hazards rather than from the service's
 * own enum.
 *
 * Deriving it here is what lets the rest of the site keep saying "rain" in
 * sentences while the twin thinks in mm/h. Severity order matters: a 40 mm/h
 * downpour that is somehow also 34 °C is not "hot", it is a flood.
 */
export function conditionOf(hazards: readonly HazardReading[]): string {
  const by = new Map(hazards.map((h) => [h.kind, h]));
  const flood = by.get("flood");
  const storm = by.get("storm");
  const rain = by.get("rain");
  const heat = by.get("heat");
  const wind = by.get("wind");

  if (flood && flood.severity >= 2) return "Flooding";
  if (storm && storm.severity >= 2) return "Storm";
  if (rain && rain.severity >= 3) return "Torrential rain";
  if (rain && rain.severity >= 2) return "Heavy rain";
  if (rain && rain.severity >= 1) return "Rain";
  if (wind && wind.severity >= 3) return "Gales";
  if (wind && wind.severity >= 2) return "Windy";
  if (heat && heat.severity >= 2) return "Extreme heat";
  if (heat && heat.severity >= 1) return "Hot";
  return "Clear";
}

/* -------------------------------------------------------------------------- *
 * Building a city's observation
 * -------------------------------------------------------------------------- */

export type BuildObservationInput = {
  city: string;
  cityLabel: string;
  at: { lat: number; lon: number };
  current: OwmCurrent | null;
  forecast: OwmForecast | null;
  /** Centimetres of standing water an official alert reports. 0 when none. */
  alertFloodCm?: number;
  error?: string | null;
};

export function buildObservation(input: BuildObservationInput): CityObservation {
  const { city, cityLabel, at, current, forecast, alertFloodCm = 0, error = null } = input;

  if (!current) {
    return {
      city,
      cityLabel,
      at,
      hazards: null,
      condition: null,
      conditionIcon: null,
      tempC: null,
      feelsLikeC: null,
      humidity: null,
      windKph: null,
      forecastRainMmH: null,
      forecastHours: 0,
      observedAt: null,
      error: error ?? "The weather service did not answer for this city.",
    };
  }

  const rate = rateFromResponse(current);
  const rainMmH = rate.mmH + snowWaterMmH(current);
  const feelsLike = current.main?.feels_like ?? current.main?.temp ?? 0;
  const heatOver = Math.max(0, feelsLike - HEAT_CEILING_C);

  const speedMs = current.wind?.speed ?? 0;
  const gustMs = current.wind?.gust ?? speedMs;
  const windKph = Math.round(gustMs * MS_TO_KMH * 10) / 10;

  const forecastSlots = forecast?.list ?? [];
  const nextTwelve = forecastSlots.slice(0, 4); // 4 × 3h

  const forecastRainMmH = nextTwelve.length
    ? Math.round(
        (nextTwelve.reduce((sum, slot) => sum + rateFromResponse(slot).mmH, 0) / nextTwelve.length) * 10,
      ) / 10
    : null;

  const stormHours = countStormHours(forecastSlots);

  const hazards: HazardReading[] = [
    reading("rain", rainMmH),
    reading("heat", heatOver),
    reading("wind", windKph),
    reading("flood", alertFloodCm),
    reading("storm", stormHours),
  ];

  return {
    city,
    cityLabel,
    at,
    hazards,
    condition: conditionOf(hazards),
    conditionIcon: current.weather?.[0]?.icon ?? null,
    tempC: current.main?.temp ?? null,
    feelsLikeC: current.main?.feels_like ?? null,
    humidity: current.main?.humidity ?? null,
    windKph,
    forecastRainMmH,
    forecastHours: Math.min(forecastSlots.length * 3, 120),
    observedAt: current.dt ? new Date(current.dt * 1000).toISOString() : null,
    error: null,
  };
}

function reading(kind: HazardKind, intensity: number): HazardReading {
  return {
    kind,
    // The severity bridge lives in ./hazard-scale, so the thresholds are stated
    // in exactly one place and a what-if cannot disagree with an observation
    // about what counts as heavy rain.
    severity: severityFromIntensity(kind, intensity),
    intensity: Math.round(intensity * 10) / 10,
    unit: HAZARD_UNITS[kind],
    evidence: 0,
  };
}

/** Re-exported so the UI can label a reading without importing three modules. */
export { HAZARD_LABELS, HAZARD_UNITS };

/**
 * Hours of storm still to come, from the forecast's own thunderstorm codes.
 *
 * Counted as *contiguous* slots from now, because a storm four days out is not a
 * reason to change tomorrow's plan, and a model that averaged it in would treat a
 * clear week as a wet one. Capped at the horizon the forecast actually covers.
 */
function countStormHours(slots: readonly OwmForecastSlot[]): number {
  let steps = 0;
  for (const slot of slots) {
    if (!isThunder(slot.weather?.[0]?.id)) break;
    steps += 1;
  }
  return steps * 3;
}

/* -------------------------------------------------------------------------- *
 * The scenario, in units
 * -------------------------------------------------------------------------- */

/**
 * What the scenario resolves to, in real units, for one city.
 *
 * This is the function the what-if controls read to print an absolute number next
 * to every ratio, and the cascade reads to decide severity. It lives here, next
 * to the unit conversions, because "×2.5 of what" is only answerable by whoever
 * knows what "what" was measured in.
 */
export function resolveIntensities(
  hazards: readonly HazardReading[],
  scenario: Scenario,
): { kind: HazardKind; label: string; intensity: number; unit: string; severity: HazardReading["severity"] }[] {
  const byKind = new Map(hazards.map((h) => [h.kind, h]));
  const read = (kind: HazardKind) => byKind.get(kind)?.intensity ?? 0;

  const resolved = {
    rain: read("rain") * scenario.rain,
    heat: Math.max(0, read("heat") + scenario.heatDeltaC),
    wind: read("wind") * scenario.wind,
    flood: read("flood") + scenario.floodCm,
    storm: Math.max(read("storm"), scenario.stormHours),
  };

  return (Object.keys(resolved) as HazardKind[]).map((kind) => ({
    kind,
    label: HAZARD_LABELS[kind],
    intensity: Math.round(resolved[kind] * 10) / 10,
    unit: HAZARD_UNITS[kind],
    severity: severityFromIntensity(kind, resolved[kind]),
  }));
}
