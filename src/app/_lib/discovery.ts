/**
 * One place that turns a URL into a computed discovery.
 *
 * The home page used to own the whole computation: it built the context, called
 * the engine, and held every panel's state in thirteen `useState` hooks, which
 * is why the first screen had seven panels on it. Splitting the screen across
 * routes means the computation has to be shareable, and the honest place to put
 * it is the URL — because a URL is the one piece of state that survives
 * navigation without a provider, and it makes a plan shareable by copying the
 * address bar.
 *
 * So the traveller's situation lives in search params. `/tune` edits them,
 * `/plan` reads them, and `/` renders from them. Each route recomputes on the
 * server, which costs about 60 ms against a cached catalogue and means there is
 * no client state to keep in sync and no provider to reason about.
 */

import { planItinerary } from "@/engine/plan";
import { computeFit } from "@/engine/fit";
import { score, DEFAULT_PROFILE } from "@/engine/scoring";
import { DiscoveryContext, type Experience, type Fit, type ScoreBreakdown } from "@/contracts";
import { loadCatalogue } from "./catalogue";

/** Bandra West. Verified against the catalogue, not guessed — see `page.tsx`. */
export const DEFAULT_ORIGIN = {
  label: "Bandra West, Mumbai",
  point: { lat: 19.0495, lon: 72.832 },
} as const;

const ACCESS_NEEDS = ["wheelchair", "stroller", "lowStairs", "hearingLoop", "restroom"] as const;
const PARTY_TYPES = ["solo", "couple", "family_with_children", "family_teens", "friends", "business", "solo_female", "older_adults"] as const;
const WEATHER = ["clear", "cloudy", "light_rain", "heavy_rain", "storm", "heat", "wind"] as const;

/** Search params are untrusted input; every read is clamped or dropped. */
function readInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The contract's enum is `walk | auto | transit | any`; anything else is dropped. */
function parseTravelMode(raw: string | null): "walk" | "auto" | "transit" | "any" {
  return raw === "walk" || raw === "auto" || raw === "transit" || raw === "any" ? raw : "walk";
}

export function contextFromParams(params: URLSearchParams): DiscoveryContext {
  const availableMin = readInt(params.get("t"), 30, 720, 180);
  const budgetRupees = readInt(params.get("b"), 0, 5000, 3000);
  const partySize = readInt(params.get("p"), 1, 12, 2);
  const partyTypeRaw = params.get("pt");
  const partyType = PARTY_TYPES.includes(partyTypeRaw as never) ? (partyTypeRaw as never) : "couple";
  const needsRaw = (params.get("needs") ?? "").split(",").filter((n) =>
    (ACCESS_NEEDS as ReadonlyArray<string>).includes(n),
  ) as ReadonlyArray<(typeof ACCESS_NEEDS)[number]>;
  const weatherRaw = params.get("w");
  const weather = WEATHER.includes(weatherRaw as never) ? (weatherRaw as never) : "clear";
  const travelMode = parseTravelMode(params.get("m"));

  const budget = budgetRupees >= 5000 ? null : { minor: budgetRupees * 100, currency: "INR" as const };

  return DiscoveryContext.parse({
    id: "travelbuddy",
    origin: { label: DEFAULT_ORIGIN.label, point: { ...DEFAULT_ORIGIN.point } },
    availableMin,
    nowMin: readInt(params.get("now"), 0, 1439, 840),
    budget,
    budgetPerPerson: null,
    partySize,
    partyType,
    childAges: [],
    accessNeeds: needsRaw,
    diets: [],
    interests: [],
    avoid: [],
    weather: { condition: weather, tempC: 29, source: "live" },
    travelMode,
    requests: [],
    excludedIds: [],
    pinnedIds: [],
    original: { availableMin, budget, partySize, accessNeeds: needsRaw },
  });
}

/** Straight-line walking estimate, mirroring the engine's own pessimism. */
function travelEstimate(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(toRad(to.lat - from.lat) / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(toRad(to.lon - from.lon) / 2) ** 2;
  const metres = 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.max(1, Math.round((metres * 1.3) / 80));
}

export interface Discovery {
  context: DiscoveryContext;
  experiences: ReadonlyArray<Experience>;
  fits: Record<string, Fit>;
  scores: Record<string, ScoreBreakdown>;
  plan: ReturnType<typeof planItinerary>["plan"];
  rejections: ReturnType<typeof planItinerary>["rejected"];
  counts: ReturnType<typeof planItinerary>["counts"];
  engineReady: boolean;
  rowCount: number;
}

/**
 * Everything the UI needs, computed once per request.
 *
 * `fits` and `scores` are computed for every row, not just the planned ones,
 * because the results list renders a feasibility meter and a score on cards the
 * plan did not choose. That is 4,596 fits and scores per request, which sounds
 * expensive and measures at well under the cost of serialising the result.
 */
export async function computeDiscovery(params: URLSearchParams): Promise<Discovery> {
  const context = contextFromParams(params);
  const { experiences } = await loadCatalogue();
  const rowCount = experiences.length;

  // `mode` is deliberately not passed: planItinerary derives it from the context
  // (`travelMode === "any" ? "walk" : travelMode`), and restating it here is a
  // second place for the two to disagree.
  const result = planItinerary(context, experiences, {
    weekday: 6,
    month: new Date().getMonth() + 1,
    planId: "travelbuddy",
  });

  const origin = context.origin.point;
  const fits: Record<string, Fit> = {};
  const scores: Record<string, ScoreBreakdown> = {};
  for (const experience of experiences) {
    const travelMin = origin ? travelEstimate(origin, experience.location) : 0;
    const visitFrom = context.nowMin + travelMin + 10;
    fits[experience.id] = computeFit(context, experience, {
      travelMin,
      bufferMin: 10,
      visitFrom,
      visitTo: visitFrom + experience.durationMin,
      cost: experience.pricePerPerson ?? { minor: 0, currency: "INR" },
      weekday: 6,
    });
    scores[experience.id] = score(context, experience, DEFAULT_PROFILE, { travelMin });
  }

  return {
    context,
    experiences,
    fits,
    scores,
    plan: result.plan,
    rejections: result.rejected,
    counts: result.counts,
    engineReady: true,
    rowCount,
  };
}

/** Serialise a context back into search params, for the "Change" links. */
export function paramsFromContext(context: DiscoveryContext): string {
  const params = new URLSearchParams();
  params.set("t", String(context.availableMin));
  params.set("p", String(context.partySize));
  params.set("pt", context.partyType);
  params.set("m", context.travelMode);
  params.set("w", context.weather.condition);
  const rupees = context.budget ? Math.round(context.budget.minor / 100) : 5000;
  if (rupees !== 3000) params.set("b", String(rupees));
  if (context.accessNeeds.length) params.set("needs", context.accessNeeds.join(","));
  return params.toString();
}
