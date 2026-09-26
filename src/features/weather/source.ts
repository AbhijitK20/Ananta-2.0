/**
 * Where the weather comes from, behind one interface.
 *
 * The contract already anticipated this: `WeatherNow.source` is
 * `"live" | "simulated" | "unknown"` and its own comment says "real forecast from
 * Open-Meteo when available, simulated for the demo". So the shape was decided on
 * Day 1; only the implementation was missing, and an unimplemented live call is
 * the usual reason a "weather-aware" planner turns out to be a badge.
 *
 * The split is deliberate:
 *
 *  - **`fixedSource`** is the deterministic input. It answers with a value the
 *    caller already holds, so every test, the eval harness and the offline demo
 *    path run with no network and no clock.
 *  - **`openMeteoSource`** is the only file in the repo that knows Open-Meteo's
 *    wire format. `fetch` is injected, so even its own tests never open a socket
 *    and its mapping is verifiable offline.
 *
 * Both return the same `WeatherNow`, and `WeatherProfile` deliberately ignores
 * `source` — a simulated 41°C and a live 41°C must make the planner do exactly
 * the same thing, or the demo would be lying about what the product does. There
 * is a test for that.
 *
 * No new dependency: `fetch` is global in Node 22 and in the browser.
 */
import type { GeoPoint, WeatherNow } from "../../contracts";

export type WeatherRequest = {
  point: GeoPoint;
  /**
   * A real instant, because a forecast API takes one. This is the boundary where
   * the engine's "no `Date` objects" rule is allowed to stop: nothing downstream
   * of `resolveWeather` ever sees it.
   */
  at: Date;
};

export interface WeatherSource {
  /** Recorded in logs. `"fixed"` and `"open-meteo"` today. */
  readonly id: string;
  /** Throws on transport or shape failure. `resolveWeather` is the safe door. */
  read(request: WeatherRequest): Promise<WeatherNow>;
}

/** The condition used when nothing is known. Never optimistic. */
export const UNKNOWN_WEATHER: WeatherNow = { condition: "clear", tempC: 30, source: "unknown" };

/** The deterministic source. Same answer every call, which is the point. */
export function fixedSource(weather: WeatherNow): WeatherSource {
  return { id: "fixed", read: async () => ({ ...weather }) };
}

// ---------------------------------------------------------------------------
// Open-Meteo
// ---------------------------------------------------------------------------

/** Sustained or gust wind at which the sky is worth calling `wind`. Heuristic. */
const WIND_KMH = 40;

const DEFAULT_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/**
 * WMO 4677 weather codes -> our seven conditions.
 *
 * Snow has no member in the frozen `WeatherNow` enum. It maps to `heavy_rain`
 * deliberately: the planner's response to snow is the planner's response to heavy
 * rain — get indoors — and inventing a clearer answer would be the one place
 * where a missing enum member could put a traveller outside in bad weather.
 */
const WMO: Record<number, WeatherNow["condition"]> = {
  0: "clear",
  1: "clear",
  2: "cloudy",
  3: "cloudy",
  45: "cloudy",
  48: "cloudy",
  51: "light_rain",
  53: "light_rain",
  55: "light_rain",
  56: "light_rain",
  57: "light_rain",
  61: "light_rain",
  63: "light_rain",
  66: "light_rain",
  80: "light_rain",
  81: "light_rain",
  82: "heavy_rain",
  65: "heavy_rain",
  67: "heavy_rain",
  71: "heavy_rain",
  73: "heavy_rain",
  75: "heavy_rain",
  77: "heavy_rain",
  85: "heavy_rain",
  86: "heavy_rain",
  95: "storm",
  96: "storm",
  99: "storm",
};

type FetchLike = (input: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export type OpenMeteoOptions = {
  /** Injected so the mapping is testable and so the demo can pass a timeout. */
  fetch?: FetchLike;
  endpoint?: string;
};

/**
 * The live provider. The only `fetch` in the weather path, and it is reached
 * through `resolveWeather`, which cannot throw.
 *
 * Deliberately *not* done: retries, caching, circuit breaking. `src/llm/client.ts`
 * has that machinery for a paid API with a failure budget; a keyless forecast is
 * worth one call and a fallback. Add a cache when the demo's first paint is slow.
 */
export function openMeteoSource(options: OpenMeteoOptions = {}): WeatherSource {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const call: FetchLike = options.fetch ?? ((input) => fetch(input));

  return {
    id: "open-meteo",
    async read({ point, at }: WeatherRequest): Promise<WeatherNow> {
      const url = `${endpoint}?latitude=${point.lat}&longitude=${point.lon}`
        + "&current=temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m"
        + `&timezone=UTC&start_date=${at.toISOString().slice(0, 10)}&end_date=${at.toISOString().slice(0, 10)}`;
      const response = await call(url);
      if (!response.ok) throw new Error("open-meteo returned a non-OK status");
      const current = (await response.json()) as {
        current?: { temperature_2m?: unknown; weather_code?: unknown; wind_gusts_10m?: unknown; wind_speed_10m?: unknown };
      };
      const tempC = current.current?.temperature_2m;
      const code = current.current?.weather_code;
      if (typeof tempC !== "number" || typeof code !== "number") {
        throw new Error("open-meteo payload had no current temperature and weather code");
      }
      const base = WMO[code];
      if (!base) throw new Error(`open-meteo sent WMO code ${code}, which is not in the table`);
      // Gusts beat sustained wind when the API has them: the kite gets cancelled
      // on the gust, not on the average.
      const wind = typeof current.current?.wind_gusts_10m === "number"
        ? current.current.wind_gusts_10m
        : typeof current.current?.wind_speed_10m === "number"
          ? current.current.wind_speed_10m
          : 0;
      const condition = base === "clear" || base === "cloudy"
        ? (wind >= WIND_KMH ? "wind" : base)
        : base;
      return { condition, tempC, source: "live" };
    },
  };
}

/**
 * The only door the app should call. A forecast is an enrichment, never a
 * dependency: a timeout, an offline device or an API change must cost the
 * traveller their weather badge and nothing else. The fallback is
 * `source: "unknown"`, which the UI can label honestly and the planner treats as
 * the conditions it was given.
 */
export async function resolveWeather(
  source: WeatherSource,
  request: WeatherRequest,
  fallback: WeatherNow = UNKNOWN_WEATHER,
): Promise<WeatherNow> {
  try {
    return await source.read(request);
  } catch {
    return { ...fallback };
  }
}
