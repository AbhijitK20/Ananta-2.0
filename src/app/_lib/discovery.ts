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
import { DiscoveryContext, type Experience, type Fit, type Plan, type Rejection, type ScoreBreakdown } from "@/contracts";
import { weekdayOf } from "@/lib/time";
import { realEngine } from "@/features/discovery/real-engine";
import { createSession, type DiscoverySession } from "@/features/discovery/replanner";
import type { EnginePort } from "@/features/discovery/engine";
import type { ContextSeed } from "@/features/discovery/context";
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
 * How many retrieved candidates to show beyond the planned and rejected rows.
 *
 * ponytail: ceiling — there is no search over the long tail and no server-side
 * pagination; the list paginates 24 at a time from this set. Raise it and the
 * download grows with it, because the map is built from the same array. Add
 * real pagination when someone asks to see past the hundredth.
 */
const MAX_CANDIDATES = 40;

/**
 * The ids allowed to cross the server/client boundary.
 *
 * Three groups, in priority order:
 *   1. the plan's stops — omitting these breaks the timeline and the map route
 *   2. the gate's rejections — the "why not that" ledger is the product
 *   3. the top of the retriever's own ranking — the near-misses and maybes
 *
 * A set, not an array: the caller filters the catalogue by membership, so order
 * would be discarded anyway and the catalogue's own order is the stable one.
 */
function shortlistIds(
  catalogue: ReadonlyArray<Experience>,
  candidateIds: ReadonlyArray<string>,
  plan: Plan,
  rejected: ReadonlyArray<Rejection>,
): Set<string> {
  const known = new Set(catalogue.map((item) => item.id));
  const chosen = new Set<string>();

  const take = (id: string): void => {
    if (known.has(id)) chosen.add(id);
  };

  for (const stop of plan.stops) take(stop.experienceId);
  for (const rejection of rejected) take(rejection.experienceId);

  const budget = plan.stops.length + rejected.length + MAX_CANDIDATES;
  for (const id of candidateIds) {
    if (chosen.size >= budget) break;
    take(id);
  }

  return chosen;
}

/**
 * Everything the UI needs, computed once per request.
 *
 * `fits` and `scores` are computed only for the rows in `shortlisted`, not for
 * every catalogue row. That comment used to say "for every row… that is 4,596
 * fits and scores per request, which measures at well under the cost of
 * serialising the result" — and the serialising was the cost. Every row, its
 * fit and its score were crossing into the client component, and the deployed
 * homepage was 48.9 MB of HTML at 22 s to first byte. The list was already
 * paginated to 24 visible rows with a "show 48 more" button, so the other 4,572
 * were downloaded to be hidden.
 *
 * The bound is `result.candidateIds` — the retriever's own ranking, which
 * `planItinerary` already computed and returned. Plus every planned stop and
 * every rejection, because the "why not that" ledger is the product: a
 * rejection with no card behind it is a rejection nobody can read.
 */
export async function computeDiscovery(params: URLSearchParams): Promise<Discovery> {
  const context = contextFromParams(params);
  const { experiences } = await loadCatalogue();
  const rowCount = experiences.length;

  /*
    `weekdayOf`, not the literal `6` this used to pass. `lib/time` numbers
    weekdays 0 = MONDAY, so 6 is SUNDAY — the gate was evaluating Sunday's
    opening hours for every card, and the error is invisible because both are
    small integers. `lib/time` warns about exactly this conflation. Read from
    the clock for the same reason `month` already was: these are real OSM hours
    and belong to a real day.
  */
  const now = new Date();
  const weekday = weekdayOf(now);

  // `mode` is deliberately not passed: planItinerary derives it from the context
  // (`travelMode === "any" ? "walk" : travelMode`), and restating it here is a
  // second place for the two to disagree.
  const result = planItinerary(context, experiences, {
    weekday,
    month: now.getMonth() + 1,
    planId: "travelbuddy",
  });

  const shortlist = shortlistIds(
    experiences,
    result.candidateIds,
    result.plan,
    result.rejected,
  );

  const origin = context.origin.point;
  const fits: Record<string, Fit> = {};
  const scores: Record<string, ScoreBreakdown> = {};
  for (const experience of experiences) {
    if (!shortlist.has(experience.id)) continue;
    const travelMin = origin ? travelEstimate(origin, experience.location) : 0;
    const visitFrom = context.nowMin + travelMin + 10;
    fits[experience.id] = computeFit(context, experience, {
      travelMin,
      bufferMin: 10,
      visitFrom,
      visitTo: visitFrom + experience.durationMin,
      cost: experience.pricePerPerson ?? { minor: 0, currency: "INR" },
      weekday,
    });
    scores[experience.id] = score(context, experience, DEFAULT_PROFILE, { travelMin });
  }

  return {
    context,
    experiences: experiences.filter((experience) => shortlist.has(experience.id)),
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

/**
 * A `DiscoverySession` for the feature layer, built from the same URL the home
 * page reads.
 *
 * This is the seam the traveller-side features were waiting on. Every one of
 * them — `whatif`, `group`, `weather`, `health`, `explain`, `discovery/unmet` —
 * takes a session and an `EnginePort`, and until this existed there was no way
 * for a route to hand them one, so 20,828 lines of finished feature code had no
 * caller. `createSession` is cheap (a context and a catalogue index), so each
 * feature route builds its own rather than sharing one across requests.
 *
 * The plan is NOT computed here. `whatif` runs the real planner once per
 * scenario by design — "a what-if runs the real planner, not a narration of what
 * the planner would do" — so pre-computing it would be both wasted and wrong.
 */
export async function computeFeatureSession(
  params: URLSearchParams,
): Promise<{ session: DiscoverySession; catalogue: Experience[]; engine: EnginePort }> {
  // Parsed once. The context is the source of truth for every field, and five
  // separate parses of the same params is five places for two of them to disagree.
  const ctx = contextFromParams(params);

  const seed: ContextSeed = {
    id: ctx.id,
    origin: { label: ctx.origin.label, point: { ...ctx.origin.point! } },
    availableMin: ctx.availableMin,
    nowMin: ctx.nowMin,
    budgetMinor: ctx.budget?.minor ?? null,
    partySize: ctx.partySize,
    accessNeeds: [...ctx.accessNeeds],
    // Left empty on purpose: the URL carries the traveller's situation, not their
    // interests, and inventing interests here would make every score depend on
    // a guess the traveller never made.
    interests: [],
    travelMode: ctx.travelMode,
    weather: { ...ctx.weather },
  };

  const { experiences } = await loadCatalogue();
  const engine = realEngine();
  return {
    session: createSession({ engine, seed, catalogue: experiences, weights: DEFAULT_PROFILE }),
    catalogue: experiences,
    engine,
  };
}
