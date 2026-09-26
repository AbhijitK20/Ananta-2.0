/**
 * Retrieval. The first stage, and the only one whose job is RECALL.
 *
 * WHAT THIS IS FOR. Everything downstream is subtraction: `filterFeasible`
 * drops what cannot work, `score` ranks what is left, `packer` chooses. None of
 * them can recover a row this file failed to return. So this stage is
 * deliberately GENEROUS — it prefilters only what is geometrically hopeless,
 * and everything arguable is a BOOST rather than a drop. Precision is the
 * gate's job, not ours.
 *
 * WHY IT IS PURE AND SYNCHRONOUS, AND WHERE TRAVEL ACTUALLY LIVES.
 * The frozen API in TASKS.md is `retrieve(input: RetrieveInput): Experience[]`
 * — synchronous, no I/O, no LLM. That is not a stylistic preference: both
 * consumers (`src/app/_lib/engine.ts`, `src/features/discovery/engine.ts`)
 * declare it synchronous, so an `async retrieve` would break the wiring in two
 * places.
 *
 * But `Candidate.travelMin` needs routing, and BOTH routing providers in
 * `travel.ts` are async by interface (`haversineEstimate` is pure arithmetic
 * wrapped in a Promise, but the facade is async either way). A synchronous
 * function cannot await them. Rather than quietly substitute `travelMin: 0`
 * — which would make the gate believe every venue is next door, the exact
 * silent-wrong-answer failure this codebase exists to avoid — the two concerns
 * are split:
 *
 *   - `retrieve()`      pure, sync,  sensory+lexical+geo narrowing. No travel.
 *   - `buildCandidates()` async, owns travel, ONE cached call per candidate.
 *
 * That split is what `feasibility.ts` is asking for when it says travel time
 * "is computed there and cached, never recomputed per-candidate here, because
 * that would turn a 250-row gate into 250 routing calls".
 *
 * WHY BM25 IS IMPLEMENTED HERE AND NOT IN SQL. The contract hands us the
 * catalogue as an array, so there is no database to query at this stage. The
 * FTS5 table in `migrations.ts` exists for the DB-backed path that supplies
 * that array; this is the same ranking, in memory, with the same intent that a
 * `name` hit outranks a `description` hit. Column weights below mirror the
 * `experience_fts` column order.
 *
 * NOT DONE HERE, ON PURPOSE. `excludedIds` and `pinnedIds` are left in the
 * candidate set. The gate owns those rejections and emits a `Rejection` with a
 * sentence for each; dropping them here would be cheaper and would also make
 * those rejections unreachable, so the user would silently stop being told why
 * a place they rejected is not in their plan.
 */
import type { DiscoveryContext, Experience, GeoPoint, RetrieveInput } from "@/contracts";
import type { Candidate } from "./feasibility";
import { haversineMetres } from "./geo";
import { travelBetween } from "./travel";

// ---------------------------------------------------------------------------
// Tunables. Named, exported, and documented so a test can reason about them
// rather than hardcoding a magic number.
// ---------------------------------------------------------------------------

/** BM25 term-frequency saturation. Standard. */
export const BM25_K1 = 1.2;
/** BM25 length normalisation. Standard. */
export const BM25_B = 0.75;

/** Never return more than this when the caller does not say. */
export const DEFAULT_LIMIT = 120;

/**
 * Field weights. A `name` hit is worth ~6.7x a `description` hit, which is the
 * same ordering the FTS5 index implies by listing `name` first.
 */
export const FIELD_WEIGHTS = {
  name: 4,
  keywords: 3,
  category: 2.5,
  cuisines: 2,
  perception: 1.5,
  blurb: 1.5,
  diets: 1.2,
  description: 0.6,
} as const;

/** Score mixing. Text dominates; distance breaks ties between similar text. */
const TEXT_WEIGHT = 1;
const GEO_WEIGHT = 0.6;

/** Facet nudges. Boosts, never filters — see the module note on recall. */
const INTEREST_BOOST = 0.5;
const DIET_BOOST = 0.4;
const AVOID_PENALTY = 1.5;
/** More than this many matched interests stops adding signal. */
const MAX_INTEREST_BOOSTS = 3;

/**
 * Metres per minute, used ONLY to derive a generous prefilter radius. These are
 * straight-line speeds; the real check is `travel_time_exceeds_budget` in the
 * gate, which uses routed minutes. Being wrong here costs recall, not
 * correctness, which is why the pad is large.
 */
const MODE_SPEED_M_PER_MIN = { walk: 80, auto: 420, transit: 260 } as const;
/** Network distance is longer than straight line, and traffic is not free. */
const REACH_PAD = 2;

const STOPWORDS = new Set([
  "a", "an", "and", "the", "to", "of", "in", "on", "at", "for", "with", "is",
  "it", "this", "that", "we", "i", "me", "my", "some", "any", "want", "like",
  "near", "around", "go", "get", "can", "please", "show", "find", "looking",
  "where", "what", "good", "best", "place", "places",
]);

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Lowercase, split on anything that is not a letter, mark, or digit, drop
 * stopwords and single characters.
 *
 * `\p{M}` IS NOT OPTIONAL. Devanagari vowel signs are Unicode Marks, not
 * Letters, so a `[^\p{L}\p{N}]` splitter shreds "सिद्धिविनायक" at every matra
 * and leaves "यक" — search silently fails for exactly the names a Mumbai
 * traveller is most likely to type in the local script. The same applies to
 * the Arabic and Tamil marks in other transliterations.
 */
export function tokenise(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

interface Doc {
  exp: Experience;
  /** Weighted term frequency, summed across fields. */
  tf: Map<string, number>;
  /** Weighted token count, for BM25 length normalisation. */
  len: number;
  /** Lowercased diet/cuisine tags, for facet comparison. */
  tags: Set<string>;
}

function fieldsOf(e: Experience): [string, number][] {
  return [
    [e.name, FIELD_WEIGHTS.name],
    [e.keywords.join(" "), FIELD_WEIGHTS.keywords],
    [e.category.replace(/_/g, " "), FIELD_WEIGHTS.category],
    [e.cuisines.join(" "), FIELD_WEIGHTS.cuisines],
    [
      [...e.perception.landscape, ...e.perception.activities, ...e.perception.atmosphere].join(" "),
      FIELD_WEIGHTS.perception,
    ],
    [e.blurb ?? "", FIELD_WEIGHTS.blurb],
    [e.diets.join(" "), FIELD_WEIGHTS.diets],
    [e.description ?? "", FIELD_WEIGHTS.description],
  ];
}

function buildDoc(e: Experience): Doc {
  const tf = new Map<string, number>();
  let len = 0;
  for (const [text, weight] of fieldsOf(e)) {
    for (const token of tokenise(text)) {
      tf.set(token, (tf.get(token) ?? 0) + weight);
      len += weight;
    }
  }
  const tags = new Set<string>();
  for (const tag of [...e.diets, ...e.cuisines]) tags.add(tag.toLowerCase().trim());
  return { exp: e, tf, len, tags };
}

/**
 * Positive query terms, from every place the traveller expressed what they
 * want: typed interests, the positive half of each decomposed request, and
 * their dietary constraints.
 */
export function positiveTerms(ctx: DiscoveryContext): string[] {
  const terms: string[] = [];
  for (const interest of ctx.interests) terms.push(...tokenise(interest));
  for (const request of ctx.requests) terms.push(...tokenise(request.pos));
  return terms;
}

/**
 * Negative terms. `avoid` ("avoid crowded", "must be quiet") and the `neg` half
 * of a request. These subtract; they never drop, because "avoid crowded" is a
 * preference and the gate is where preferences become hard constraints.
 */
export function negativeTerms(ctx: DiscoveryContext): string[] {
  const terms: string[] = [];
  for (const avoid of ctx.avoid) terms.push(...tokenise(avoid));
  for (const request of ctx.requests) {
    if (request.neg !== null) terms.push(...tokenise(request.neg));
  }
  return terms;
}

// ---------------------------------------------------------------------------
// Geo prefilter
// ---------------------------------------------------------------------------

/**
 * A deliberately over-generous straight-line radius derived from the time
 * budget. With `availableMin: 180` and `auto` this is ~250 km, i.e. no filter
 * at all in Mumbai — which is correct. The gate decides reachability with real
 * routed minutes; this only removes the absurd.
 *
 * Returns null when there is no resolved origin, because then there is nothing
 * to measure from and dropping rows would be a guess.
 */
export function reachMetres(ctx: DiscoveryContext): number | null {
  if (ctx.origin.point === null) return null;
  const mode = ctx.travelMode === "any" ? "auto" : ctx.travelMode;
  const speed = MODE_SPEED_M_PER_MIN[mode];
  return ctx.availableMin * speed * REACH_PAD;
}

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

/**
 * Narrow the catalogue to the rows worth gating. Pure; same input, same output,
 * every time.
 *
 * Order of operations, cheapest first:
 *   1. geo prefilter      — a metres comparison, drops only the absurd
 *   2. BM25 text score    — lexical relevance against interests/requests
 *   3. geo proximity      — short-range tie-break
 *   4. facet nudges       — interests and diets boost, avoids subtract
 *   5. deterministic sort — score desc, then id asc, so ties never flake
 */
export function retrieve(input: RetrieveInput): Experience[] {
  const { context, catalogue } = input;
  const limit = input.limit ?? DEFAULT_LIMIT;

  const origin: GeoPoint | null = context.origin.point;
  const reach = reachMetres(context);
  const positives = positiveTerms(context);
  const negatives = negativeTerms(context);

  const docs: Doc[] = [];
  for (const exp of catalogue) {
    if (reach !== null && origin !== null) {
      if (haversineMetres(origin, exp.location) > reach) continue;
    }
    docs.push(buildDoc(exp));
  }
  if (docs.length === 0) return [];

  const n = docs.length;
  const avgLen = docs.reduce((sum, d) => sum + d.len, 0) / n;

  // Document frequency across the surviving set, so IDF reflects THIS corpus.
  const df = new Map<string, number>();
  for (const term of new Set(positives)) {
    let count = 0;
    for (const doc of docs) if (doc.tf.has(term)) count++;
    df.set(term, count);
  }

  const scored = docs.map((doc) => {
    const text = bm25(doc, positives, df, n, avgLen);
    const proximity = origin === null ? 0 : proximityOf(origin, doc.exp.location);
    const facet = facetBoost(context, doc);
    const penalty = avoidPenalty(negatives, doc);
    return { exp: doc.exp, score: TEXT_WEIGHT * text + GEO_WEIGHT * proximity + facet - penalty };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tie-break. Without it, equal-scoring rows arrive in
    // catalogue order, which changes when the file is re-seeded and would make
    // a plan silently reshuffle between identical runs.
    return a.exp.id < b.exp.id ? -1 : a.exp.id > b.exp.id ? 1 : 0;
  });

  return scored.slice(0, limit).map((s) => s.exp);
}

function bm25(
  doc: Doc,
  terms: readonly string[],
  df: ReadonlyMap<string, number>,
  n: number,
  avgLen: number,
): number {
  if (terms.length === 0) return 0;
  let score = 0;
  for (const term of terms) {
    const tf = doc.tf.get(term);
    if (tf === undefined) continue;
    const docsWithTerm = df.get(term) ?? 1;
    const idf = Math.log(1 + (n - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
    const norm = 1 - BM25_B + (BM25_B * doc.len) / (avgLen === 0 ? 1 : avgLen);
    score += (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm);
  }
  return score;
}

/** 1 at the origin, 0.5 at 1 km, 0.25 at 3 km. Bounded, so it never dominates. */
function proximityOf(origin: GeoPoint, target: GeoPoint): number {
  return 1 / (1 + haversineMetres(origin, target) / 1000);
}

function facetBoost(ctx: DiscoveryContext, doc: Doc): number {
  let boost = 0;

  let matched = 0;
  for (const term of new Set(positiveTerms(ctx))) {
    if (matched >= MAX_INTEREST_BOOSTS) break;
    if (doc.tf.has(term)) {
      boost += INTEREST_BOOST;
      matched++;
    }
  }

  // Only boost a diet the venue actually declares. A venue with no dietary tags
  // is not a mismatch, it is an unknown, and unknowns are the gate's business.
  for (const diet of ctx.diets) {
    if (doc.tags.has(diet.toLowerCase().trim())) {
      boost += DIET_BOOST;
      break;
    }
  }

  return boost;
}

function avoidPenalty(negatives: readonly string[], doc: Doc): number {
  let penalty = 0;
  for (const term of new Set(negatives)) {
    if (doc.tf.has(term)) penalty += AVOID_PENALTY;
  }
  return penalty;
}

// ---------------------------------------------------------------------------
// Candidate assembly — where travel actually happens
// ---------------------------------------------------------------------------

export interface BuildCandidateOptions {
  /** Off for the offline demo path: skip live routing, use the estimate. */
  allowNetwork?: boolean;
  /** Forwarded to the congestion model. Defaults to false. */
  isSunday?: boolean;
}

/**
 * Attach the travel facts the gate needs. One routing call per candidate, and
 * the facade in `travel.ts` caches by (from, to, mode, 30-min bucket) so a
 * replan a few minutes later reuses them.
 *
 * THROWS when `origin.point` is null. Substituting zero would tell the gate
 * every venue is adjacent and produce a confident, wrong plan — the failure
 * mode this codebase is built to avoid. Resolve the origin first (the UI's
 * geolocation or a resolved free-text label); `retrieve` tolerates a null
 * origin because it makes no factual claim, but this function does.
 */
export async function buildCandidates(
  ctx: DiscoveryContext,
  items: readonly Experience[],
  opts: BuildCandidateOptions = {},
): Promise<Candidate[]> {
  const origin = ctx.origin.point;
  if (origin === null) {
    throw new Error(
      "buildCandidates: ctx.origin.point is null. Travel time cannot be computed " +
        `from the label "${ctx.origin.label}" alone, and assuming zero would make the ` +
        "feasibility gate believe every venue is adjacent. Resolve the origin first.",
    );
  }

  const out: Candidate[] = [];
  for (const exp of items) {
    const result = await travelBetween(origin, exp.location, {
      atMin: ctx.nowMin,
      mode: ctx.travelMode === "any" ? "auto" : ctx.travelMode,
      ...(opts.isSunday === undefined ? {} : { isSunday: opts.isSunday }),
      ...(opts.allowNetwork === undefined ? {} : { allowNetwork: opts.allowNetwork }),
    });
    out.push({
      experience: exp,
      // Already an integer and already rounded UP by the facade in `travel.ts`;
      // this does not re-round. The gate compares against integer budgets, so a
      // rounded-down leg is the difference between a plan that fits and a
      // traveller who arrives late.
      travelMin: result.minutes,
      distanceM: result.metres,
    });
  }
  return out;
}
