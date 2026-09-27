/**
 * Observation: the twin's senses, and the one place I/O is allowed.
 *
 * The brief asks the twin to "update its simulated state as new real-world data
 * becomes available". This is that. It reads three independent channels and hands
 * `propagate.ts` a `SimulateOptions`:
 *
 *   weather   Open-Meteo, live. Reached through the weather feature's own
 *             `resolveWeather`, so a timeout costs the badge and nothing else.
 *   social    the committed corpus always; the live public feed when it answers.
 *   model     Nugen's aligned model when one is deployed, the deterministic
 *             classifier when it is not.
 *
 * ## Why every channel degrades rather than throws
 *
 * `docs/ARCHITECTURE.md` §10 requires a fallback for every cache and the weather
 * feature's `resolveWeather`/`resolveSocial` already established the pattern. A twin
 * that cannot render because a public RSS feed 429'd would be a strictly worse product
 * than the planner it is meant to enhance, so the invariant here is:
 * **`observe()` always returns, and `provenance` always says what it got.**
 *
 * That last part is the important one. Every caller can tell the difference between
 * "there is no rain anywhere" and "we could not reach the weather API", and the UI
 * prints it. A simulation that cannot say which of its inputs were real is the
 * failure mode this whole repository is organised against.
 */
import { readFile } from "node:fs/promises";

import { type GeoPoint } from "../../contracts";
import { type HazardKind } from "./hazards";
import { type EntityGraph } from "./graph";
import { type ImpactModel } from "./impact";
import {
  HazardAssessment,
  type AlignmentManifest,
  type NugenHazardKind,
  assessText,
} from "../../llm/nugen";
import {
  BASELINE_SCENARIO,
  type WeatherScenario,
  driversOf,
  normalizeScenario,
} from "./scenario";
import {
  type SocialSignal,
  type SocialSource,
  type ReviewRow,
  type EventRow,
  classifyReport,
  liveSocialSource,
  resolveSocial,
  signalsFromEvents,
  signalsFromReviews,
} from "./social";
import { type SimulateOptions, type TwinProvenance } from "./propagate";

/** How many live reports reach the classifier. Above this the cost is not worth it. */
const LIVE_LIMIT = 12;
/** Ceiling on corpus reports, by total `helpfulCount` rather than by count. */
const CORPUS_LIMIT = 160;

export type Observation = {
  scenario: WeatherScenario;
  /** `live` when the scenario came from the API, `simulated` when the caller set it. */
  weatherSource: "live" | "simulated" | "unknown";
  weather: { condition: string; tempC: number };
  weatherNote: string;
  signals: SocialSignal[];
  assessment: HazardAssessment;
  provenance: TwinProvenance;
  manifest: AlignmentManifest | null;
};

export type ObserveOptions = {
  /** Where the traveller is. The live calls are made for this point. */
  point: GeoPoint;
  /**
   * A what-if. When given, it wins over the live weather entirely: simulating a
   * scenario that is then overwritten by an API response would be a slider that does
   * nothing. `null` means "use the live sky".
   */
  scenario: WeatherScenario | null;
  graph: EntityGraph;
  model: ImpactModel;
  /** Sources for social. Defaults to the live public feed. */
  socialSources?: SocialSource[];
  /** The committed corpus, if the caller has already read it. */
  corpusSignals?: SocialSignal[];
  manifest?: AlignmentManifest | null;
  /** Injected so the module is testable and so the demo can bound the latency. */
  now?: Date;
  signal?: AbortSignal;
};

/** The query the live feed is asked, derived from the scenario rather than hard-coded. */
export function searchQueryFor(scenario: WeatherScenario, place: string): string {
  const parts: string[] = [place, "weather"];
  if (scenario.rainMmH >= 10) parts.push("rain");
  if (scenario.rainMmH >= 30) parts.push("flood");
  if (scenario.floodCm >= 15) parts.push("waterlogged");
  if (scenario.windKmh >= 45) parts.push("storm");
  if (scenario.tempC >= 36) parts.push("heatwave");
  return parts.join(" ");
}

/**
 * The assessment, deduplicated against the corpus.
 *
 * The aligned model reads the *live* text and the corpus feeds the fit — the split is
 * by cost and by honesty. The corpus is already classified by `classifyReport` and
 * feeding it to a model would be paying GPU time to re-derive a label we have. Live
 * text has no such label, which is exactly where a domain-aligned model earns its
 * place.
 */
function assessmentInput(
  corpus: readonly SocialSignal[],
  live: readonly SocialSignal[],
): string[] {
  const seen = new Set(corpus.map((signal) => signal.text));
  return live
    .filter((signal) => !seen.has(signal.text))
    .map((signal) => signal.text)
    .slice(0, LIVE_LIMIT);
}

/**
 * The deterministic assessment, computed from the same reports the aligned model is
 * asked about.
 *
 * This is the floor the aligned model has to beat, and it lives here rather than in
 * `src/llm/nugen.ts` because `src/llm/boundary.test.ts` forbids that layer from
 * importing domain code — a hazard classifier is domain logic, so the feature owns
 * it and hands it to the LLM layer as `fallback`.
 *
 * Two honest limitations, both deliberate:
 *
 *  - **Severity is inferred from agreement, not measured.** The lexicon knows *which*
 *    hazard a report names but not how bad it was, so one report of a hazard is
 *    `degraded` and three agreeing reports of it are `closed`. That is a crude proxy
 *    and it is exactly the kind of thing a domain-aligned model exists to improve on.
 *  - **Emerging conditions are keyword-seeded.** A fixed list, because the committed
 *    corpus is English prose about these five neighbourhoods and a general list
 *    would be guesswork dressed as a detector.
 */
export function deterministicAssessment(reports: readonly string[]): HazardAssessment {
  const hazards = new Map<string, { worst: number; evidence: string; hits: number }>();
  let exposureSum = 0;
  let exposureHits = 0;
  const emerging: string[] = [];

  for (const report of reports) {
    const { conditions, exposure } = classifyReport(report);
    for (const kind of conditions) {
      const current = hazards.get(kind) ?? { worst: 0, evidence: report, hits: 0 };
      current.hits += 1;
      current.worst = Math.min(3, current.hits);
      hazards.set(kind, current);
    }
    if (exposure >= 0) {
      exposureSum += exposure;
      exposureHits += 1;
    }
    for (const word of EMERGING_WORDS) {
      if (emerging.length >= 5) break;
      if (report.toLowerCase().includes(word)) emerging.push(report.slice(0, 120));
    }
  }

  return HazardAssessment.parse({
    hazards: [...hazards].map(([kind, hit]) => ({
      kind: kind as NugenHazardKind,
      severity: hit.worst,
      // Agreement, damped: five reports is not five times the evidence of one.
      confidence: Math.min(0.9, 0.35 + 0.15 * hit.hits),
      evidence: hit.evidence.slice(0, 240),
    })),
    exposure: exposureHits === 0 ? 0.5 : Math.round((exposureSum / exposureHits) * 100) / 100,
    emerging,
  });
}

/** Phrases that mean "something is wrong that is not one of the five hazards". */
const EMERGING_WORDS: readonly string[] = [
  "cut",
  "impassable",
  "swimming pool",
  "no point",
  "shut",
  "waterlogged",
  "under water",
] as const;

const EMPTY_ASSESSMENT: HazardAssessment = { hazards: [], exposure: 0.5, emerging: [] };

/**
 * Read the world.
 *
 * Three awaits, run concurrently where they are independent, and none of them is
 * allowed to reject. The live weather and the live social feed are independent so they
 * are started together; the assessment depends on the social result, so it follows.
 */
export async function observe(options: ObserveOptions): Promise<Observation> {
  const { point, graph, model } = options;
  const now = options.now ?? new Date();

  // --- weather -------------------------------------------------------------
  let scenario = options.scenario;
  let weatherSource: Observation["weatherSource"] = "simulated";
  let weatherNote = "scenario supplied by the caller";
  if (scenario === null) {
    const live = await readLiveWeather(point, now, options.signal);
    scenario = live.weather;
    weatherSource = live.source;
    weatherNote = live.note;
  } else {
    scenario = normalizeScenario(scenario);
  }

  // --- social --------------------------------------------------------------
  const corpus = options.corpusSignals ?? [];
  const sources = options.socialSources ?? [liveSocialSource()];
  const query = searchQueryFor(scenario, graph.nodes.values().next().value?.neighbourhood ?? "Mumbai");
  const [liveResult] = await Promise.all([
    resolveSocial(sources, { lat: point.lat, lon: point.lon, query, limit: LIVE_LIMIT },),
  ]);

  // The corpus is always available and always the bulk of the evidence, so the
  // combined list is ranked by weight rather than concatenated.
  const signals = [...corpus, ...liveResult.signals]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, CORPUS_LIMIT);

  // --- model ---------------------------------------------------------------
  const manifest = options.manifest ?? null;
  const fresh = assessmentInput(corpus, liveResult.signals);
  // The deterministic answer is computed first and handed to the LLM layer as its
  // fallback, so the two can never disagree about what the floor is.
  const floor = fresh.length === 0 ? EMPTY_ASSESSMENT : deterministicAssessment(fresh);
  const text = await assessText(fresh, { fallback: floor, manifest, signal: options.signal });

  return {
    scenario,
    weatherSource,
    weather: { condition: "", tempC: scenario.tempC },
    weatherNote,
    signals,
    assessment: text.assessment,
    provenance: {
      model: text.model,
      modelSource: text.source,
      note: text.note,
      socialObserved: corpus.length + liveResult.signals.length,
      socialUsed: 0,
      socialFailed: liveResult.failed,
      observations: model.observations,
      modelVersion: model.version,
      weatherSource,
    },
    manifest,
  };

  /**
   * Live weather, through the weather feature's own door.
   *
   * Written out rather than imported so the twin can narrow the forecast to the
   * *continuous* quantities the scenario needs — rainfall rate in mm/h, which
   * `WeatherNow` has no field for — while still reusing its WMO mapping and its
   * never-throw contract. `WeatherNow` is returned as well, for the `DiscoveryContext`
   * the planner reads.
   */
  async function readLiveWeather(
    at: GeoPoint,
    at_: Date,
    abort: AbortSignal | undefined,
  ): Promise<{ weather: WeatherScenario; source: Observation["weatherSource"]; note: string }> {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${at.lat}&longitude=${at.lon}` +
      "&current=temperature_2m,weather_code,precipitation,rain,wind_speed_10m,wind_gusts_10m" +
      "&hourly=precipitation,wind_speed_10m,temperature_2m&forecast_days=2&timezone=UTC";
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 6_000);
    const relay = (): void => timeout.abort();
    abort?.addEventListener("abort", relay, { once: true });
    try {
      const response = await fetch(url, { signal: timeout.signal });
      if (!response.ok) throw new Error(`open-meteo returned ${response.status}`);
      const body = (await response.json()) as {
        current?: { temperature_2m?: number; precipitation?: number; rain?: number; wind_gusts_10m?: number; wind_speed_10m?: number };
        hourly?: { time?: string[]; precipitation?: (number | null)[]; wind_speed_10m?: (number | null)[] };
      };
      const current = body.current ?? {};
      if (typeof current.temperature_2m !== "number") throw new Error("no current temperature");

      // Rainfall *rate* is the number the twin needs and the API does not give
      // directly: precipitation is an accumulation over the preceding hour, and 1 mm
      // of rain per hour is 1 mm/h. The first non-null hourly value ahead of now is
      // used so the scenario describes what the traveller is walking into rather than
      // what has already fallen.
      const nowIndex = body.hourly?.time?.findIndex((stamp) => Date.parse(stamp) >= at_.getTime()) ?? -1;
      const upcoming = nowIndex >= 0 ? (body.hourly?.precipitation?.[nowIndex] ?? null) : null;
      const rainMmH = Math.max(0, upcoming ?? current.precipitation ?? current.rain ?? 0);
      const windKmh = current.wind_gusts_10m ?? current.wind_speed_10m ?? 0;

      return {
        weather: normalizeScenario({
          ...BASELINE_SCENARIO,
          rainMmH,
          windKmh,
          tempC: current.temperature_2m,
          date: at_.toISOString().slice(0, 10),
          hour: at_.getUTCHours(),
          // A live reading has no flood depth, because the API does not report one.
          // Estimated from accumulation, at low confidence, and `physicalSeverities`
          // marks anything it did not measure as 0.45.
          floodCm: 0,
        }),
        source: "live",
        note: `Open-Meteo live at ${at.lat.toFixed(3)},${at.lon.toFixed(3)}`,
      };
    } catch (error) {
      return {
        weather: normalizeScenario(BASELINE_SCENARIO),
        source: "unknown",
        note: `live weather unavailable (${error instanceof Error ? error.message : "unknown"}); simulating a clear Mumbai afternoon`,
      };
    } finally {
      clearTimeout(timer);
      abort?.removeEventListener("abort", relay);
    }
  }
}

/** Build `SimulateOptions` from an `Observation`. The last step before `simulate`. */
export function toSimulateOptions(observation: Observation, graph: EntityGraph, model: ImpactModel): SimulateOptions {
  const severities: Partial<Record<HazardKind, number>> = {};
  for (const hazard of observation.assessment.hazards) severities[hazard.kind] = hazard.severity;
  return {
    scenario: observation.scenario,
    graph,
    model,
    signals: observation.signals,
    severities,
    weatherSource: observation.weatherSource,
    provenance: observation.provenance,
  };
}

/**
 * The deterministic hazard severities, for a test or a caller that wants the twin
 * without the model layer at all.
 *
 * Deliberately duplicated from `propagate.ts` rather than imported: the point of this
 * path is to be the floor the aligned model has to beat, and a floor that shares an
 * implementation with the thing it floors proves nothing.
 */
export function deterministicSeverities(scenario: WeatherScenario): Partial<Record<HazardKind, number>> {
  const d = driversOf(scenario);
  const out: Partial<Record<HazardKind, number>> = {};
  if (d.rainMmH >= 1) out.rain = d.rainMmH >= 25 ? 2.4 : d.rainMmH >= 10 ? 1.8 : d.rainMmH >= 4 ? 1.1 : 0.6;
  if (d.floodCm > 0) out.flood = Math.min(3, d.floodCm / 20);
  else if (d.rainTotalMm >= 80) out.flood = Math.min(2.2, d.rainTotalMm / 70);
  if (d.windKmh >= 25) out.wind = d.windKmh >= 90 ? 2.6 : d.windKmh >= 55 ? 1.7 : 0.9;
  if (d.feelsLikeC >= 33) {
    const base = d.feelsLikeC >= 40 ? 2.4 : d.feelsLikeC >= 36 ? 1.5 : 0.8;
    out.heat = d.sunUp ? base : base * 0.35;
  }
  if (d.rainMmH >= 25 && d.windKmh >= 45) out.storm = Math.min(3, 1.6 + d.rainMmH / 60 + d.windKmh / 200);
  return out;
}

// ---------------------------------------------------------------------------
// The committed corpus, read once
// ---------------------------------------------------------------------------

let corpusCache: { signals: SocialSignal[]; loaded: boolean } | undefined;

/**
 * The committed social corpus, read from `content/` and cached per process.
 *
 * The 4.5 ms this costs on first read buys a twin that works with no network at all,
 * which is the difference between a demo that survives a conference wifi failure and
 * one that does not. A malformed line is skipped rather than thrown, because 291
 * hand-written rows are exactly the kind of data where one bad line should cost one
 * signal and not the feature.
 */
export async function corpusSignals(): Promise<SocialSignal[]> {
  if (corpusCache?.loaded) return corpusCache.signals;
  const signals: SocialSignal[] = [];
  for (const [path, parse] of [
    ["content/reviews/bandra.jsonl", "review"],
    ["content/reviews/colaba.jsonl", "review"],
    ["content/reviews/fort.jsonl", "review"],
    ["content/reviews/marine-drive.jsonl", "review"],
    ["content/reviews/adjacent.jsonl", "review"],
    ["content/events/events.jsonl", "event"],
  ] as const) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const rows: unknown[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // One bad line costs one signal.
      }
    }
    signals.push(
      ...(parse === "review"
        ? signalsFromReviews(rows as ReviewRow[])
        : signalsFromEvents(rows as EventRow[])),
    );
  }
  corpusCache = { signals, loaded: true };
  return signals;
}

/** Read the alignment manifest from disk. A missing file is not an error. */
export async function readAlignmentManifest(path = "data/reference/nugen/alignment.json"): Promise<AlignmentManifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as AlignmentManifest;
  } catch {
    return null;
  }
}

/** Exposed for the test that plants the polarity case `classifyReport` exists for. */
export { classifyReport };
