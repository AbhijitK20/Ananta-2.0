/**
 * Scoring. ONE scalar, split into named components, so it is auditable,
 * re-derivable, and explainable to a traveller in a sentence.
 *
 * WHY ONE SCALAR: the reference implementation we rejected called `minimize` and
 * `maximize` on the same solver object, which is lexicographic — the penalty
 * objective silently lands at the LOWEST priority and the "relaxation" never
 * takes effect. A single number, with a `profileVersion`, has no such failure
 * mode and lets `validator.ts` recompute it independently.
 *
 * Bayesian ratings: a 5.0 from 3 reviews must not outrank a 4.6 from 3,000.
 * We shrink toward a regional prior weighted by sample size, and keep rawMean and
 * count so the UI can show the shrinkage instead of hiding it.
 */
import type {
  DiscoveryContext,
  Experience,
  ScoreBreakdown,
  ScoreComponent,
  WeightProfile,
  Provenance,
} from "@/contracts";
import { toMajor, formatPerPerson } from "@/lib/money";
import { EPOCH_ISO, bucketOf } from "@/lib/time";
/** Peak for Mumbai congestion: 08:00-11:00 and 17:00-21:00. */
function isPeakHour(minute: number): boolean {
  return (minute >= 8 * 60 && minute < 11 * 60) || (minute >= 17 * 60 && minute < 21 * 60);
}
/** Re-exported so packer.ts and engine/index.ts need one import, not two. */
export type { WeightProfile };

/**
 * The weight profile. `profileVersion` is required so a score can always be
 * traced back to the weights that produced it.
 */
export const DEFAULT_PROFILE: WeightProfile = {
  version: "v1.0.0",
  weights: {
    interestMatch: 1.0,
    rating: 0.7,
    valueForMoney: 0.35,
    authenticity: 0.25,
    weatherFit: 0.6,
    crowdPenalty: 0.4,
    groupFit: 0.65,
    novelty: 0.2,
    travelFriction: 0.5,
    dataConfidence: 0.3,
    providerReliability: 0.15,
  },
  source: "prior",
  // A named sentinel, not a Date. Constructing one here would put a Date back
  // inside the engine; see EPOCH_ISO in lib/time.ts.
  updatedAt: EPOCH_ISO,
  observations: 0,
};

const LEARNABLE = new Set(Object.keys(DEFAULT_PROFILE.weights));

/** Regional prior for rating shrinkage, 0..5. Deliberately a bit below average. */
const RATING_PRIOR = 3.9;
/** Reviews needed before the raw mean outweighs the prior. */
const PRIOR_WEIGHT = 40;

/**
 * Empirical Bayes shrinkage toward the regional prior.
 *
 * A 5.0 from 3 reviews becomes roughly 3.9, and a 4.6 from 3,000 stays 4.6.
 * `rawMean` and `count` are preserved so the UI can write "4.6 (312)".
 */
export function shrinkRating(rawMean: number | null, count: number): number {
  if (rawMean === null || count === 0) return RATING_PRIOR;
  return (rawMean * count + RATING_PRIOR * PRIOR_WEIGHT) / (count + PRIOR_WEIGHT);
}

/** Wilson-style lower bound: breaks ties toward the better-reviewed option. */
export function ratingLowerBound(rawMean: number, count: number, z = 1.28): number {
  if (count === 0) return 0;
  const p = rawMean / 5;
  const n = count;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom) * 5;
}

/** How much of the record is verified rather than guessed. Feeds the badge. */
function dataConfidence(exp: Experience): number {
  const entries = Object.values(exp.provenance ?? {});
  if (entries.length === 0) return 0.5;
  const weight: Record<Provenance, number> = {
    curated: 1.0,
    provider: 0.95,
    osm: 0.7,
    derived: 0.85,
    inferred: 0.35,
  };
  let sum = 0;
  for (const p of entries) sum += weight[p] ?? 0.5;
  return sum / entries.length;
}

/** Interest match. Overlap between the traveller's asks and the record's signals. */
function interestMatch(ctx: DiscoveryContext, exp: Experience): { value: number; why: string } {
  const wanted = [
    ...ctx.interests,
    ...ctx.requests.map((r) => r.pos),
    ...exp.perception.activities,
    ...exp.perception.atmosphere,
    ...exp.keywords,
    exp.category,
  ].map((s) => s.toLowerCase());

  const have = [
    ...ctx.interests,
    ...ctx.requests.map((r) => r.pos),
  ].map((s) => s.toLowerCase());

  if (have.length === 0) return { value: 0.5, why: "no stated interests, so a neutral prior" };

  let hits = 0;
  const matched: string[] = [];
  for (const h of have) {
    if (h.length < 3) continue;
    if (wanted.some((w) => w.includes(h) || h.includes(w))) {
      hits++;
      if (matched.length < 2) matched.push(h);
    }
  }
  const value = Math.min(1, hits / Math.max(2, have.length * 0.5));
  return {
    value,
    why: matched.length ? `matches what you asked for: ${matched.join(", ")}` : "nothing you asked for specifically",
  };
}

function valueForMoney(exp: Experience, partySize: number): { value: number; why: string } {
  if (exp.pricePerPerson === null) {
    return { value: 1, why: "free" };
  }
  const perHead = exp.pricePerPerson.minor;
  if (perHead === 0) return { value: 1, why: "free" };
  const r = shrinkRating(exp.rating.rawMean, exp.rating.count);
  // Diminishing: a 1-rupee vada pav should not out-score a good 300-rupee meal.
  const ratio = r / (1 + Math.log10(1 + perHead / 100) * 0.8);
  return {
    value: Math.min(1, ratio / 4),
    why: `${formatPerPerson({ minor: perHead, currency: "INR" })} for ${partySize}, rated ${r.toFixed(1)}`,
  };
}

function weatherFit(ctx: DiscoveryContext, exp: Experience): { value: number; why: string } {
  const cond = ctx.weather.condition;
  const raining = cond === "light_rain" || cond === "heavy_rain" || cond === "storm";
  const hot = cond === "heat";
  const windy = cond === "wind";
  const sensitive = exp.weatherSensitive;

  if (sensitive === "none") return { value: 0.7, why: "fine whatever the weather" };

  const bad =
    (raining && (sensitive === "rain" || sensitive === "any")) ||
    (hot && (sensitive === "heat" || sensitive === "any")) ||
    (windy && (sensitive === "wind" || sensitive === "any"));

  if (bad) {
    return { value: 0.1, why: `outdoors, and it is ${cond.replace("_", " ")}` };
  }
  if (exp.indoorOutdoor === "indoor" || exp.indoorOutdoor === "covered") {
    return { value: 1, why: `${exp.indoorOutdoor}, so the weather does not matter` };
  }
  return { value: 0.6, why: "outdoors, but survivable in this weather" };
}

function crowdPenalty(ctx: DiscoveryContext, exp: Experience): { value: number; why: string } {
  const peak = isPeakHour(ctx.nowMin);
  if (!peak) return { value: 0.8, why: "off-peak, so it should be quiet" };
  const isWeekendSpot = exp.category === "nightlife" || exp.category === "event";
  if (isWeekendSpot) return { value: 0.6, why: "busy on a peak evening, but that is the point of it" };
  return { value: 0.45, why: "peak hour, so expect a queue" };
}

function groupFit(ctx: DiscoveryContext, exp: Experience): { value: number; why: string } {
  if (ctx.childAges.length === 0) {
    if (exp.kidFriendly === false) return { value: 0.4, why: "not a place for children" };
    return { value: 0.7, why: "no children in the party" };
  }
  const youngest = Math.min(...ctx.childAges);
  if (youngest <= 6) {
    if (exp.kidFriendly === true) return { value: 1, why: "built for small children" };
    if (exp.kidFriendly === false) return { value: 0.15, why: "not suitable for a toddler" };
    if (exp.minAge !== null && youngest < exp.minAge) {
      return { value: 0.2, why: `minimum age is ${exp.minAge}` };
    }
    return { value: 0.6, why: "no child information, which is not reassuring" };
  }
  if (youngest >= 13) {
    return exp.kidFriendly === true
      ? { value: 0.8, why: "welcomes teenagers" }
      : { value: 0.6, why: "no particular teen appeal" };
  }
  return { value: 0.7, why: "works for a mixed-age group" };
}

function novelty(ctx: DiscoveryContext, exp: Experience): { value: number; why: string } {
  if (ctx.pinnedIds.includes(exp.id)) return { value: 0, why: "already in your plan" };
  if (ctx.excludedIds.includes(exp.id)) return { value: 0, why: "you asked to skip this" };
  return { value: 1, why: "not in your plan yet" };
}

/**
 * Travel friction. Superlinear, because a 40-minute journey costs far more of a
 * two-hour window than a 10-minute one costs of a six-hour one.
 */
export function travelFriction(travelMin: number, availableMin: number): number {
  if (availableMin <= 0) return 1;
  const share = travelMin / availableMin;
  return Math.min(1, Math.pow(share, 1.6) * 2);
}

function authenticity(exp: Experience): { value: number; why: string } {
  const keywords = exp.keywords.map((k) => k.toLowerCase());
  const local = keywords.some((k) =>
    ["local", "hidden", "community", "koli", "dharavi", "pali", "gali", "lane", "workshop"].some((m) => k.includes(m)),
  );
  const mainstream = exp.rating.count > 25_000;
  if (local && !mainstream) return { value: 1, why: "a local place, not a landmark" };
  if (mainstream) return { value: 0.35, why: "very popular, which usually means very crowded" };
  return { value: 0.6, why: "locally known" };
}

/**
 * Score one experience. Returns the total plus every named component, so
 * `WhyLedger` can render "why this" without recomputing anything.
 */
export function score(
  ctx: DiscoveryContext,
  exp: Experience,
  profile: WeightProfile = DEFAULT_PROFILE,
  opts: { travelMin?: number } = {},
): ScoreBreakdown {
  const travelMin = opts.travelMin ?? 0;
  const w = { ...DEFAULT_PROFILE.weights, ...profile.weights };
  const components: ScoreComponent[] = [];
  const learned: string[] = [];

  const add = (key: string, label: string, raw: number, weight: number, why?: string) => {
    if (weight === 0) return;
    const value = raw * weight;
    components.push({ key, label, value, weight, reason: why });
    if (profile.source === "learned" && LEARNABLE.has(key)) learned.push(key);
  };

  const im = interestMatch(ctx, exp);
  add("interestMatch", "Matches what you asked for", im.value, w.interestMatch ?? 0, im.why);

  const rating = ratingLowerBound(exp.rating.rawMean ?? 0, exp.rating.count) / 5;
  add(
    "rating",
    "Well reviewed",
    rating,
    w.rating ?? 0,
    exp.rating.count > 0
      ? `${shrinkRating(exp.rating.rawMean, exp.rating.count).toFixed(1)} from ${exp.rating.count} reviews`
      : "no reviews yet",
  );

  const vfm = valueForMoney(exp, ctx.partySize);
  add("valueForMoney", "Worth the money", vfm.value, w.valueForMoney ?? 0, vfm.why);

  const auth = authenticity(exp);
  add("authenticity", "Genuinely local", auth.value, w.authenticity ?? 0, auth.why);

  const wf = weatherFit(ctx, exp);
  add("weatherFit", "Works in this weather", wf.value, w.weatherFit ?? 0, wf.why);

  const crowd = crowdPenalty(ctx, exp);
  add("crowdPenalty", "Not going to be packed", crowd.value, w.crowdPenalty ?? 0, crowd.why);

  const gf = groupFit(ctx, exp);
  add("groupFit", "Right for your group", gf.value, w.groupFit ?? 0, gf.why);

  const nov = novelty(ctx, exp);
  add("novelty", "Something new", nov.value, w.novelty ?? 0, nov.why);

  const friction = travelFriction(travelMin, ctx.availableMin);
  add(
    "travelFriction",
    "Close enough to reach",
    1 - friction,
    w.travelFriction ?? 0,
    travelMin > 0 ? `${travelMin} min away` : "at your location",
  );

  const conf = dataConfidence(exp);
  add(
    "dataConfidence",
    "Information is verified",
    conf,
    w.dataConfidence ?? 0,
    conf < 0.5 ? "some details are AI-inferred" : "details are verified",
  );

  const total = components.reduce((sum, c) => sum + c.value, 0);
  components.sort((a, b) => b.value - a.value);

  return {
    experienceId: exp.id,
    total: Math.round(total * 1000) / 1000,
    components,
    profileVersion: profile.version,
    learnedComponents: learned,
  };
}

/** Rank a set. Deterministic: ties break on id so runs are reproducible. */
export function rank(
  ctx: DiscoveryContext,
  items: readonly Experience[],
  profile: WeightProfile = DEFAULT_PROFILE,
  travelMinFor: (id: string) => number = () => 0,
): Array<{ experience: Experience; score: ScoreBreakdown }> {
  return items
    .map((experience) => ({ experience, score: score(ctx, experience, profile, { travelMin: travelMinFor(experience.id) }) }))
    .sort((a, b) => (b.score.total - a.score.total) || a.experience.id.localeCompare(b.experience.id));
}
