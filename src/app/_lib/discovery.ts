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

import { estimateLeg as engineEstimateLeg, estimateTravelMinutes, planItinerary } from "@/engine/plan";
import { computeFit } from "@/engine/fit";
import { replan } from "@/engine/replan";
import { score, DEFAULT_PROFILE } from "@/engine/scoring";
import { stress } from "@/engine/stress";
import { DiscoveryContext, type ContextChange, type Experience, type Fit, type Plan, type ScoreBreakdown } from "@/contracts";
import { buildRealityChanged, type RealityChanged } from "@/features/discovery";
import { diffPlans, indexCatalogue } from "@/features/discovery/diff";
import { loadCatalogue } from "./catalogue";
import { originNote, resolvePlace } from "./place";
import {
  TRIGGER_BY_KEY,
  changeForTrigger,
  intentParams,
  previousParams,
} from "./triggers";

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

/**
 * Child ages, clamped to 0..17 and capped at the party size.
 *
 * The contract's bound, not an invented one: an age of 40 is not a toddler
 * constraint, it is a typo, and letting it through would silently disable every
 * family-fit term in the scorer.
 */
function readAges(raw: string | null, partySize: number): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => Number.parseInt(part, 10))
    .filter((age) => Number.isInteger(age) && age >= 0 && age <= 17)
    .slice(0, partySize);
}

/**
 * A comma-separated free-text list, cleaned and bounded.
 *
 * `interests` and `avoid` are open vocabulary by design — "quiet courtyard",
 * "no queue" — so there is no enum to validate against. What there is instead: a
 * length cap per entry and a count cap, because these end up in a tokeniser and
 * a URL is attacker-controlled. An entry that survives is a trimmed,
 * single-spaced string; anything longer is dropped rather than truncated, since a
 * half-sentence is a worse retrieval term than none.
 */
function readList(raw: string | null, maxEntries: number): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0 && part.length <= 60)
    .slice(0, maxEntries);
}

/** The contract's enum is `walk | auto | transit | any`; anything else is dropped. */
function parseTravelMode(raw: string | null): "walk" | "auto" | "transit" | "any" {
  return raw === "walk" || raw === "auto" || raw === "transit" || raw === "any" ? raw : "walk";
}

export function contextFromParams(
  params: URLSearchParams,
  origin: DiscoveryContext["origin"] = { label: DEFAULT_ORIGIN.label, point: { ...DEFAULT_ORIGIN.point } },
): DiscoveryContext {
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
  const excludedIds = (params.get("x") ?? "").split(",").filter(Boolean);
  const childAges = readAges(params.get("ages"), partySize);
  const budget = budgetRupees >= 5000 ? null : { minor: budgetRupees * 100, currency: "INR" as const };
  // Free vocabulary, so no enum: the engine tokenises these for retrieval and
  // the scorer weights them. Bounded, because an unbounded array in a URL is a
  // free denial-of-service on our own parser.
  const interests = readList(params.get("i"), 8);
  const avoid = readList(params.get("avoid"), 8);

  /*
    `original` is the ask, not the latest state.

    It used to be built from the current params, which meant every "reality
    changed" click silently moved the baseline: `preservedIntent` compared a
    value with itself and the "still looking for what you asked for at the
    start" line became a claim about the last click. So it is read from the
    `intent` query, which the trigger table writes exactly once and never
    overwrites. A first load has no `intent`, and the current situation IS the
    intent.
  */
  const intent = intentParams(params);
  // Same origin as the current context: a change of window must not also move the
  // traveller, and the baseline is read from a query that never carries one.
  const originalContext = intent ? contextFromParams(intent, origin) : null;

  return DiscoveryContext.parse({
    id: "travelbuddy",
    origin,
    availableMin,
    nowMin: readInt(params.get("now"), 0, 1439, 840),
    budget,
    budgetPerPerson: null,
    partySize,
    partyType,
    childAges,
    accessNeeds: needsRaw,
    diets: [],
    interests,
    avoid,
    weather: { condition: weather, tempC: 29, source: "live" },
    travelMode,
    requests: [],
    excludedIds,
    pinnedIds: [],
    original:
      originalContext?.original ??
      (originalContext
        ? {
            availableMin: originalContext.availableMin,
            budget: originalContext.budget,
            partySize: originalContext.partySize,
            accessNeeds: originalContext.accessNeeds,
          }
        : { availableMin, budget, partySize, accessNeeds: needsRaw }),
  });
}

export interface Discovery {
  context: DiscoveryContext;
  /** What to say about the origin, or null when it resolved. See `place.ts`. */
  originNote: string | null;
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
 * Plan options, built once per request.
 *
 * `weekday` and `month` are the same for the before and after plans on purpose:
 * a diff that compared a July plan against an October one would report seasonal
 * gate failures as "swaps", which is the one thing a swap diff must not do.
 */
function planOptions() {
  return { weekday: 6 as const, month: new Date().getMonth() + 1, planId: "travelbuddy" };
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
  const place = await resolvePlace(params.get("at") ?? "");
  const origin: DiscoveryContext["origin"] = place.label
    ? { label: place.label, point: place.point }
    : { label: DEFAULT_ORIGIN.label, point: { ...DEFAULT_ORIGIN.point } };
  const context = contextFromParams(params, origin);
  const { experiences } = await loadCatalogue();
  const rowCount = experiences.length;

  // `mode` is deliberately not passed: planItinerary derives it from the context
  // (`travelMode === "any" ? "walk" : travelMode`), and restating it here is a
  // second place for the two to disagree.
  const result = planItinerary(context, experiences, planOptions());

  const from = context.origin.point;
  const mode = context.travelMode === "any" ? "walk" : context.travelMode;
  const fits: Record<string, Fit> = {};
  const scores: Record<string, ScoreBreakdown> = {};
  for (const experience of experiences) {
    const travelMin = from ? estimateTravelMinutes(context, experience.location, mode) : 0;
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
    originNote: originNote(place),
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

/**
 * The "reality changed" diff, or null when nothing has changed yet.
 *
 * Two plans and one comparison, both from the engine: `before` is the plan for
 * the query the traveller was on a second ago, `after` is the plan for the query
 * they are on now. `diffPlans` writes the reasons — a removal borrows the
 * engine's own `Rejection.message`, an addition borrows the winning
 * `PlanStop.why` — so nothing in the panel is written here.
 *
 * Null rather than a fabricated empty diff when `changed` names a trigger we do
 * not have, or when there is no previous query. A panel that renders "nothing
 * changed" when it cannot tell is a lie told with the layout.
 */
export async function realityAfter(
  params: URLSearchParams,
  after: Discovery,
): Promise<RealityChanged | null> {
  const key = params.get("changed");
  const trigger = key ? TRIGGER_BY_KEY.get(key) : undefined;
  const before = previousParams(params);
  if (!trigger || !before) return null;

  const { experiences } = await loadCatalogue();
  const prevCtx = contextFromParams(before, after.context.origin);
  const prevPlan = planItinerary(prevCtx, experiences, planOptions()).plan;
  const change: ContextChange = changeForTrigger(trigger, params);

  /*
  `engineEstimateLeg`, not the engine's async `travelBetween`: the diff has to
  price a removed stop synchronously, and a network call cannot be in that path.
  It is the same offline estimator the packer gates on, so the travel this panel
  quotes is the travel the feasibility gate rejected on.
  */
  const diff = diffPlans({ travelBetween: engineEstimateLeg }, prevPlan, after.plan, {
    catalogue: indexCatalogue(experiences),
    change,
    travelMode: after.context.travelMode,
    origin: after.context.origin.point,
  });

  return buildRealityChanged({
    change,
    diff,
    before: prevPlan,
    after: after.plan,
    // `prevCtx` and not `intent`: the before plan was solved against the window
    // that was in force then, and shaping it with the current one would report a
    // before-state the traveller was never shown.
    prevCtx,
    nextCtx: after.context,
    intent: contextFromParams(intentParams(params) ?? before, after.context.origin),
    // The engine's own flag, not a restatement of ours. It is a real boolean so
    // that "the intent survived" is checkable rather than asserted here.
    enginePreservedIntent: engineReplanPreserved(prevPlan, after, change),
    stressBefore: stress(prevPlan, prevCtx).score,
  });
}

/**
 * Whether the engine agrees the original intent survived.
 *
 * `replan` exists to do exactly one thing and returns `preservedIntent` for it,
 * so the honest way to report it is to ask the engine rather than to compare two
 * objects here and hope they match. Its own definition is
 * `ctx.original === ctx.original`, which is true by construction — that is the
 * point, and it is why the panel also shows the frozen baseline in
 * `intentLines` rather than trusting the boolean alone.
 */
function engineReplanPreserved(
  prevPlan: Plan,
  after: Discovery,
  change: ContextChange,
): boolean {
  return replan(prevPlan, after.context, change).preservedIntent;
}

/** Serialise a context back into search params, for the "Change" links. */
export function paramsFromContext(context: DiscoveryContext, params?: URLSearchParams): string {
  const out = params ? new URLSearchParams(params) : new URLSearchParams();
  out.set("t", String(context.availableMin));
  out.set("p", String(context.partySize));
  out.set("pt", context.partyType);
  out.set("m", context.travelMode);
  out.set("w", context.weather.condition);
  const rupees = context.budget ? Math.round(context.budget.minor / 100) : 5000;
  if (rupees !== 3000) out.set("b", String(rupees));
  else out.delete("b");
  if (context.accessNeeds.length) out.set("needs", context.accessNeeds.join(","));
  else out.delete("needs");
  if (context.childAges.length) out.set("ages", context.childAges.join(","));
  else out.delete("ages");
  if (context.excludedIds.length) out.set("x", context.excludedIds.join(","));
  else out.delete("x");
  if (context.interests.length) out.set("i", context.interests.join(","));
  else out.delete("i");
  if (context.avoid.length) out.set("avoid", context.avoid.join(","));
  else out.delete("avoid");
  /*
    Only the label travels. The coordinate is re-derived on the server from the
    label every time, so a hand-edited `lat`/`lon` in the address bar cannot
    desync the place the traveller named from the point the distances are
    measured from. A URL that says "Colaba" is the whole state; anything else is
    a second source of truth about a location.
  */
  if (context.origin.label) out.set("at", context.origin.label);
  else out.delete("at");
  /*
    `was`, `intent` and `changed` are carried, not rebuilt. A "Back to the map"
    link that dropped `x` would resurrect a stop the traveller just watched leave
    the plan, and one that dropped `intent` would reset the frozen baseline to
    whatever the current situation happens to be — which is the exact drift
    `original` exists to prevent.
  */
  return out.toString();
}
