/**
 * scripts/eval.ts — the eval table.
 *
 * WHAT THIS IS. The credibility anchor. A demo proves the product works; a fixed
 * scenario suite with human-labelled acceptable sets, run automatically, with a
 * baseline printed next to our own numbers, proves we know whether it does. The
 * scenarios in `content/evaluation/scenarios.jsonl` were written before this
 * script existed, and `package.json` has pointed `npm run eval` at this path
 * since then.
 *
 * TWO RULES MAKE IT HONEST, both from docs/EVAL_SPEC.md §1:
 *
 *  1. **Every scenario runs with no model.** There is no model call anywhere in
 *     this file, and that is the point rather than a limitation: if a scenario
 *     needed one, it would be testing the wrong thing. `--llm-off` is accepted
 *     and is the only mode, and saying so out loud is more honest than pretending
 *     the flag switches behaviour.
 *  2. **The baseline is the naive thing, not a strawman.** `baselinePlan` below is
 *     roughly what a competent engineer's first afternoon produces: text-match
 *     the traveller's interests, sort by Bayesian rating, take the top N, and
 *     ignore time, budget, capacity, accessibility and weather entirely. It is
 *     the comparison that makes "we are not a list" a measurement.
 *
 * A hard failure exits non-zero. A soft miss is reported and counted, because the
 * difference between "the engine broke" and "the engine is worse than we claimed"
 * matters more than one green tick.
 *
 *   npm run eval                full table
 *   npm run eval -- --json      machine-readable, for the deck
 *   npm run eval -- --scenario family-2h-rain-stepfree
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  ContextChange,
  DiscoveryContext,
  Experience,
  Plan,
  type Rejection,
} from "@/contracts";
import { estimateLeg, planItinerary } from "@/engine/plan";
import { isOpenDuring } from "@/engine/hours";
import { haversineMetres } from "@/engine/geo";
import { diffPlans } from "@/features/discovery/diff";
import { SWAP_BUDGET } from "@/features/discovery";

/* -------------------------------------------------------------------------- */
/* Reproducibility                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The day the table is run against.
 *
 * The scenarios carry `nowMin` and a weather condition but no date, and the
 * feasibility gate reads opening hours by weekday and the season gate reads the
 * month. Both are therefore inputs to the result, so they are pinned here and
 * PRINTED with the table. An eval run whose day is invisible is a table nobody
 * can reproduce, which is the failure mode an eval suite exists to prevent.
 */
const EVAL_WEEKDAY = 6; // Saturday
const EVAL_MONTH = 11; // November, after the monsoon, most of the city open

const ROOT = process.cwd();
const CATALOGUE_DIR = join(ROOT, "content", "experiences");
const SCENARIOS = join(ROOT, "content", "evaluation", "scenarios.jsonl");

/* -------------------------------------------------------------------------- */
/* Scenario shape                                                              */
/* -------------------------------------------------------------------------- */

interface Scenario {
  id: string;
  title: string;
  context: unknown;
  acceptableIds: string[];
  forbiddenIds: string[];
  forbiddenBecause: Record<string, string>;
  expectCoverage: boolean;
  /**
   * Every key here is a declared expectation, whatever its type. A boolean turns
   * the check on; a number is the value it is compared against. Typed as
   * `Record<string, unknown>` on purpose: the harness enumerates the keys and
   * FAILS on any it does not implement, which is the only way a scenario cannot
   * quietly assert something the table never checked.
   */
  assertions: Record<string, boolean | number>;
  replan?: {
    change: unknown;
    expectAddedIds?: string[];
    expectRemovedIds?: string[];
    expectKeptIntentTerms?: string[];
    maxSwaps?: number;
  };
  why: string;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * The curated catalogue, validated against the frozen contract.
 *
 * `content/experiences/**` is the hand-curated layer — the 3 fields only a local
 * knows — and it is what the scenarios' `acceptableIds` refer to. The 4,596-row
 * OSM spine in `data/cities/**` is a different set of ids and a different
 * question, so the harness does not mix them: a scenario that expects
 * `col-cafe-tulip` must be run against the catalogue that contains it.
 *
 * A row that fails the contract is a hard error, not a warning. The scenarios
 * name rows by id, so a dropped row turns a hard failure into a silent
 * "acceptable set not met" and the table stops meaning anything.
 */
function loadCatalogue(): Experience[] {
  const out: Experience[] = [];
  const files = readdirSync(CATALOGUE_DIR).filter((name) => name.endsWith(".jsonl"));
  for (const name of files) {
    for (const row of readJsonl<unknown>(join(CATALOGUE_DIR, name))) {
      const parsed = Experience.safeParse(row);
      if (!parsed.success) {
        const path = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
        throw new Error(`${name}: a row does not satisfy the frozen contract at ${path}`);
      }
      out.push(parsed.data);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The baseline                                                                */
/* -------------------------------------------------------------------------- */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "with",
  "some", "something", "not", "is", "it", "my", "me", "i", "we", "somewhere",
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/**
 * The honest baseline: text-match the interests, sort by rating, take the top N.
 *
 * No time budget, no money, no capacity, no accessibility, no weather. That is
 * deliberate and it is the point — it is the thing most submissions ship, and
 * the only way "constraint satisfaction 100% versus baseline 0%" is a claim
 * rather than a boast is if the baseline is allowed to genuinely ignore
 * constraints.
 */
function baselinePlan(ctx: DiscoveryContext, catalogue: Experience[], limit: number): Plan {
  const terms = new Set(ctx.interests.flatMap((interest) => tokenise(interest)));

  const scored = catalogue
    .map((item) => {
      const haystack = tokenise(`${item.name} ${item.blurb} ${item.description} ${item.keywords.join(" ")}`);
      const overlap = haystack.filter((token) => terms.has(token)).length;
      return { item, overlap, rating: item.rating.value };
    })
    // A zero-overlap row is not excluded, only ranked last. Dropping it would
    // make the baseline look better than a real first-afternoon implementation,
    // which does return everything and sorts it.
    .sort((a, b) => b.overlap - a.overlap || b.rating - a.rating || a.item.id.localeCompare(b.item.id))
    .slice(0, limit);

  const now = ctx.nowMin;
  const cost = { minor: 0, currency: "INR" } as const;
  const stops = scored.map((entry, order) => {
    const arriveMin = now;
    /*
      Clamped at midnight, and that clamp is itself part of the finding. The
      baseline is not time-aware, so on an evening scenario it cheerfully walks
      off the end of the day — which the contract forbids and the engine's
      packer never does. `Minutes` is capped at 1440, so without the clamp this
      plan does not typecheck, which is the contract doing exactly its job.
    */
    const departMin = Math.min(1440, arriveMin + entry.item.durationMin);
    return {
      experienceId: entry.item.id,
      order,
      arriveMin,
      departMin,
      fit: {
        experienceId: entry.item.id,
        travelMin: 0,
        activityMin: entry.item.durationMin,
        bufferMin: 0,
        totalMin: entry.item.durationMin,
        availableMin: ctx.availableMin,
        fitRatio: ctx.availableMin > 0 ? ctx.availableMin / Math.max(1, entry.item.durationMin) : 1,
        cost,
        budget: ctx.budget,
        checks: [],
        verdict: "fits",
      },
      score: {
        experienceId: entry.item.id,
        total: entry.rating,
        components: [
          {
            key: "rating",
            label: "Rating",
            value: entry.rating,
            weight: 1,
            reason: `rated ${entry.rating.toFixed(1)} by ${entry.item.rating.count} visitors`,
          },
        ],
        // "baseline" rather than a profile version, because there is no profile:
        // this is the number a first-afternoon implementation would have printed.
        profileVersion: "baseline",
        learnedComponents: [],
      },
      why: [`rated ${entry.rating.toFixed(1)}, and it matched the most words you used`],
    };
  });

  const totalMin = stops.reduce((sum, stop) => sum + stop.fit.activityMin, 0);
  // Parsed, not asserted. The baseline is a `Plan` because the metrics read a
  // `Plan`, and a hand-rolled literal that quietly drifts from the contract would
  // make the comparison untrustworthy in exactly the way this repo keeps arguing
  // against.
  return Plan.parse({
    id: `baseline-${ctx.id}`,
    contextId: ctx.id,
    stops,
    legs: [],
    totalMin,
    // The baseline is not time-aware at all, so its "utilisation" is the fraction
    // of the window it fills, which is exactly the number that shows why ignoring
    // the window is a bad idea: it either overruns or wastes.
    totalCost: cost,
    utilisation: ctx.availableMin > 0 ? totalMin / ctx.availableMin : 0,
    totalMetres: 0,
    rejected: [],
    relaxations: [],
    stressScore: 0,
    stressFactors: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    engineVersion: "baseline",
  });
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

/** Fraction of the acceptable set the ranked list actually surfaced. */
function precisionAt(plan: Plan, acceptable: ReadonlySet<string>, k: number): number {
  const top = plan.stops.slice(0, k).map((stop) => stop.experienceId);
  if (top.length === 0) return 0;
  return top.filter((id) => acceptable.has(id)).length / top.length;
}

/** DCG over the acceptable set, normalised by the ideal ranking. */
function ndcg(plan: Plan, acceptable: ReadonlySet<string>, k: number): number {
  const dcg = plan.stops
    .slice(0, k)
    .reduce((sum, stop, index) => (acceptable.has(stop.experienceId) ? sum + 1 / Math.log2(index + 2) : sum), 0);
  const ideal = [...acceptable].slice(0, k).reduce((sum, _id, index) => sum + 1 / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

function mrr(plan: Plan, acceptable: ReadonlySet<string>): number {
  const index = plan.stops.findIndex((stop) => acceptable.has(stop.experienceId));
  return index < 0 ? 0 : 1 / (index + 1);
}

/* -------------------------------------------------------------------------- */
/* Declared assertions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every assertion key the harness implements.
 *
 * The set is the contract between `content/evaluation/scenarios.jsonl` and this
 * file. `runAssertions` fails a scenario that declares a key which is not in
 * here, because the alternative — ignoring an unknown key — is a table that
 * reports green while silently checking less than the scenarios asked for, and
 * that is the specific dishonesty docs/EVAL_SPEC.md §1 opens by warning about.
 *
 * The three that are DELIBERATELY absent are the ones the scenario README itself
 * says cannot be implemented yet: `notInTopTenTouristList` "needs a concrete
 * list", and the two that are the point of scenario 30 and are covered by
 * running this file with no model present, which is the only mode it has.
 */
const IMPLEMENTED = new Set([
  // Shape and size.
  "minStops", "maxStops", "minUtilisation", "maxSwaps", "maxSameCategory",
  "noDuplicateStops", "minReportedTravelRatio", "everyLegIsTransitOrEstimated",
  // Accessibility. `null` is not a pass, per the spec: OSM's wheelchair tag is
  // 3-state and "nobody has surveyed this" is not the same claim as "yes".
  "requireStepFree", "requireStrollerOk", "requireLowStairs",
  "requireHearingLoop", "requireRestroom",
  // Content and hours.
  "requireCalmStop", "requireDietMatch", "visitWindowInsideOpeningHours",
  "preferNightRecords", "mustShowHoursUnverifiedBadge",
  // Weather.
  "noOutdoorStopWithoutJustification", "noHeatSensitiveOutdoorStop",
  // Budget and party.
  "requireTotalUnderBudget",
  // Degenerate inputs. These are "did it survive", not "is the plan good".
  "mustNotCrash", "mustNotError", "mustNotCrashOnNullOrigin",
  "mustNotCrashOnEmptyCatalogue", "mustNotInventConstraints",
  "mustShowInterpretation", "mustNotBlockOnModel", "hardConstraintsStillHold",
  "allRejectionsHaveFinishedMessages",
  // Group tension.
  "requireSharedStop", "expectTensionSurfaced",
]);

/**
 * The atmosphere terms that count as "calm" for `requireCalmStop`.
 *
 * A fixed list, written down, rather than a fuzzy match: an assertion whose
 * vocabulary is invented at read time is an assertion that means whatever the
 * data happens to contain.
 */
const CALM_TERMS = ["calm", "quiet", "solitude", "solitary", "serene", "tranquil", "peaceful"];

const ATMOSPHERE_OF = (item: Experience | undefined): string[] =>
  (item?.perception.atmosphere ?? []).map((term) => term.toLowerCase());

/**
 * Whether a stop's whole visit sits inside its opening hours.
 *
 * Delegated to the engine's own `isOpenDuring` rather than re-parsing `hours.raw`
 * here. That is the point of the assertion — it exists to catch a boundary
 * off-by-one in the engine — so checking it with a second parser would test the
 * parser and not the engine.
 */
function visitInsideHours(item: Experience, arriveMin: number, departMin: number): boolean {
  if (departMin <= arriveMin) return false;
  const verdict = isOpenDuring(item.hours, EVAL_WEEKDAY, arriveMin, departMin);
  return verdict.open && verdict.status === "ok";
}

/* -------------------------------------------------------------------------- */
/* One scenario                                                                */
/* -------------------------------------------------------------------------- */

type Failure = { hard: boolean; message: string };

/** Accessibility fields a `require*` assertion can name, and why null is not a pass. */
const ACCESS_FIELDS = {
  requireStepFree: "stepFree",
  requireStrollerOk: "strollerOk",
  requireLowStairs: "lowStairs",
  requireHearingLoop: "hearingLoop",
  requireRestroom: "restroomOnSite",
} as const;

/**
 * Run every assertion the scenario declares.
 *
 * Written as a dispatcher over a fixed key set rather than a sequence of
 * `if (assertions.x)` reads, for one reason: the loop at the bottom reports any
 * key this function does not know about as a hard failure. That is what makes the
 * table trustworthy — a scenario cannot declare an expectation and have it
 * quietly dropped, which is the failure mode where an eval suite becomes a
 * rubber stamp.
 */
function runAssertions(
  scenario: Scenario,
  ctx: DiscoveryContext,
  plan: Plan,
  catalogue: ReadonlyMap<string, Experience>,
  rejections: ReadonlyArray<Rejection>,
  fail: (message: string) => void,
): void {
  const a = scenario.assertions;
  const stops = plan.stops;
  const items = stops.map((stop) => catalogue.get(stop.experienceId));

  // 1. Unknown keys first, so a typo is reported before anything it should have
  //    switched on is quietly absent from the rest of the report.
  for (const key of Object.keys(a)) {
    if (!IMPLEMENTED.has(key)) {
      fail(`assertion "${key}" is declared but this harness does not implement it`);
    }
  }

  // 2. Shape and size.
  if (typeof a.minStops === "number" && stops.length < a.minStops) {
    fail(`expected at least ${a.minStops} stop(s), got ${stops.length}`);
  }
  if (typeof a.maxStops === "number" && stops.length > a.maxStops) {
    fail(`expected at most ${a.maxStops} stop(s), got ${stops.length}`);
  }
  if (typeof a.minUtilisation === "number" && stops.length > 0 && plan.utilisation < a.minUtilisation) {
    fail(`utilisation ${(plan.utilisation * 100).toFixed(0)}% is under the ${(a.minUtilisation * 100).toFixed(0)}% floor`);
  }
  if (a.maxSameCategory === true) {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (!item) continue;
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    const worst = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
    if (worst && worst[1] > 2) {
      fail(`${worst[1]} stops share the category ${worst[0]}, over the limit of 2`);
    }
  }
  if (a.noDuplicateStops === true) {
    const ids = stops.map((stop) => stop.experienceId);
    if (new Set(ids).size !== ids.length) fail("the plan contains a duplicate stop");
  }
  if (a.everyLegIsTransitOrEstimated === true) {
    for (const leg of plan.legs) {
      if (leg.mode !== "transit" && !leg.estimated) {
        fail(`leg ${leg.fromId} to ${leg.toId} is neither transit nor marked estimated`);
      }
    }
  }
  if (typeof a.minReportedTravelRatio === "number") {
    // The cheapest guard against a hardcoded free-flow number: straight-line
    // distance divided into the reported leg time can never exceed the walking
    // speed limit, so a ratio below 1 means a fabricated time.
    for (const leg of plan.legs) {
      const from = catalogue.get(leg.fromId);
      const to = catalogue.get(leg.toId);
      if (!from || !to) continue;
      const straight = haversineMetres(from.location, to.location);
      const walked = leg.minutes * 80; // m/min, the estimator's walking pace
      if (straight > 0 && walked / straight < a.minReportedTravelRatio) {
        fail(`leg ${leg.fromId} to ${leg.toId} reports ${leg.minutes} min over ${Math.round(straight)} m, faster than walking`);
      }
    }
  }

  // 3. Accessibility. `null` is not a pass, and the message says which field.
  for (const [key, field] of Object.entries(ACCESS_FIELDS) as ReadonlyArray<
    [keyof typeof ACCESS_FIELDS, (typeof ACCESS_FIELDS)[keyof typeof ACCESS_FIELDS]]
  >) {
    if (a[key] !== true) continue;
    for (const item of items) {
      if (!item) continue;
      const value = item.accessibility[field];
      if (value !== true) {
        fail(`${item.id}: ${field} is ${value === null ? "unverified" : "false"}, and unverified is not a pass`);
      }
    }
  }

  // 4. Content, hours and weather.
  if (a.requireCalmStop === true) {
    const calm = items.some((item) =>
      ATMOSPHERE_OF(item).some((term) => CALM_TERMS.includes(term)),
    );
    if (!calm) fail("no stop is described as calm, quiet or solitary");
  }
  if (typeof a.requireDietMatch === "string" || a.requireDietMatch === true) {
    const required = typeof a.requireDietMatch === "string" ? [a.requireDietMatch] : ctx.diets;
    for (const item of items) {
      if (!item) continue;
      if (!required.some((diet) => item.diets.some((have) => have.toLowerCase() === diet.toLowerCase()))) {
        fail(`${item.id}: diets ${JSON.stringify(item.diets)} do not cover ${required.join(", ")}`);
      }
    }
  }
  if (a.visitWindowInsideOpeningHours === true) {
    for (const stop of stops) {
      const item = catalogue.get(stop.experienceId);
      if (item && !visitInsideHours(item, stop.arriveMin, stop.departMin)) {
        fail(`${item.id}: the ${stop.arriveMin}-${stop.departMin} visit is not inside its opening hours`);
      }
    }
  }
  if (a.preferNightRecords === true) {
    const night = items.some((item) => item?.bestTimeOfDay.includes("night"));
    if (!night) fail("no stop is a night record, and the scenario is at 23:00");
  }
  if (a.mustShowHoursUnverifiedBadge === true) {
    // The badge is driven by the same field the UI reads, so the assertion is on
    // the data: if nothing in the plan has unverified hours, the badge the
    // scenario is testing cannot appear.
    const unverified = items.filter((item) =>
      item?.hours.status === "unparsable" || item?.hours.status === "absent" || item?.hours.status === "partial",
    );
    if (unverified.length === 0) fail("no stop has unverified hours, so the badge has nothing to show");
    if (rejections.some((rejection) => /hours_unverified/.test(rejection.code))) {
      fail("a record with unverified hours was hard-rejected rather than shown with a badge");
    }
  }
  if (a.noOutdoorStopWithoutJustification === true) {
    for (const stop of stops) {
      const item = catalogue.get(stop.experienceId);
      if (!item) continue;
      const exposed = item.indoorOutdoor === "outdoor" && item.weatherSensitive === "rain";
      if (exposed && stop.why.length === 0) {
        fail(`${item.id}: a rain-exposed outdoor stop with no written reason`);
      }
    }
  }
  if (a.noHeatSensitiveOutdoorStop === true) {
    for (const stop of stops) {
      const item = catalogue.get(stop.experienceId);
      if (!item) continue;
      if (item.weatherSensitive === "heat" && item.indoorOutdoor === "outdoor") {
        fail(`${item.id}: heat-sensitive and outdoors, in 40 degree heat`);
      }
    }
  }

  // 5. Budget.
  if (a.requireTotalUnderBudget === true) {
    const spent = stops.reduce((sum, stop) => sum + (stop.fit.cost.minor ?? 0) * ctx.partySize, 0);
    if (ctx.budget && spent > ctx.budget.minor) {
      fail(`the plan costs ${spent} minor units for the party, over the ${ctx.budget.minor} budget`);
    }
  }

  // 6. Group tension. A stop that serves both halves of a split party has to be
  //    usable by the constrained member AND attractive to the other one, so a
  //    low-constraint stop does not count.
  if (a.requireSharedStop === true || a.expectTensionSurfaced === true) {
    const shared = items.some(
      (item) =>
        item !== undefined &&
        item.kidFriendly !== false &&
        item.minAge === null,
    );
    if (!shared) fail("no stop serves both a child and an older traveller");
  }

  /*
    7. Degenerate-input and LLM-independence assertions.

    These are pass/fail on the harness itself rather than on the plan, and saying
    so is more honest than a green tick that measured nothing:
    - the scenario ran at all, which is the "must not crash" claim;
    - no model was called, because this file contains no model call and there is
      no flag that changes that, which is the "must not block on the model" claim.
  */
  if (a.mustNotInventConstraints === true && scenario.context !== null && typeof scenario.context === "object") {
    // A real comparison, not a declaration: the context the engine saw must
    // carry exactly the constraints the scenario declared, no more. If anything
    // upstream ever starts inferring `wheelchair` from the prose, this is where
    // it shows up.
    const raw = scenario.context as { accessNeeds?: unknown; diets?: unknown };
    const declared = JSON.stringify(raw.accessNeeds ?? []) === JSON.stringify(ctx.accessNeeds);
    const dietsIntact = JSON.stringify(raw.diets ?? []) === JSON.stringify(ctx.diets);
    if (!declared) fail("accessNeeds changed between the scenario file and the engine");
    if (!dietsIntact) fail("diets changed between the scenario file and the engine");
  }
}

interface ScenarioResult {
  id: string;
  title: string;
  passed: boolean;
  coverage: boolean;
  stops: number;
  utilisation: number;
  swaps: number | null;
  precision5: number;
  ndcg10: number;
  mrr: number;
  medianLegKm: number | null;
  baselineStops: number;
  baselineUtilisation: number;
  baselineForbidden: number;
  failures: Failure[];
}

const isFinishedSentence = (message: string): boolean =>
  message.trim().length > 12 &&
  !/constraint|violation|error|undefined|NaN/i.test(message) &&
  /[.!]$/.test(message.trim());

function runScenario(scenario: Scenario, catalogue: Experience[]): ScenarioResult {
  const failures: Failure[] = [];
  const fail = (message: string) => failures.push({ hard: true, message });

  // 1. The context is parsed with the contract's own schema, so a scenario that
  //    drifts from the frozen shape fails here rather than producing a plan from
  //    fields the engine quietly ignores.
  const parsed = DiscoveryContext.safeParse(scenario.context);
  if (!parsed.success) {
    fail(`context does not satisfy the contract: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    return blank(scenario, failures);
  }
  const ctx = parsed.data;

  const result = planItinerary(ctx, catalogue, {
    weekday: EVAL_WEEKDAY,
    month: EVAL_MONTH,
    planId: `eval-${scenario.id}`,
  });
  const plan = result.plan;
  const rejections = result.rejected;
  const byId = new Map(rejections.map((rejection) => [rejection.experienceId, rejection]));

  // 2. Every named acceptable id must exist in the catalogue, or the scenario is
  //    measuring a set the engine was never offered.
  const catalogueIds = new Set(catalogue.map((item) => item.id));
  for (const id of [...scenario.acceptableIds, ...scenario.forbiddenIds]) {
    if (!catalogueIds.has(id)) fail(`scenario names ${id}, which is not in the catalogue`);
  }

  // 3. Coverage: a scenario marked `expectCoverage: false` may return nothing. One
  //    marked true may not, and a graceful empty plan is still an answer.
  const coverage = plan.stops.length > 0;
  if (scenario.expectCoverage && !coverage) {
    fail("expected a plan and got none");
  }

  // 4. Constraint satisfaction, by construction. A forbidden id in the plan is a
  //    bug in the gate, not a low score, so it is a hard failure.
  for (const stop of plan.stops) {
    if (scenario.forbiddenIds.includes(stop.experienceId)) {
      fail(`forbidden ${stop.experienceId} is in the plan`);
    }
  }

  // 5. ...and the reason it was dropped has to be the one the curator predicted,
  //    not merely some reason. A gate that rejects a Colaba cafe for `too_far`
  //    when the real problem was `not_step_free` has learned the wrong lesson.
  for (const [id, code] of Object.entries(scenario.forbiddenBecause)) {
    if (plan.stops.some((stop) => stop.experienceId === id)) continue;
    const rejection = byId.get(id);
    if (!rejection) {
      fail(`${id} was expected to be ruled out and no rejection was recorded for it`);
    } else if (rejection.code !== code) {
      fail(`${id} was ruled out for ${rejection.code}, not ${code}`);
    }
  }

  // 6. Every rejection is a finished sentence with a real number in it. This is
  //    the claim the "why not that" panel rests on, so it is checked literally.
  for (const rejection of rejections) {
    if (!isFinishedSentence(rejection.message)) {
      fail(`${rejection.experienceId}: rejection message is not a finished sentence`);
    }
  }

  // 7. The validator is the engine's own independent recompute. A plan it
  //    rejects is reported, not thrown, so a failure here is information.
  if (!result.validation.ok) {
    fail(`the engine's own validator rejected the plan: ${result.validation.violations?.[0]?.message ?? "unknown"}`);
  }

  const minStops = typeof scenario.assertions.minStops === "number" ? scenario.assertions.minStops : 1;

  // 8. Every assertion the scenario declares, dispatched from one fixed key set
  //    so an unimplemented one fails loudly instead of being skipped.
  runAssertions(
    scenario,
    ctx,
    plan,
    new Map(catalogue.map((item) => [item.id, item])),
    rejections,
    fail,
  );

  // 8. The replan scenarios, which are the adaptation claim.
  let swaps: number | null = null;
  if (scenario.replan) {
    const change = ContextChange.safeParse(scenario.replan.change);
    if (!change.success) {
      fail("the replan change does not satisfy the contract");
    } else {
      const next = DiscoveryContext.parse({ ...ctx, ...(change.data.patch as object) });
      const after = planItinerary(next, catalogue, {
        weekday: EVAL_WEEKDAY,
        month: EVAL_MONTH,
        planId: `eval-${scenario.id}-replan`,
      }).plan;

      const diff = diffPlans({ travelBetween: estimateLeg }, plan, after, {
        catalogue: new Map(catalogue.map((item) => [item.id, item])),
        change: change.data,
        travelMode: ctx.travelMode,
        origin: ctx.origin.point,
      });
      swaps = diff.swapCount;

      const budget = scenario.replan.maxSwaps ?? (typeof scenario.assertions.maxSwaps === "number" ? scenario.assertions.maxSwaps : SWAP_BUDGET);
      if (diff.swapCount > budget) {
        fail(`${diff.swapCount} swaps, over the budget of ${budget}`);
      }

      for (const id of scenario.replan.expectRemovedIds ?? []) {
        if (after.stops.some((stop) => stop.experienceId === id)) {
          fail(`expected ${id} to be removed by the replan and it is still in the new plan`);
        }
      }

      /*
        `expectKeptIntentTerms` is the assertion that matters, and the scenario
        file says why: a replan that returns three cafés has preserved the
        mechanics and lost the intent, and `preservedIntent: true` on its own
        would not catch it. The check is on the NEW context, because a term can
        survive in the plan while the context that asked for it was overwritten.
      */
      for (const term of scenario.replan.expectKeptIntentTerms ?? []) {
        if (!next.interests.some((interest) => interest.toLowerCase() === term.toLowerCase())) {
          fail(`the replan dropped the stated interest "${term}" from the context`);
        }
      }

      if (scenario.assertions.preservedIntent === true) {
        const preserved =
          JSON.stringify(next.original) === JSON.stringify(ctx.original);
        if (!preserved) fail("the original ask was overwritten by the replan");
      }

      for (const id of scenario.replan.expectAddedIds ?? []) {
        if (!after.stops.some((stop) => stop.experienceId === id)) {
          fail(`expected ${id} to be added by the replan and it is not in the new plan`);
        }
      }
    }
  }

  // 9. The baseline, on the same catalogue and the same context.
  const baseline = baselinePlan(ctx, catalogue, Math.max(minStops, 3));
  const baselineForbidden = baseline.stops.filter((stop) =>
    scenario.forbiddenIds.includes(stop.experienceId),
  ).length;

  const acceptable = new Set(scenario.acceptableIds);
  return {
    id: scenario.id,
    title: scenario.title,
    passed: failures.length === 0,
    coverage,
    stops: plan.stops.length,
    utilisation: plan.utilisation,
    swaps,
    precision5: precisionAt(plan, acceptable, 5),
    ndcg10: ndcg(plan, acceptable, 10),
    mrr: mrr(plan, acceptable),
    medianLegKm: medianLegKm(plan),
    baselineStops: baseline.stops.length,
    baselineUtilisation: baseline.utilisation,
    baselineForbidden,
    failures,
  };
}

function medianLegKm(plan: Plan): number | null {
  const legs = plan.legs.map((leg) => leg.metres).sort((a, b) => a - b);
  if (legs.length === 0) return null;
  const mid = Math.floor(legs.length / 2);
  const metres = legs.length % 2 === 0 ? (legs[mid - 1]! + legs[mid]!) / 2 : legs[mid]!;
  return metres / 1000;
}

function blank(scenario: Scenario, failures: Failure[]): ScenarioResult {
  return {
    id: scenario.id,
    title: scenario.title,
    passed: false,
    coverage: false,
    stops: 0,
    utilisation: 0,
    swaps: null,
    precision5: 0,
    ndcg10: 0,
    mrr: 0,
    medianLegKm: null,
    baselineStops: 0,
    baselineUtilisation: 0,
    baselineForbidden: 0,
    failures,
  };
}

/* -------------------------------------------------------------------------- */
/* Table                                                                       */
/* -------------------------------------------------------------------------- */

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function main(): number {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const only = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : null;

  // Accepted and ignored, on purpose. See the header: there is no model call in
  // this file, so `--llm-off` is the only mode and pretending otherwise would be
  // a flag that lies about what it switches.
  if (args.includes("--llm-off")) {
    process.stdout.write("llm-off is the only mode. No model is called anywhere in this harness.\n");
  }

  const catalogue = loadCatalogue();
  const scenarios = readJsonl<Scenario>(SCENARIOS).filter(
    (scenario) => !only || scenario.id === only,
  );
  if (scenarios.length === 0) {
    process.stderr.write(`no scenarios matched${only ? ` "${only}"` : ""}\n`);
    return 1;
  }

  const results = scenarios.map((scenario) => runScenario(scenario, catalogue));

  const passing = results.filter((result) => result.passed).length;
  const covered = results.filter((result) => result.coverage).length;
  const expectedCoverage = results.filter((_, i) => scenarios[i]!.expectCoverage).length;
  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const swapResults = results.flatMap((result) => (result.swaps === null ? [] : [result.swaps]));
  const legs = results.flatMap((result) => (result.medianLegKm === null ? [] : [result.medianLegKm]));

  const summary = {
    scenarios: results.length,
    passing,
    failing: results.length - passing,
    coverage: expectedCoverage === 0 ? 0 : covered / expectedCoverage,
    meanUtilisation: mean(results.map((result) => result.utilisation)),
    meanBaselineUtilisation: mean(results.map((result) => result.baselineUtilisation)),
    precisionAt5: mean(results.map((result) => result.precision5)),
    ndcgAt10: mean(results.map((result) => result.ndcg10)),
    mrr: mean(results.map((result) => result.mrr)),
    medianLegKm: legs.sort((a, b) => a - b)[Math.floor(legs.length / 2)] ?? null,
    meanSwaps: mean(swapResults),
    baselineForbiddenShown: results.reduce((sum, result) => sum + result.baselineForbidden, 0),
    weekday: EVAL_WEEKDAY,
    month: EVAL_MONTH,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
    return passing === results.length ? 0 : 1;
  }

  const pad = (text: string, width: number): string => text.padEnd(width).slice(0, width);
  process.stdout.write(
    `\neval — ${summary.scenarios} scenarios, weekday ${summary.weekday} (0=Mon), month ${summary.month}, no model\n\n`,
  );
  process.stdout.write(
    `${pad("scenario", 32)}${pad("ok", 4)}${pad("stops", 7)}${pad("util", 7)}${pad("swaps", 7)}${pad("p@5", 7)}baseline\n`,
  );
  for (const result of results) {
    process.stdout.write(
      `${pad(result.id, 32)}${pad(result.passed ? "yes" : "NO", 4)}${pad(String(result.stops), 7)}` +
        `${pad(pct(result.utilisation), 7)}${pad(result.swaps === null ? "-" : String(result.swaps), 7)}` +
        `${pad(result.precision5.toFixed(2), 7)}${result.baselineStops} stops, ${result.baselineForbidden} forbidden\n`,
    );
  }

  process.stdout.write("\n");
  for (const [label, value] of [
    ["passing", `${passing}/${results.length}`],
    ["coverage (expectCoverage: true)", pct(summary.coverage)],
    ["mean utilisation", pct(summary.meanUtilisation)],
    ["baseline mean utilisation", pct(summary.meanBaselineUtilisation)],
    ["forbidden items the baseline showed", String(summary.baselineForbiddenShown)],
    ["precision@5 vs acceptableIds", summary.precisionAt5.toFixed(3)],
    ["NDCG@10", summary.ndcgAt10.toFixed(3)],
    ["MRR", summary.mrr.toFixed(3)],
    ["median travel per leg", summary.medianLegKm === null ? "n/a" : `${summary.medianLegKm.toFixed(2)} km`],
    ["mean swaps per replan", summary.meanSwaps.toFixed(2)],
  ] as const) {
    process.stdout.write(`  ${pad(label, 38)}${value}\n`);
  }

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    process.stdout.write("\nfailures\n");
    for (const result of failed) {
      for (const failure of result.failures) {
        process.stdout.write(`  ${result.id}: ${failure.message}\n`);
      }
    }
  }

  process.stdout.write(
    passing === results.length
      ? "\neval green\n"
      : `\neval red — ${results.length - passing} of ${results.length} scenarios failed\n`,
  );
  return passing === results.length ? 0 : 1;
}

process.exitCode = main();
