/**
 * The what-if input, in the units a person would actually use.
 *
 * The brief asks for "changes in rainfall intensity, temperature, storm duration,
 * flooding, extreme heat, or other weather conditions". That is five independent
 * knobs and they are genuinely independent — 80 mm/h for 20 minutes floods a low
 * street that 10 mm/h for six hours never touches — so they are five fields here
 * rather than one `severity` slider that pretends otherwise.
 *
 * This type is the twin's only weather input. It is deliberately *not* the
 * contract's `WeatherNow`: it carries continuous quantities the frozen contract has
 * no room for, and `conditionOf` narrows it at the boundary so the engine and the
 * existing weather policy keep reading the enum they were written against. See
 * `hazards.ts` for why.
 *
 * Pure, no clock, no network. `at` is the one place a `Date` is allowed, and it is
 * only ever read as a date, never as "now" — the twin must be able to simulate a
 * Tuesday in July from a page load on a Sunday in October.
 */

/** mm/h. 0 is dry. 40 is a cloudburst, 100 is a cloudburst that closes a city. */
export const RAIN_MAX_MMH = 120;
/** Sustained + gust, km/h. Cyclone-force gusts start around 120. */
export const WIND_MAX_KMH = 180;
/** °C. 30 is a Mumbai May afternoon, 45 is the heatwave a plan should refuse. */
export const TEMP_MIN_C = 5;
export const TEMP_MAX_C = 50;
/** Standing water depth, cm. 15 cm stalls a car, 60 cm closes a street. */
export const FLOOD_MAX_CM = 120;
/** Hours the event runs. Duration is what turns rain into a flood. */
export const DURATION_MAX_H = 72;

/** The bounds a slider and a URL both clamp to. Single source of truth. */
export const SCENARIO_BOUNDS = {
  rainMmH: { min: 0, max: RAIN_MAX_MMH, step: 1 },
  windKmh: { min: 0, max: WIND_MAX_KMH, step: 5 },
  tempC: { min: TEMP_MIN_C, max: TEMP_MAX_C, step: 1 },
  floodCm: { min: 0, max: FLOOD_MAX_CM, step: 1 },
  durationH: { min: 1, max: DURATION_MAX_H, step: 1 },
} as const;

export type WeatherScenario = {
  rainMmH: number;
  windKmh: number;
  tempC: number;
  floodCm: number;
  durationH: number;
  /** YYYY-MM-DD. Affects the season gate, not the physics. */
  date: string;
  /**
   * Which half of the day the traveller is out. The weather feature already
   * established that 41°C at 19:00 is not 41°C at noon, and heat is the hazard
   * where that distinction is worth the most.
   */
  hour: number;
};

/** The Mumbai summer afternoon, as a starting point. Not a forecast. */
export const BASELINE_SCENARIO: WeatherScenario = {
  rainMmH: 0,
  windKmh: 12,
  tempC: 31,
  floodCm: 0,
  durationH: 3,
  date: "2026-07-15",
  hour: 14,
};

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Clamp, round and fill. The only way a `WeatherScenario` is ever constructed. */
export function normalizeScenario(partial: Partial<WeatherScenario> = {}): WeatherScenario {
  const b = SCENARIO_BOUNDS;
  return {
    rainMmH: clamp(partial.rainMmH ?? 0, b.rainMmH.min, b.rainMmH.max, 0),
    windKmh: clamp(partial.windKmh ?? BASELINE_SCENARIO.windKmh, b.windKmh.min, b.windKmh.max, BASELINE_SCENARIO.windKmh),
    tempC: clamp(partial.tempC ?? BASELINE_SCENARIO.tempC, b.tempC.min, b.tempC.max, BASELINE_SCENARIO.tempC),
    floodCm: clamp(partial.floodCm ?? 0, b.floodCm.min, b.floodCm.max, 0),
    durationH: clamp(partial.durationH ?? BASELINE_SCENARIO.durationH, b.durationH.min, b.durationH.max, BASELINE_SCENARIO.durationH),
    date: isDate(partial.date) ? partial.date! : BASELINE_SCENARIO.date,
    hour: Math.round(clamp(partial.hour ?? BASELINE_SCENARIO.hour, 0, 23, BASELINE_SCENARIO.hour)),
  };
}

function isDate(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** `YYYY-MM-DD` -> 1-12, without constructing a local-midnight `Date`. */
export function monthOf(scenario: WeatherScenario): number {
  return Number(scenario.date.slice(5, 7));
}

/** `YYYY-MM-DD` -> 0 (Sun) - 6, via UTC so the answer cannot depend on the host. */
export function weekdayOf(scenario: WeatherScenario): number {
  return new Date(`${scenario.date}T00:00:00Z`).getUTCDay();
}
/**
 * The continuous driver values a hazard reads.
 *
 * Flooding is a function of *accumulated* rainfall over a *low-lying* surface, not
 * of the current rate, which is why `rainMmH` and `durationH` are multiplied here
 * rather than either being used alone. 2 mm/h for 72 h is 144 mm and drowns the same
 * underpass that 120 mm/h for 20 minutes barely wets. The coefficients are
 * documented heuristics and the twin says so in its own output; the honesty
 * requirement here is that they are *stated and inspectable*, not that they are
 * meteorological truth.
 */
export type HazardDrivers = {
  rainMmH: number;
  /** mm of rain accumulated over the whole event. */
  rainTotalMm: number;
  windKmh: number;
  /** Temperature with the sun's contribution applied. Never below `tempC`. */
  feelsLikeC: number;
  /** Sun still up? Heat severity is `peak` only between 10:00 and 16:00. */
  sunUp: boolean;
  floodCm: number;
  durationH: number;
};

/** Neergang's apparent temperature, the standard for the heat term. */
const SUN_GAIN = 0.9;
const HUMIDITY_BASIS = 0.8;

export function driversOf(scenario: WeatherScenario): HazardDrivers {
  const rainTotalMm = Math.round(scenario.rainMmH * scenario.durationH * 10) / 10;
  const sunUp = scenario.hour >= 10 && scenario.hour <= 16;
  // `Number(sunUp)` rather than multiplying the boolean: legal in JS, and a number
  // under `tsc` — and the explicit form is the one that reads as a decision instead
  // of as a slip.
  const apparent = scenario.tempC + SUN_GAIN * Number(sunUp) * (scenario.tempC - TEMP_MIN_C) * (1 - HUMIDITY_BASIS);
  return {
    rainMmH: scenario.rainMmH,
    rainTotalMm,
    windKmh: scenario.windKmh,
    feelsLikeC: Math.round(apparent * 10) / 10,
    sunUp,
    floodCm: scenario.floodCm,
    durationH: scenario.durationH,
  };
}

/**
 * Narrow to the contract's `WeatherNow`, so every existing consumer keeps working.
 *
 * Thresholds are ordered worst-first, because a 60 km/h wind in a downpour is a
 * storm and not "heavy rain with a bit of wind" — the badge is what a traveller
 * reads, and understating it is the one error this whole layer exists to prevent.
 *
 * `source` is `simulated` whenever the scenario is not the live observation, and
 * the twin sets it to `simulated` for every what-if on purpose. `WeatherProfile`
 * deliberately ignores `source`, so a simulated scenario gates exactly as a live
 * one would, and the UI can still label it honestly.
 */
export function conditionOf(drivers: HazardDrivers): "clear" | "cloudy" | "light_rain" | "heavy_rain" | "storm" | "heat" | "wind" {
  if (drivers.floodCm >= 15 || drivers.rainMmH >= 40 || (drivers.windKmh >= 60 && drivers.rainMmH >= 15)) return "storm";
  if (drivers.rainMmH >= 10) return "heavy_rain";
  if (drivers.rainMmH >= 1) return "light_rain";
  if (drivers.windKmh >= 45) return "wind";
  if (drivers.feelsLikeC >= 40) return "heat";
  if (drivers.feelsLikeC >= 35) return "heat";
  if (drivers.windKmh >= 25) return "wind";
  return "clear";
}

/** The full `WeatherNow`, ready to drop into a `DiscoveryContext`. */
export function weatherNowOf(scenario: WeatherScenario, source: "live" | "simulated" | "unknown"): {
  condition: ReturnType<typeof conditionOf>;
  tempC: number;
  source: "live" | "simulated" | "unknown";
} {
  return { condition: conditionOf(driversOf(scenario)), tempC: scenario.tempC, source };
}

/** URL search params -> scenario. Untrusted, so every read is clamped. */
export function scenarioFromParams(params: URLSearchParams): WeatherScenario {
  return normalizeScenario({
    rainMmH: num(params.get("rain")),
    windKmh: num(params.get("wind")),
    tempC: num(params.get("temp")),
    floodCm: num(params.get("flood")),
    durationH: num(params.get("hours")),
    date: params.get("date") ?? undefined,
    hour: num(params.get("hour")),
  });
}

function num(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Scenario -> search params, so a simulation is a shareable link. */
export function paramsFromScenario(scenario: WeatherScenario): string {
  const params = new URLSearchParams();
  const base = BASELINE_SCENARIO;
  if (scenario.rainMmH !== base.rainMmH) params.set("rain", String(scenario.rainMmH));
  if (scenario.windKmh !== base.windKmh) params.set("wind", String(scenario.windKmh));
  if (scenario.tempC !== base.tempC) params.set("temp", String(scenario.tempC));
  if (scenario.floodCm !== base.floodCm) params.set("flood", String(scenario.floodCm));
  if (scenario.durationH !== base.durationH) params.set("hours", String(scenario.durationH));
  if (scenario.hour !== base.hour) params.set("hour", String(scenario.hour));
  if (scenario.date !== base.date) params.set("date", scenario.date);
  return params.toString();
}
