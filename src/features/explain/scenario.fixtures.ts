/**
 * The scenario data, shared by `scenario.test.ts` and `ledger.test.ts`.
 *
 * Its own module so the two suites assert against the SAME objects by reference:
 * `expect(props.score).toBe(stop.score)` is only a real check when both sides
 * hold the identical object rather than two equal-looking copies.
 *
 * Every record is parsed with the contract's own zod schema, so a fixture that
 * drifts from `src/contracts/index.ts` fails here rather than in a card.
 */

/**
 * A realistic scenario, at contract level, covering all four outcomes.
 *
 * `evidence.test.ts` proves the chain against a reference gate it controls: eleven
 * candidates, each failing on a different hard constraint, and every one asserted
 * against the number the gate computed. This file covers the shapes that gate
 * cannot produce in one pass, because they are the ones the shipped demo data
 * actually contains and they are where the previous two-outcome ledger went blank:
 *
 *   1. a SELECTED stop whose `why` contains a cost, and whose `checks[]` has a
 *      failure — a caveat that must lead without cancelling the recommendation;
 *   2. a REJECTED candidate with TWO rejections, the first unrelaxable — the honest
 *      answer is two problems, and the money fix fixes one of them;
 *   3. a rejection whose sentence quotes a figure that exists ONLY in the supplied
 *      `fits` map, because a candidate the gate dropped was never fitted into the
 *      plan. This is the case the figure audit exists for, and it is real copy;
 *   4. a CONSIDERED candidate — fitted, scored, and never packed. Before this layer
 *      existed the question "why is this not in my plan?" had no answer anywhere;
 *   5. a NOT_CONSIDERED catalogue entry the data never touched.
 *
 * Every record is parsed with the contract's own zod schema, so a fixture that
 * drifts from `src/contracts/index.ts` fails here rather than in a card. The
 * numbers are the ones the shipped demo data used, so the sentences this produces
 * are the sentences a traveller would actually read.
 */

import {
  DiscoveryContext,
  Experience as ExperienceSchema,
  Fit as FitSchema,
  Plan as PlanSchema,
  Rejection as RejectionSchema,
  ScoreBreakdown as ScoreSchema,
  type Experience,
  type Fit,
  type Plan,
  type Rejection,
  type ScoreBreakdown,
} from "../../contracts";

import { auditLedger, explainOne, explainPlan, ledgerSummary, outcomeLabel } from "./index";
import type { Explanation, ExplanationLedger } from "./index";

const AT = "2026-01-01T00:00:00.000Z";
const rupees = (minor: number) => ({ minor, currency: "INR" as const });

/**
 * Every `.nullable()` field in the contract carries no default, so the parsed
 * output type requires all of them. Filling them once here keeps each record below
 * to the three or four fields that actually differ, and still fails loudly at
 * parse time if the contract changes shape.
 */
export function record(input: Partial<Experience> & Pick<Experience, "id" | "name" | "category">): Experience {
  return ExperienceSchema.parse({
    location: { lat: 18.93, lon: 72.83 },
    durationMin: 60,
    pricePerPerson: rupees(0),
    capacity: null,
    hours: { raw: "Mo-Su 09:00-20:00", status: "ok", lastVerified: null },
    indoorOutdoor: "outdoor",
    accessibility: {
      stepFree: true,
      strollerOk: true,
      lowStairs: true,
      seatingAvailable: true,
      hearingLoop: false,
      restroomOnSite: true,
    },
    kidFriendly: true,
    minAge: null,
    diets: [],
    cuisines: [],
    rating: { value: 4.4, count: 100, rawMean: 4.5 },
    blurb: null,
    description: null,
    keywords: [],
    provenance: {},
    neighbourhood: "Fort",
    ...input,
  });
}

/** 9:30am, three hours, ₹1,500, four people, one who cannot manage stairs. */
export const CTX = DiscoveryContext.parse({
  id: "ctx-explain",
  origin: { label: "Colaba", point: { lat: 18.9167, lon: 72.8333 } },
  availableMin: 180,
  nowMin: 570,
  budget: { minor: 150_000, currency: "INR" },
  partySize: 4,
  partyType: "family_with_children",
  childAges: [3],
  accessNeeds: ["lowStairs"],
  diets: [],
  interests: ["local", "craft"],
  avoid: ["crowded"],
  weather: { condition: "cloudy", tempC: 29, source: "simulated" },
  requests: [],
  excludedIds: [],
  pinnedIds: [],
  original: { availableMin: 180, budget: { minor: 150_000, currency: "INR" }, partySize: 4, accessNeeds: ["lowStairs"] },
});

export const CATALOGUE: Experience[] = [
  record({
    id: "exp_market_01",
    name: "Kala Ghoda flea market",
    category: "market",
    durationMin: 75,
    hours: { raw: "Mo-Su 11:00-20:00", status: "ok", lastVerified: null },
    diets: ["vegetarian"],
    rating: { value: 4.4, count: 1284, rawMean: 4.38 },
    // `accessibility` was scraped; `durationMin` is curated and earns no badge.
    provenance: { accessibility: "osm", durationMin: "curated" },
  }),
  record({
    id: "exp_pottery_02",
    name: "Kumbharwada pottery session",
    category: "craft_workshop",
    location: { lat: 19.0178, lon: 72.8397 },
    durationMin: 120,
    pricePerPerson: rupees(45_000),
    capacity: 8,
    hours: { raw: "Tu-Su 11:00-19:00", status: "ok", lastVerified: null },
    indoorOutdoor: "indoor",
    accessibility: {
      stepFree: true,
      strollerOk: true,
      lowStairs: true,
      seatingAvailable: true,
      hearingLoop: true,
      restroomOnSite: true,
    },
    minAge: 6,
    diets: ["vegetarian"],
    rating: { value: 4.8, count: 87, rawMean: 4.9 },
    // The AI-inferred badge has something to badge.
    provenance: { durationMin: "inferred", pricePerPerson: "provider" },
    neighbourhood: "Dharavi",
  }),
  record({
    id: "exp_walk_03",
    name: "Dhobi Ghat guided walk",
    category: "heritage_site",
    location: { lat: 18.9889, lon: 72.8133 },
    durationMin: 90,
    pricePerPerson: rupees(60_000),
    hours: { raw: "Mo-Sa 08:00-12:00", status: "ok", lastVerified: null },
    // `null`, not `false`: iD's `wheelchair` tag is 3-state and an unsurveyed
    // provider has not said no. Which is why this is a rejection, not a score hit.
    accessibility: {
      stepFree: null,
      strollerOk: null,
      lowStairs: false,
      seatingAvailable: true,
      hearingLoop: null,
      restroomOnSite: null,
    },
    kidFriendly: false,
    minAge: 12,
    rating: { value: 4.6, count: 312, rawMean: 4.71 },
    provenance: { description: "inferred" },
    neighbourhood: "Mahalaxmi",
  }),
  record({
    id: "exp_cafe_04",
    name: "Kala Ghada Cafe",
    category: "cafe",
    durationMin: 45,
    pricePerPerson: rupees(32_000),
    // `unparsable`, not `ok`: hours exist and we cannot evaluate them, so the gate
    // softens to a warning instead of pretending the place is open.
    hours: { raw: "Mo-Su 08:00-23:00 PH off", status: "unparsable", lastVerified: null },
    indoorOutdoor: "indoor",
    diets: ["vegetarian", "vegan"],
    rating: { value: 4.2, count: 640, rawMean: 4.18 },
    provenance: { hours: "osm" },
  }),
  record({
    id: "exp_shore_05",
    name: "Marine Drive shell museum walk",
    category: "heritage_site",
    location: { lat: 18.944, lon: 72.8231 },
    durationMin: 60,
    rating: { value: 4.4, count: 3, rawMean: 5.0 },
    neighbourhood: "Malabar Hill",
  }),];

export const catalogue = new Map(CATALOGUE.map((item) => [item.id, item]));

export const FIT_MARKET = FitSchema.parse({
  experienceId: "exp_market_01",
  travelMin: 12,
  activityMin: 75,
  bufferMin: 15,
  totalMin: 102,
  availableMin: 180,
  fitRatio: 1.76,
  cost: rupees(0),
  budget: rupees(150_000),
  checks: [
    { label: "Travel time", pass: true, detail: "12 min from Colaba" },
    { label: "Opening hours", pass: true, detail: "Open until 20:00" },
    { label: "Low stairs", pass: true, detail: "Flat street" },
  ],
  verdict: "fits",
});

export const SCORE_MARKET = ScoreSchema.parse({
  experienceId: "exp_market_01",
  total: 0.82,
  components: [
    { key: "categoryFit", label: "Matches what you asked for", value: 0.31, weight: 0.9, reason: "Market, and you said local" },
    { key: "proximity", label: "Close to where you are", value: 0.22, weight: 0.8, reason: "1.2 km from your hotel" },
    { key: "crowd", label: "Not too crowded", value: -0.06, weight: 0.5, reason: "Busy after 18:00" },
  ],
  profileVersion: "wp_1.2.0",
  learnedComponents: ["crowd"],
});

export const FIT_POTTERY = FitSchema.parse({
  experienceId: "exp_pottery_02",
  travelMin: 35,
  activityMin: 120,
  bufferMin: 17,
  totalMin: 172,
  availableMin: 180,
  fitRatio: 1.05,
  cost: rupees(180_000),
  budget: rupees(150_000),
  checks: [
    { label: "Travel time", pass: true, detail: "35 min to Dharavi" },
    // The caveat the card has to carry.
    { label: "Budget", pass: false, detail: "₹1,800 for four, over your ₹1,500" },
  ],
  verdict: "tight",
});

export const SCORE_POTTERY = ScoreSchema.parse({
  experienceId: "exp_pottery_02",
  total: 0.64,
  components: [
    { key: "categoryFit", label: "Matches what you asked for", value: 0.28, weight: 0.9, reason: "Craft, and you said craft" },
    { key: "kidFriendly", label: "Works with a 3-year-old", value: 0.15, weight: 0.9 },
    { key: "price", label: "Fits the budget", value: -0.14, weight: 0.7, reason: "₹300 over your limit for four" },
  ],
  profileVersion: "wp_1.2.0",
  learnedComponents: [],
});

export const FIT_WALK = FitSchema.parse({
  experienceId: "exp_walk_03",
  travelMin: 30,
  activityMin: 90,
  bufferMin: 15,
  totalMin: 135,
  availableMin: 180,
  fitRatio: 1.33,
  // The only record of this rejected candidate's own cost. Its rejection message
  // quotes ₹2,400, and this is the line that corroborates it.
  cost: rupees(240_000),
  budget: rupees(150_000),
  checks: [
    { label: "Low stairs", pass: false, detail: "Steep, with no step-free route" },
    { label: "Budget", pass: false, detail: "₹2,400 for four" },
  ],
  verdict: "does_not_fit",
});

export const FIT_SHORE = FitSchema.parse({
  experienceId: "exp_shore_05",
  travelMin: 18,
  activityMin: 60,
  bufferMin: 15,
  totalMin: 93,
  availableMin: 180,
  fitRatio: 1.94,
  cost: rupees(0),
  budget: rupees(150_000),
  checks: [
    { label: "Low stairs", pass: true, detail: "Flat the whole way" },
    { label: "Rating", pass: true, detail: "Only 3 reviews" },
  ],
  verdict: "fits",
});

export const SCORE_SHORE = ScoreSchema.parse({
  experienceId: "exp_shore_05",
  total: 0.77,
  components: [
    { key: "proximity", label: "Close to where you are", value: 0.26, weight: 0.8, reason: "2.1 km" },
    // No `reason`: the ledger has to fall back to the arithmetic.
    { key: "categoryFit", label: "Matches what you asked for", value: 0.24, weight: 0.9 },
    { key: "novelty", label: "New to you", value: 0.09, weight: 0.3 },
  ],
  profileVersion: "wp_1.2.0",
  learnedComponents: ["novelty"],
});

export const REJECTIONS: Rejection[] = [
  RejectionSchema.parse({
    experienceId: "exp_walk_03",
    code: "no_low_stairs",
    message: "The walk is steep and has no step-free route, and you asked for low stairs.",
    shortfall: null,
    unit: null,
    relaxable: false,
  }),
  RejectionSchema.parse({
    experienceId: "exp_walk_03",
    code: "over_budget",
    message: "₹900 over your budget. The guided walk is ₹2,400 for four against your ₹1,500.",
    shortfall: 90_000,
    unit: "minor_units",
    relaxable: true,
  }),
  RejectionSchema.parse({
    experienceId: "exp_cafe_04",
    code: "hours_unverified",
    message: "Opening hours have never been verified, so we cannot promise a table. Worth a phone call.",
    shortfall: null,
    unit: null,
    relaxable: false,
  }),
];

export const FITS: Record<string, Fit> = {
  exp_market_01: FIT_MARKET,
  exp_pottery_02: FIT_POTTERY,
  exp_walk_03: FIT_WALK,
  exp_shore_05: FIT_SHORE,
};

export const SCORES: Record<string, ScoreBreakdown> = {
  exp_market_01: SCORE_MARKET,
  exp_pottery_02: SCORE_POTTERY,
  exp_shore_05: SCORE_SHORE,
};

export const PLAN: Plan = PlanSchema.parse({
  id: "plan-explain",
  contextId: CTX.id,
  stops: [
    {
      experienceId: "exp_market_01",
      arriveMin: 585,
      departMin: 660,
      fit: FIT_MARKET,
      score: SCORE_MARKET,
      why: ["Free, and the market is open until 20:00", "1.2 km from your hotel, so almost no travel"],
      order: 0,
    },
    {
      experienceId: "exp_pottery_02",
      arriveMin: 715,
      departMin: 835,
      fit: FIT_POTTERY,
      score: SCORE_POTTERY,
      // A cost, in the same list as the reasons to go. Exactly the line a naive
      // ledger would render as a reason to visit.
      why: [
        "A working studio rather than a shop, which is the local character you asked for",
        "₹300 over your budget for four people",
      ],
      order: 1,
    },
  ],
  legs: [
    {
      fromId: "exp_market_01",
      toId: "exp_pottery_02",
      mode: "auto",
      minutes: 35,
      metres: 11_200,
      detail: "via Mahim Causeway",
      estimated: true,
    },
  ],
  totalMin: 265,
  totalCost: rupees(180_000),
  utilisation: 1.47,
  totalMetres: 11_200,
  rejected: REJECTIONS,
  relaxations: [],
  stressScore: 44,
  stressFactors: [
    { dimension: "pinDebt", weight: 0.18, value: 62, rescue: "Drop the pottery booking and put a free street-food stop in its place — it saves ₹1,800." },
    { dimension: "overload", weight: 0.25, value: 18, rescue: null },
  ],
  createdAt: AT,
  engineVersion: "engine_0.1.0",
});

export const OPTS = { catalogue, fits: FITS, scores: SCORES };
export const LEDGER: ExplanationLedger = explainPlan(PLAN, CTX, OPTS);

export const need = (id: string): Explanation => {
  const found = LEDGER.byId.get(id);
  if (!found) throw new Error(`no explanation for ${id}`);
  return found;
};

/**
 * The grouping `whyLedgerProps` expects from the app: every rejection row for an
 * id, in the order the engine emitted them. Built here rather than inside the
 * adapter because the adapter takes the engine's rows as given — it must not
 * re-derive, reorder or filter them, or "why not that" would stop being the
 * engine's own account of what happened.
 */
export const rejectionsById = (rows: readonly Rejection[]): ReadonlyMap<string, Rejection[]> => {
  const map = new Map<string, Rejection[]>();
  for (const row of rows) {
    const list = map.get(row.experienceId);
    if (list) list.push(row);
    else map.set(row.experienceId, [row]);
  }
  return map;
};


