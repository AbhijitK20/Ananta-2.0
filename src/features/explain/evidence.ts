/**
 * Explainability: the engine's decisions, in finished sentences, carrying the
 * numbers that produced them.
 *
 * Four places produce a decision and this file reads all four. It computes
 * nothing:
 *
 *   filterFeasible  ->  FeasibleResult.rejected  ->  Plan.rejected
 *                       one `Rejection` per hard-constraint failure: the code, a
 *                       finished sentence, the shortfall, the unit, and whether
 *                       relaxing would fix it.
 *   computeFit      ->  PlanStop.fit, and the `fits` the caller already holds for
 *                       candidates that never made it into a plan
 *                       the feasibility meter (travel / activity / buffer against
 *                       the window) plus `checks[]`, the engine's own
 *                       per-constraint pass/fail with a detail line for each.
 *   score           ->  PlanStop.score.components, and the `scores` map likewise
 *                       the signed contributions, the weight applied, and
 *                       `profileVersion` so a score stays auditable.
 *   pack            ->  PlanStop.why, Plan.relaxations, Plan.stressFactors
 *                       the ranked ledger lines, what was given up to make the plan
 *                       fit, and the single highest-impact rescue.
 *
 * FOUR OUTCOMES, because "selected" and "rejected" are not the whole truth and
 * the gap is where a traveller stops believing the product:
 *
 *   selected         the packer took it
 *   rejected         the hard gate dropped it, and here is which constraint
 *   considered       it passed every hard constraint, was scored, and the packer
 *                    spent the window on something else. This is the "why this and
 *                    not that" question, and before this existed there was no
 *                    answer for it at all: a scored candidate that is neither a stop
 *                    nor a rejection is invisible in a plan-only ledger.
 *   not_considered   nothing in the data ever looked at it. Said plainly, because
 *                    an empty panel reads as a bug and "we never evaluated it" is
 *                    the truth.
 *
 * The rules that keep this honest:
 *
 *  1. **No id is ever a key.** The only lookup table is keyed by the contract's
 *     `RejectionCode` machine key, which the engine chose for a reason. There is
 *     no "this place is great for you" anywhere, and a renamed or newly seeded
 *     experience gets exactly the same treatment as a famous one.
 *  2. **A figure is printed only when the data holds it.** Every sentence is
 *     composed from a field, and `unsupportedFigures` re-checks the result against
 *     the figures in the plan, the context and everything the caller supplied —
 *     the same mechanism `src/llm/narrate.ts` uses on the model's prose. A
 *     constraint with no number gets the code's sentence with no figure, per
 *     `docs/FEATURES.md` §4's failure behaviour, rather than an invented one.
 *  3. **Polarity is derived, never assumed.** A `ScoreComponent` carries a signed
 *     `value`, so a negative term is a real cost and leads the ledger. A
 *     `PlanStop.why` line is the engine's prose, which this layer cannot sign —
 *     "₹300 over your budget" arrives in the same list as the reasons to go — so
 *     those lines are reported `neutral` rather than dressed up as praise.
 *  4. **A partial fix says it is partial.** When a candidate fails two things and
 *     one of them is relaxable, the action that fixes the other one is labelled
 *     with how many problems it actually clears. "Add ₹900" on its own would be a
 *     lie told by omission.
 *  5. **An explanation is admissible only if it re-derives.** `auditLedger()`
 *     recomputes every explanation from the current data and reports any drift.
 *  6. **Deterministic.** Pure functions, no `Date`, no randomness, no module state
 *     and no locale ordering: every sort ends in an explicit key comparison, so the
 *     same inputs always produce the same sentences in the same order.
 */
import type {
  DiscoveryContext,
  Experience,
  Fit,
  Plan,
  PlanStop,
  Provenance,
  Rejection,
  RejectionCode,
  ScoreBreakdown,
  WeightProfile,
} from "../../contracts";
import { formatMinutes, formatMoney } from "../../llm/format";
import { groundedFigures, unsupportedFigures } from "../../llm/guardrails";

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** Which of the four decision producers a piece of evidence came from. */
export type EvidenceSource = "filter" | "score" | "pack" | "fit";

/**
 * `opposes` leads, so a caveat is read before the praise. `neutral` is the
 * feasibility meter's own arithmetic and the engine's un-signed prose — "12 min to
 * get there" is a fact about the route, not a judgement about the place, and
 * dressing it up as a reason would be inventing a verdict the engine never made.
 */
export type EvidencePolarity = "opposes" | "supports" | "neutral";

/** `Rejection.unit`, plus `points` (a score contribution is unitless) and `none`. */
export type EvidenceUnit = "minutes" | "minor_units" | "people" | "metres" | "points" | "none";

export type Evidence = {
  /** Stable machine key, namespaced by the producer. Never an experience id. */
  key: string;
  /** A finished sentence. Every figure in it exists in the data. */
  claim: string;
  polarity: EvidencePolarity;
  source: EvidenceSource;
  /** The figure the claim rests on, in `unit`. Null when the constraint has none. */
  value: number | null;
  unit: EvidenceUnit;
  /** `ScoreComponent.weight`, for score evidence. */
  weight: number | null;
  /**
   * True when this contribution came from a LEARNED weight rather than a stated
   * preference — `ScoreBreakdown.learnedComponents` says so.
   *
   * The contract is explicit that nothing is learned about a traveller without
   * being shown to them, and a weight that quietly moved a ranking is exactly the
   * thing a traveller would want to interrogate. Marking the line is the difference
   * between "we think this suits you" and "we decided it suits you after watching
   * what you clicked".
   */
  learned: boolean;
  /** `Experience.provenance` for the field the claim rests on, when declared. */
  provenance: Provenance | null;
};

/**
 * A real `DiscoveryContext` mutation, not a suggestion to think about.
 *
 * `scope` is the part that matters. An experience can fail two hard constraints
 * and only one of them may be relaxable, in which case the action that fixes the
 * other clears one problem out of two. Reporting that action as if it fixed
 * everything would be a lie told by omission, so it carries the count.
 */
export type RecoveryAction = {
  id: string;
  /** A finished sentence naming the exact change, its size, and what it clears. */
  label: string;
  /** `all` when every recorded failure is fixed by this patch, else `partial`. */
  scope: "all" | "partial";
  /** How many of the recorded failures this patch clears. */
  clears: number;
  /** Applied verbatim. Keys are the ones `ContextChange.patch` already carries. */
  patch: Record<string, unknown>;
};

export type Outcome = "selected" | "rejected" | "considered" | "not_considered";

export type Explanation = {
  experienceId: string;
  /** From the catalogue, when the caller passed one. Never guessed. */
  name: string | null;
  outcome: Outcome;
  /** One sentence: why this, or why not that. */
  headline: string;
  /** Ranked. An `opposes` item leads when there is one. */
  evidence: Evidence[];
  /**
   * The constraint that stopped it — the first one the engine emitted, because the
   * gate evaluates its checks in a fixed order and that order IS the precedence.
   * Null unless the outcome is `rejected`.
   */
  blocking: Evidence | null;
  /**
   * How many hard constraints it failed. More than one is normal and is never
   * collapsed into the single blocking one.
   */
  failures: number;
  /** Only when the engine said relaxing would help. At most three. */
  actions: RecoveryAction[];
  /** `PlanStop.why`, verbatim. The engine's own audit trail. */
  why: string[];
  /**
   * The engine's own `ScoreBreakdown` for this id, when one exists — from the stop
   * for a selection, from the supplied map for anything else. Carried rather than
   * looked up later so the ledger is self-contained: a UI rendering "the
   * arithmetic" must show the engine's numbers, never a reconstruction of them.
   */
  score: ScoreBreakdown | null;
  /** `ScoreBreakdown.profileVersion`, so a claim stays checkable later. */
  scoreVersion: string | null;
};

export type ExplanationLedger = {
  planId: string;
  contextId: string;
  /** Every stop, then every rejection, then every considered candidate. */
  explanations: Explanation[];
  byId: ReadonlyMap<string, Explanation>;
  /** `Plan.relaxations`: what the packer gave up to make the plan fit. */
  relaxations: Evidence[];
  /**
   * `Plan.stressFactors[].rescue` for the single heaviest factor — the one fix
   * with the most impact, in the engine's own words.
   */
  rescue: string | null;
  /**
   * Every weight term a LEARNED profile moved, deduplicated. The contract requires
   * this to be shown, and a list is the only form in which "shown" is checkable
   * rather than decorative.
   */
  learnedKeys: string[];
  /** Every must-see the traveller named, and what became of it. */
  mustSee: MustSee[];
  /**
   * What this ledger was built FROM, so `auditLedger` can refuse to compare a
   * ledger against data it was not derived from. Sizes rather than identities
   * deliberately: this is a tripwire for "you passed different options to the two
   * calls", not a content hash.
   */
  source: LedgerSource;
};

/**
 * A must-see the traveller named, and what became of it.
 *
 * `mustsee: true` on a `DecomposedRequest` means the traveller asked for something
 * by name. The one thing worse than not getting it is not being told, so every
 * must-see is accounted for here with the outcome it actually got.
 *
 * RESOLUTION IS EXACT-ID ONLY. A request's `pos` is free text ("the dhobi ghat
 * walk"), and matching that against a catalogue with anything cleverer than string
 * equality would mean inventing a correspondence the traveller never made. So a
 * request either names an id we hold — and resolves — or it is reported unresolved,
 * which is the truth and is actionable in a different way: it is a data gap, and
 * data gaps are the raw material of the provider-side unmet-demand feed.
 */
export type MustSee = {
  /** `DecomposedRequest.pos`, verbatim. */
  requested: string;
  /** The experience id it resolved to, or null when nothing matched exactly. */
  resolvedId: string | null;
  /** The outcome of that experience, or null when the request resolved to nothing. */
  outcome: Outcome | null;
  /** The blocking constraint, when it resolved and did not make it. */
  blockedBy: RejectionCode | null;
};

export type LedgerSource = {
  planId: string;
  contextId: string;
  catalogue: number;
  fits: number;
  scores: number;
  rejections: number;
};

export type ExplainOptions = {
  /**
   * Optional, and only for the three things a plan does not carry: the display
   * name, `Experience.provenance`, and the fits and scores of candidates that are
   * neither stops nor rejections. Omitting any of them drops the corresponding
   * evidence and never invents it.
   *
   * The fits and scores matter for honesty as much as for coverage: they are
   * where a rejected candidate's own cost and duration live, so a `Rejection`
   * sentence that quotes them is grounded. Omit them and the audit will correctly
   * report that sentence as unbacked.
   */
  catalogue?: ReadonlyMap<string, Experience>;
  fits?: Readonly<Record<string, Fit>>;
  scores?: Readonly<Record<string, ScoreBreakdown>>;
};

export type LedgerViolation = {
  code:
    | "missing_explanation"
    | "unknown_experience"
    | "plan_contradiction"
    | "evidence_drift"
    | "ungrounded_claim"
    | "source_mismatch";
  message: string;
  experienceId: string | null;
};

export type LedgerAudit = { ok: boolean; violations: LedgerViolation[] };

// ---------------------------------------------------------------------------
// Sentences for a constraint that carries no number
// ---------------------------------------------------------------------------

/**
 * One sentence per `RejectionCode`, and no figure in any of them. Typed as
 * `Record<RejectionCode, string>`, so a new code in the frozen contract is a
 * compile error here rather than a blank line in the UI.
 *
 * These are fallbacks. The engine's own `Rejection.message` always wins, because
 * it was written next to the decision and carries figures this layer cannot know
 * (a specific closing time, a named alternative). This exists for the gate that
 * emitted a code without one, and `docs/FEATURES.md` §4 asks for exactly this:
 * the code's sentence with no figure, rather than an invented one.
 */
const CODE_SENTENCE: Record<RejectionCode, string> = {
  too_far: "It is too far to reach in the time you have.",
  travel_time_exceeds_budget: "Getting there takes longer than the whole window you have.",
  duration_exceeds_budget: "It needs more time than you have left.",
  closed_now: "It is shut right now.",
  closed_during_window: "It closes before you could get there and finish.",
  hours_unverified: "Its opening hours are unverified, so we cannot promise it is open.",
  over_budget: "It costs more than you said you would spend.",
  over_budget_per_person: "It costs more per person than you allowed.",
  capacity_exceeded: "It cannot take your whole party.",
  not_step_free: "It is not step-free.",
  not_stroller_ok: "It is not usable with a stroller.",
  no_low_stairs: "It has stairs that cannot be avoided.",
  no_hearing_loop: "It has no hearing loop.",
  no_restroom: "It has no restroom on site.",
  inaccessible: "It does not meet the access needs in your party.",
  diet_mismatch: "It does not serve the diets you need.",
  sold_out: "It is sold out for your window.",
  requires_booking_not_available: "It needs a booking that cannot be made in time.",
  lead_time_too_short: "It needs more notice than you have left.",
  weather_unsafe: "The weather makes it unsafe or unpleasant right now.",
  duplicate: "It is the same place twice.",
  already_planned: "It is already in your plan.",
  excluded_by_traveller: "You told us to leave it out.",
  mustsee_conflict: "It cannot be done alongside the must-see you asked for.",
  seasonal_mismatch: "It is not the season for it.",
};

/**
 * Codes where a wider context genuinely unblocks the candidate, by unit. A code
 * absent from this map gets no patch: there is no honest mutation of
 * `DiscoveryContext` that makes a missing hearing loop appear.
 */
const PATCHABLE: Partial<Record<RejectionCode, "time" | "money">> = {
  travel_time_exceeds_budget: "time",
  duration_exceeds_budget: "time",
  lead_time_too_short: "time",
  over_budget: "money",
  over_budget_per_person: "money",
};

/**
 * Codes that mean the candidate is already in, or already out of, the running.
 * Offering to exclude one of these is either a no-op or a lie.
 */
const ALREADY_SETTLED: ReadonlySet<RejectionCode> = new Set<RejectionCode>([
  "already_planned",
  "excluded_by_traveller",
  "duplicate",
]);

/** The catalogue fields a decision leaned on, named in words for the badge line. */
const FIELD_LABEL: Record<string, string> = {
  durationMin: "How long it takes",
  pricePerPerson: "The price",
  hours: "The opening hours",
  capacity: "The group size it takes",
  indoorOutdoor: "Whether it is indoors",
  accessibility: "The access details",
  kidFriendly: "Whether it suits children",
  minAge: "The minimum age",
  rating: "The rating",
  diets: "The diets",
};

/** Metres as a distance. `groundedFigures` has no metres pattern, so this is prose. */
function distance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${metres} m`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The size of the miss, in the unit the engine reported. Never printed for a
 * rejection whose `shortfall` is null, which is the case §4 calls out: the
 * sentence with no figure, rather than an invented one.
 */
function shortfallClause(row: Rejection, currency: string): string {
  const { shortfall, unit } = row;
  if (shortfall === null || shortfall <= 0) return "";
  if (unit === "minutes") return ` Short by ${formatMinutes(shortfall)}.`;
  if (unit === "minor_units") return ` ${formatMoney(shortfall, currency)} over.`;
  if (unit === "people") return ` Short by ${plural(shortfall, "place", "places")}.`;
  if (unit === "metres") return ` ${distance(shortfall)} further out.`;
  return "";
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** A rounded, sign-aware rendering of a unitless score contribution. */
function points(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

// ---------------------------------------------------------------------------
// Evidence from a fit and from a score
// ---------------------------------------------------------------------------

function fitEvidence(fit: Fit): Evidence[] {
  const { cost, budget, availableMin, totalMin } = fit;
  const overBudget = budget !== null && cost.minor > budget.minor;
  const window = totalMin - availableMin;
  return [
    {
      key: "fit:window",
      claim:
        window <= 0
          ? `${formatMinutes(totalMin)} of the ${formatMinutes(availableMin)} you have, travel, time on site and buffer included.`
          : `Needs ${formatMinutes(window)} more than the ${formatMinutes(availableMin)} you have.`,
      polarity: window <= 0 ? "supports" : "opposes",
      source: "fit",
      value: window,
      unit: "minutes",
      weight: null,
      learned: false,
      provenance: null,
    },
    {
      key: "fit:cost",
      claim:
        budget === null
          ? `Costs ${formatMoney(cost.minor, cost.currency)}, and you set no ceiling.`
          : overBudget
            ? `${formatMoney(cost.minor, cost.currency)}, which is ${formatMoney(cost.minor - budget.minor, cost.currency)} over your ${formatMoney(budget.minor, budget.currency)} ceiling.`
            : `${formatMoney(cost.minor, cost.currency)} of the ${formatMoney(budget.minor, budget.currency)} ceiling.`,
      polarity: overBudget ? "opposes" : "supports",
      source: "fit",
      value: cost.minor,
      unit: "minor_units",
      weight: null,
      learned: false,
      provenance: null,
    },
    {
      key: "fit:travel",
      claim: `${formatMinutes(fit.travelMin)} to get there.`,
      polarity: "neutral",
      source: "fit",
      value: fit.travelMin,
      unit: "minutes",
      weight: null,
      learned: false,
      provenance: null,
    },
    {
      key: "fit:activity",
      claim: `${formatMinutes(fit.activityMin)} on site.`,
      polarity: "neutral",
      source: "fit",
      value: fit.activityMin,
      unit: "minutes",
      weight: null,
      learned: false,
      provenance: null,
    },
    {
      key: "fit:buffer",
      // Zero is a real answer here, and "0 min of buffer" is not a sentence.
      claim: fit.bufferMin > 0 ? `${formatMinutes(fit.bufferMin)} of buffer.` : "No buffer left in this plan.",
      polarity: "neutral",
      source: "fit",
      value: fit.bufferMin,
      unit: "minutes",
      weight: null,
      learned: false,
      provenance: null,
    },
    /*
      The engine's own one-word verdict, which nothing else in the plan repeats.
      `fit:window` and `fit:cost` report the arithmetic; this reports the CALL. It
      matters most when the two disagree — a stop the engine called `does_not_fit`
      that is in the plan anyway means a relaxation was applied, and saying so is the
      difference between a confident recommendation and a confident-looking one.
    */
    {
      key: `fit:verdict:${fit.verdict}`,
      claim:
        fit.verdict === "does_not_fit"
          ? "The engine's own verdict is that it does not fit, and it is in the plan anyway."
          : fit.verdict === "tight"
            ? "The engine rates the margin tight."
            : "The engine's verdict is that it fits.",
      polarity: fit.verdict === "does_not_fit" ? "opposes" : fit.verdict === "tight" ? "neutral" : "supports",
      source: "fit",
      value: null,
      unit: "none",
      weight: null,
      learned: false,
      provenance: null,
    },
    // The engine's own per-constraint verdicts. The index is in the key because
    // `label` is free text and two checks can share it.
    ...fit.checks.map((check, index) => ({
      key: `fit:check:${index}:${slug(check.label)}`,
      claim: check.detail,
      polarity: check.pass ? ("supports" as const) : ("opposes" as const),
      source: "fit" as const,
      value: null,
      unit: "none" as const,
      weight: null,
      learned: false,
      provenance: null,
    })),
  ];
}

function scoreEvidence(score: ScoreBreakdown | undefined): Evidence[] {
  if (!score) return [];
  // `learnedComponents` is the contract's own list of the terms a learned weight
  // moved. Reading it here is what lets the UI say "we learned this one" on the
  // line it applies to, rather than only in a separate weights panel.
  const learned = new Set(score.learnedComponents);
  return score.components.map((component) => ({
    key: `score:${component.key}`,
    // The engine's own ledger line when it wrote one. Otherwise the arithmetic,
    // with the signed contribution and the weight that produced it — never a
    // paraphrase of a label on its own, which would claim a reason nobody gave.
    claim: component.reason ?? `${component.label}: ${points(component.value)} at weight ${component.weight}.`,
    polarity: component.value < 0 ? ("opposes" as const) : ("supports" as const),
    source: "score" as const,
    value: component.value,
    unit: "points" as const,
    weight: component.weight,
    learned: learned.has(component.key),
    provenance: null,
  }));
}

/**
 * Anything guessed rather than confirmed, said out loud.
 *
 * `curated` is the absence of a caveat and earns no line; `inferred` is a model
 * guess and always does, because a badge that only appears when there is nothing
 * to hide is not a badge.
 */
function provenanceEvidence(experience: Experience | undefined): Evidence[] {
  if (!experience) return [];
  const out: Evidence[] = [];
  for (const [field, value] of Object.entries(experience.provenance)) {
    if (value === "curated") continue;
    const label = FIELD_LABEL[field] ?? field;
    const claim =
      value === "inferred"
        ? `${label} was guessed from the listing text, not confirmed.`
        : value === "osm"
          ? `${label} came from OpenStreetMap.`
          : value === "provider"
            ? `${label} came from the listing's owner.`
            : `${label} was computed by us.`;
    out.push({
      key: `provenance:${field}`,
      claim,
      polarity: "neutral",
      source: "fit",
      value: null,
      unit: "none",
      weight: null,
      learned: false,
      provenance: value,
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const POLARITY_RANK: Record<EvidencePolarity, number> = { opposes: 0, supports: 1, neutral: 2 };
/** The engine's ranked contributions, then its own prose, then the meter. */
const SOURCE_RANK: Record<EvidenceSource, number> = { filter: 0, score: 1, pack: 2, fit: 3 };

/**
 * Caveats first, then the engine's own ranking of why it won, then the meter. The
 * final key comparison is what makes this total: no two items can compare equal, so
 * the order cannot depend on the input order or on the sort being stable.
 */
function compareEvidence(a: Evidence, b: Evidence): number {
  const polarity = POLARITY_RANK[a.polarity] - POLARITY_RANK[b.polarity];
  if (polarity !== 0) return polarity;
  const source = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (source !== 0) return source;
  const impact = Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0);
  if (impact !== 0) return impact;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The four outcomes
// ---------------------------------------------------------------------------

function explainSelected(stop: PlanStop, experience: Experience | undefined): Explanation {
  const why = [...stop.why];
  const evidence = [
    ...why.map((line, index) => ({
      key: `why:${index}`,
      claim: line,
      // The engine does not sign its own prose, and this layer will not sign it
      // for it. A cost inside `why` is reported honestly by the matching
      // `ScoreComponent`, which does carry a signed value.
      polarity: "neutral" as const,
      source: "pack" as const,
      value: null,
      unit: "none" as const,
      weight: null,
      learned: false,
      provenance: null,
    })),
    ...scoreEvidence(stop.score),
    ...fitEvidence(stop.fit),
    ...provenanceEvidence(experience),
  ].sort(compareEvidence);

  return {
    experienceId: stop.experienceId,
    name: experience?.name ?? null,
    outcome: "selected",
    // `PlanStop.why` is the engine's own ranked summary, so it makes the better
    // sentence than any single contribution. The last fallback says what is true
    // and nothing more, rather than inventing a compliment.
    headline:
      evidence.find((item) => item.source === "pack")?.claim ??
      evidence.find((item) => item.polarity !== "opposes")?.claim ??
      "The engine selected it but recorded no reason.",
    evidence,
    blocking: null,
    failures: 0,
    actions: [],
    why,
    score: stop.score,
    scoreVersion: stop.score.profileVersion,
  };
}

/**
 * A candidate that cleared every hard gate, was scored, and still did not get
 * packed. The only verifiable facts are arithmetic — its own score against the
 * scores the packer took, and the window those stops consumed — so that is exactly
 * what is said. No claim is made about WHY the packer preferred them, because
 * nothing in the published engine API states one.
 */
function explainConsidered(
  id: string,
  fit: Fit | undefined,
  score: ScoreBreakdown | undefined,
  plan: Plan,
  ctx: DiscoveryContext,
  experience: Experience | undefined,
): Explanation {
  const taken = plan.stops.map((stop) => stop.score.total);
  const evidence = [
    ...scoreEvidence(score),
    ...(fit ? fitEvidence(fit) : []),
    ...provenanceEvidence(experience),
    {
      key: "pack:ranking",
      claim:
        taken.length > 0
          ? `Scored ${score ? score.total : "nothing recorded"}, against ${taken.join(" and ")} for the ${plural(taken.length, "stop", "stops")} you have.`
          : "It passed every hard constraint, and the plan came back empty.",
      polarity: "neutral" as const,
      source: "pack" as const,
      value: score?.total ?? null,
      unit: "points" as const,
      weight: null,
      learned: false,
      provenance: null,
    },
    {
      key: "pack:window",
      claim: `Your ${formatMinutes(ctx.availableMin)} are already committed to ${plural(plan.stops.length, "stop", "stops")}.`,
      polarity: "neutral" as const,
      source: "pack" as const,
      value: plan.stops.length,
      unit: "none" as const,
      weight: null,
      learned: false,
      provenance: null,
    },
  ].sort(compareEvidence);

  return {
    experienceId: id,
    name: experience?.name ?? null,
    outcome: "considered",
    headline:
      evidence.find((item) => item.polarity === "opposes")?.claim ??
      evidence.find((item) => item.source === "score")?.claim ??
      "It was scored and the plan is full.",
    evidence,
    blocking: null,
    failures: 0,
    actions: [],
    why: [],
    score: score ?? null,
    scoreVersion: score?.profileVersion ?? null,
  };
}

function rejectionEvidence(row: Rejection, currency: string): Evidence {
  const message = row.message.trim();
  return {
    key: `filter:${row.code}`,
    claim: message || `${CODE_SENTENCE[row.code]}${shortfallClause(row, currency)}`,
    polarity: "opposes",
    source: "filter",
    value: row.shortfall,
    unit: row.unit ?? "none",
    weight: null,
    learned: false,
    provenance: null,
  };
}

/** Appends the honest count when a patch clears only some of the failures. */
function scoped(label: string, clears: number, failures: number): string {
  return clears >= failures ? label : `${label} Fixes ${clears} of the ${failures} problems, not all of them.`;
}

/**
 * At most three, each one a patch `ContextChange.patch` already accepts, each
 * derived from the shortfall the engine reported.
 *
 * Two rules that are easy to get wrong and expensive when you do:
 *
 *  - A patch is only offered for a code that is patchable at all. `no_hearing_loop`
 *    has no honest `DiscoveryContext` mutation, and inventing one would teach the
 *    traveller that the product can conjure a hearing loop.
 *  - The largest shortfall of each kind wins, because a candidate can fail both
 *    the travel and the duration budget and adding the bigger covers both. Each
 *    action then declares how many of the recorded failures it actually clears, so
 *    a partial fix is visible as a partial fix.
 */
function recoveryActions(rows: readonly Rejection[], ctx: DiscoveryContext, currency: string): RecoveryAction[] {
  if (!rows.some((row) => row.relaxable)) return [];

  const clearable = rows.filter((row) => PATCHABLE[row.code] !== undefined);
  const actions: RecoveryAction[] = [];

  const worst = (kind: "time" | "money"): Rejection | null => {
    const candidates = clearable.filter((row) => PATCHABLE[row.code] === kind && (row.shortfall ?? 0) > 0);
    return candidates.reduce<Rejection | null>(
      (top, row) => (top === null || (row.shortfall ?? 0) > (top.shortfall ?? 0) ? row : top),
      null,
    );
  };

  const worstTime = worst("time");
  if (worstTime) {
    const shortfall = worstTime.shortfall as number;
    const clears = rows.filter((row) => PATCHABLE[row.code] === "time").length;
    actions.push({
      id: "add_time",
      label: scoped(`Give it ${formatMinutes(shortfall)} more.`, clears, rows.length),
      scope: clears === rows.length ? "all" : "partial",
      clears,
      patch: { availableMin: ctx.availableMin + shortfall },
    });
  }

  const worstMoney = worst("money");
  if (worstMoney) {
    const shortfall = worstMoney.shortfall as number;
    const clears = rows.filter((row) => PATCHABLE[row.code] === "money").length;
    // With no ceiling set there is nothing to raise, so the honest patch is to set
    // one at the figure that would have passed.
    const label =
      ctx.budget === null
        ? `Set a ceiling of ${formatMoney(shortfall, currency)}.`
        : `Raise the ceiling by ${formatMoney(shortfall, currency)}.`;
    actions.push({
      id: "raise_budget",
      label: scoped(label, clears, rows.length),
      scope: clears === rows.length ? "all" : "partial",
      clears,
      patch: { budgetMinor: (ctx.budget?.minor ?? 0) + shortfall },
    });
  }

  if (!rows.every((row) => ALREADY_SETTLED.has(row.code))) {
    const id = rows[0]?.experienceId ?? "";
    actions.push({
      id: "drop_it",
      label: scoped("Leave this one out and see what fits instead.", rows.length, rows.length),
      scope: "all",
      clears: rows.length,
      patch: { excludedIds: [...new Set([...ctx.excludedIds, id])].filter(Boolean) },
    });
  }

  return actions.slice(0, 3);
}

function explainRejected(
  id: string,
  rows: readonly [Rejection, ...Rejection[]],
  ctx: DiscoveryContext,
  currency: string,
  experience: Experience | undefined,
  extra: Evidence[],
  score: ScoreBreakdown | undefined,
): Explanation {
  const evidence = [...rows.map((row) => rejectionEvidence(row, currency)), ...extra];
  const blocking = evidence[0] as Evidence;
  return {
    experienceId: id,
    name: experience?.name ?? null,
    outcome: "rejected",
    headline: blocking.claim,
    evidence,
    blocking,
    failures: rows.length,
    actions: recoveryActions(rows, ctx, currency),
    why: [],
    score: score ?? null,
    scoreVersion: score?.profileVersion ?? null,
  };
}

/**
 * Nothing in the data ever looked at it.
 *
 * This exists because an empty panel reads as a bug, and the two are different
 * facts. `docs/FEATURES.md` §4 requires a specific answer to "why is this not
 * here", and "we never evaluated it" is the only specific answer that is true when
 * no fit, no score and no rejection exists for the id.
 */
function explainNotConsidered(id: string, experience: Experience | undefined): Explanation {
  const claim = "Nothing in this search ever looked at it, so there is no constraint to report.";
  return {
    experienceId: id,
    name: experience?.name ?? null,
    outcome: "not_considered",
    headline: claim,
    evidence: [
      {
        key: "pack:not_considered",
        claim,
        polarity: "neutral",
        source: "pack",
        value: null,
        unit: "none",
        weight: null,
        learned: false,
        provenance: null,
      },
    ],
    blocking: null,
    failures: 0,
    // Honest emptiness: the retrieval limit is not a `DiscoveryContext` field, so
    // "look further afield" is a change to the engine's query, not to the
    // traveller's situation, and this layer has no business faking a patch for it.
    actions: [],
    why: [],
    score: null,
    scoreVersion: null,
  };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

function relaxationEvidence(plan: Plan): Evidence[] {
  return plan.relaxations.map((entry) => ({
    key: `relaxation:${entry.rung}:${entry.relaxed ?? "none"}`,
    claim: `${entry.label} — gave up ${entry.gaveUp}.`,
    polarity: "neutral" as const,
    source: "pack" as const,
    value: null,
    unit: "none" as const,
    weight: null,
    learned: false,
    provenance: null,
  }));
}

/** Rejected ids in the order the engine first mentioned them, with every row. */
function rejectedOrder(rows: readonly Rejection[]): [string, [Rejection, ...Rejection[]]][] {
  const grouped = new Map<string, Rejection[]>();
  for (const row of rows) {
    const list = grouped.get(row.experienceId);
    if (list) list.push(row);
    else grouped.set(row.experienceId, [row]);
  }
  return [...grouped.entries()].map(([id, list]) => [id, list as [Rejection, ...Rejection[]]]);
}

/** Heaviest factor first, by the contract's own weight x value. */
function heaviestRescue(plan: Plan): string | null {
  const worst = [...plan.stressFactors].sort((a, b) => b.weight * b.value - a.weight * a.value)[0];
  return worst?.rescue ?? null;
}

/** Every weight term a learned profile moved, deduplicated and ordered. */
function learnedKeysIn(explanations: readonly Explanation[]): string[] {
  const keys = new Set<string>();
  for (const item of explanations) {
    for (const entry of item.evidence) {
      if (entry.learned) keys.add(entry.key.replace(/^score:/, ""));
    }
  }
  return [...keys].sort();
}

/** `filter:over_budget` -> `over_budget`. The key namespace is ours, so this is safe. */
function codeOf(key: string): RejectionCode | null {
  const code = key.startsWith("filter:") ? key.slice("filter:".length) : "";
  return code in CODE_SENTENCE ? (code as RejectionCode) : null;
}

/**
 * Every must-see the traveller named, and what became of it. Exact-id resolution
 * only, for the reason on `MustSee`.
 */
function mustSeeIn(
  ctx: DiscoveryContext,
  byId: ReadonlyMap<string, Explanation>,
  known: ReadonlySet<string>,
): MustSee[] {
  const out: MustSee[] = [];
  for (const request of ctx.requests) {
    if (!request.mustsee) continue;
    const resolvedId = known.has(request.pos) ? request.pos : null;
    const explanation = resolvedId === null ? undefined : byId.get(resolvedId);
    out.push({
      requested: request.pos,
      resolvedId,
      outcome: explanation?.outcome ?? null,
      blockedBy: explanation?.blocking ? codeOf(explanation.blocking.key) : null,
    });
  }
  return out;
}

/**
 * The whole plan's reasoning: every stop it chose, every candidate it dropped, and
 * every candidate it scored and then had no room for.
 *
 * An id that is both a stop and rejected gets BOTH explanations and no silent
 * resolution — `auditLedger` reports it as a `plan_contradiction`, because that
 * contradiction is a fact about the plan and hiding it would be the one thing an
 * explainability feature must not do.
 *
 * `opts.catalogue` is also walked, so an experience the traveller can see but the
 * data never touched gets an honest `not_considered` rather than no answer at all.
 */
export function explainPlan(plan: Plan, ctx: DiscoveryContext, opts: ExplainOptions = {}): ExplanationLedger {
  const currency = plan.totalCost.currency || ctx.budget?.currency || "INR";
  const explanations: Explanation[] = [];
  const stopIds = new Set(plan.stops.map((stop) => stop.experienceId));

  const stops = [...plan.stops].sort(
    (a, b) => a.order - b.order || (a.experienceId < b.experienceId ? -1 : 1),
  );
  for (const stop of stops) {
    explanations.push(explainSelected(stop, opts.catalogue?.get(stop.experienceId)));
  }

  for (const [id, rows] of rejectedOrder(plan.rejected)) {
    // A rejected candidate's own fit and score are real numbers about it, and the
    // engine published them separately from the plan. When the caller has them they
    // are shown, because "it is also the closest thing to you" is part of
    // why-not-that, and because a `Rejection.message` that quotes this candidate's
    // cost is only grounded if the cost is in the data.
    const fit = opts.fits?.[id];
    const score = opts.scores?.[id];
    const extra: Evidence[] = stopIds.has(id) ? [] : [...(fit ? fitEvidence(fit) : []), ...scoreEvidence(score)];
    explanations.push(explainRejected(id, rows, ctx, currency, opts.catalogue?.get(id), extra, score));
  }

  const rejectedSet = new Set(plan.rejected.map((row) => row.experienceId));
  const scored = new Set([...Object.keys(opts.fits ?? {}), ...Object.keys(opts.scores ?? {})]);
  for (const id of [...scored].sort()) {
    if (stopIds.has(id) || rejectedSet.has(id)) continue;
    explanations.push(
      explainConsidered(id, opts.fits?.[id], opts.scores?.[id], plan, ctx, opts.catalogue?.get(id)),
    );
  }

  if (opts.catalogue) {
    for (const id of [...opts.catalogue.keys()].sort()) {
      if (stopIds.has(id) || rejectedSet.has(id) || scored.has(id)) continue;
      explanations.push(explainNotConsidered(id, opts.catalogue.get(id)));
    }
  }

  return {
    planId: plan.id,
    contextId: plan.contextId,
    explanations,
    byId: new Map(explanations.map((item) => [item.experienceId, item])),
    relaxations: relaxationEvidence(plan),
    rescue: heaviestRescue(plan),
    learnedKeys: learnedKeysIn(explanations),
    mustSee: mustSeeIn(
      ctx,
      new Map(explanations.map((item) => [item.experienceId, item])),
      new Set([...(opts.catalogue?.keys() ?? []), ...stopIds]),
    ),
    source: {
      planId: plan.id,
      contextId: plan.contextId,
      catalogue: opts.catalogue?.size ?? 0,
      fits: Object.keys(opts.fits ?? {}).length,
      scores: Object.keys(opts.scores ?? {}).length,
      rejections: plan.rejected.length,
    },
  };
}

/** The answer for one tapped thing, whichever of the four outcomes it has. */
export function explainOne(
  id: string,
  plan: Plan,
  ctx: DiscoveryContext,
  opts: ExplainOptions = {},
): Explanation | null {
  return explainPlan(plan, ctx, opts).byId.get(id) ?? null;
}

/**
 * The engine's published `score`, typed structurally.
 *
 * Declared here rather than imported from the discovery feature's `EnginePort` so
 * this file keeps no dependency on another feature's seam, and so a caller can hand
 * in the real engine's function directly. `pack(ctx, items): Plan` takes no weight
 * profile and scores internally, so a breakdown for a candidate that was NOT packed
 * exists only if someone calls `score` for it — and until someone does, a
 * `considered` candidate has no ranking to show. This is that someone.
 */
export type ScoreFn = (
  ctx: DiscoveryContext,
  items: readonly Experience[],
  weights: WeightProfile,
) => readonly ScoreBreakdown[];

/**
 * Fill in breakdowns for candidates the plan did not take, keeping the ones it
 * already has.
 *
 * Existing entries always win. A stop's `PlanStop.score` is the engine's own
 * arithmetic and must never be recomputed: two calls to `score` with the same inputs
 * should agree, but "should" is not a property worth relying on for the number a
 * traveller is shown.
 *
 * Ids the engine returns nothing for are simply absent, and an absent breakdown
 * produces no evidence — `explainPlan` then reports that candidate on its fit and
 * the committed window alone, which is the truth.
 */
export function scoreCandidates(
  score: ScoreFn,
  ctx: DiscoveryContext,
  items: readonly Experience[],
  weights: WeightProfile,
  already: Readonly<Record<string, ScoreBreakdown>> = {},
): Record<string, ScoreBreakdown> {
  const out: Record<string, ScoreBreakdown> = { ...already };
  const missing = items.filter((item) => !(item.id in out));
  if (missing.length === 0) return out;
  for (const breakdown of score(ctx, missing, weights)) {
    out[breakdown.experienceId] = breakdown;
  }
  return out;
}

/** Just the ids that did not make it, in the engine's order. */
export function rejectedIds(ledger: ExplanationLedger): string[] {
  return ledger.explanations.filter((item) => item.outcome === "rejected").map((item) => item.experienceId);
}

// ---------------------------------------------------------------------------
// The audit — an explanation is admissible only if it re-derives
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

const EVIDENCE_FIELDS: readonly (keyof Evidence)[] = [
  "key",
  "claim",
  "polarity",
  "source",
  "value",
  "unit",
  "weight",
  "provenance",
];

function sameEvidence(a: Evidence, b: Evidence): boolean {
  return EVIDENCE_FIELDS.every((field) => deepEqual(a[field], b[field]));
}

function sameExplanation(a: Explanation, b: Explanation): boolean {
  return (
    a.experienceId === b.experienceId &&
    a.name === b.name &&
    a.outcome === b.outcome &&
    a.headline === b.headline &&
    a.failures === b.failures &&
    a.scoreVersion === b.scoreVersion &&
    deepEqual(a.score, b.score) &&
    a.why.length === b.why.length &&
    a.why.every((line, index) => line === b.why[index]) &&
    a.actions.length === b.actions.length &&
    a.actions.every((action, index) => {
      const other = b.actions[index];
      return (
        other !== undefined &&
        action.id === other.id &&
        action.label === other.label &&
        action.scope === other.scope &&
        action.clears === other.clears &&
        deepEqual(action.patch, other.patch)
      );
    }) &&
    a.evidence.length === b.evidence.length &&
    a.evidence.every((item, index) => {
      const other = b.evidence[index];
      return other !== undefined && sameEvidence(item, other);
    }) &&
    deepEqual(a.blocking, b.blocking)
  );
}

/** First field that differs, named, so a violation says what to look at. */
function driftIn(claimed: Explanation, actual: Explanation): string {
  if (claimed.outcome !== actual.outcome) return "outcome";
  if (claimed.headline !== actual.headline) return "headline";
  if (claimed.name !== actual.name) return "name";
  if (claimed.failures !== actual.failures) return "failures";
  if (claimed.scoreVersion !== actual.scoreVersion) return "scoreVersion";
  if (!deepEqual(claimed.score, actual.score)) return "score";
  if (!deepEqual(claimed.why, actual.why)) return "why";
  if (claimed.evidence.length !== actual.evidence.length) return "evidence count";
  for (let index = 0; index < claimed.evidence.length; index += 1) {
    const got = claimed.evidence[index] as Evidence;
    const want = actual.evidence[index];
    if (!want) return `evidence[${index}]`;
    const field = EVIDENCE_FIELDS.find((name) => !deepEqual(got[name], want[name]));
    if (field) return `evidence[${index}].${field}`;
  }
  if (!deepEqual(claimed.blocking, actual.blocking)) return "blocking";
  if (claimed.actions.length !== actual.actions.length) return "actions";
  for (let index = 0; index < claimed.actions.length; index += 1) {
    if (!deepEqual(claimed.actions[index], actual.actions[index])) return `actions[${index}]`;
  }
  return "explanation";
}

/**
 * Every figure the data can back, in the forms a sentence may legitimately render
 * it. The same expansion `narrate.ts` uses, so "2 h" and "120 min" are the same
 * figure, and a check the reference implementation itself would fail is a check
 * nobody keeps.
 *
 * Built from the plan AND the context AND whatever fits and scores the caller
 * supplied. That last part is not optional bookkeeping: a rejected candidate was
 * never fitted into the plan, so its own cost lives only in the `fits` map, and a
 * `Rejection.message` that quotes that cost is unbacked without it. The shipped
 * demo copy demonstrates exactly this — "₹2,400 for four" is honest text that only
 * the supplied fit can corroborate.
 *
 * KNOWN CEILING: a score contribution is unitless, and the shared grounding
 * vocabulary has no points pattern, so a `ScoreComponent.reason` is checked by the
 * field-level drift comparison rather than by figure extraction. Every numeric
 * field of a component is still compared against the data.
 */
function dataFigures(plan: Plan, ctx: DiscoveryContext, opts: ExplainOptions): Set<string> {
  const money: number[] = [plan.totalCost.minor];
  const minutes: number[] = [0, ctx.availableMin, ctx.nowMin, Math.abs(plan.totalMin)];
  if (ctx.budget) money.push(ctx.budget.minor, Math.abs(ctx.budget.minor - plan.totalCost.minor));
  if (ctx.budgetPerPerson) money.push(ctx.budgetPerPerson.minor);

  const addFit = (fit: Fit): void => {
    money.push(fit.cost.minor);
    if (fit.budget) money.push(fit.budget.minor, Math.abs(fit.cost.minor - fit.budget.minor));
    minutes.push(
      fit.travelMin,
      fit.activityMin,
      fit.bufferMin,
      fit.totalMin,
      fit.availableMin,
      Math.abs(fit.totalMin - fit.availableMin),
    );
  };
  for (const stop of plan.stops) {
    addFit(stop.fit);
    minutes.push(stop.arriveMin, stop.departMin);
  }
  for (const fit of Object.values(opts.fits ?? {})) addFit(fit);

  for (const leg of plan.legs) minutes.push(leg.minutes);
  for (const row of plan.rejected) {
    if (row.shortfall === null) continue;
    if (row.unit === "minutes") minutes.push(Math.abs(row.shortfall));
    if (row.unit === "minor_units") money.push(Math.abs(row.shortfall));
  }
  const percents: number[] = [
    ...plan.stops.map((stop) => stop.fit.fitRatio * 100),
    ...Object.values(opts.fits ?? {}).map((fit) => fit.fitRatio * 100),
  ];
  return groundedFigures({ moneyMinor: money, minutes, percents });
}

/**
 * Recomputes the ledger from the data it claims to describe and reports the
 * difference. Five things, all of them the ways a why-ledger rots:
 *
 *  - a stop, a rejection or a considered candidate with no answer;
 *  - an answer for something no input mentions;
 *  - an id the plan both selected and rejected;
 *  - a claim that no longer matches the numbers;
 *  - a figure in a sentence nothing holds — which can fire on a freshly built
 *    ledger too, when the engine's own rejection sentence quotes a number that is
 *    not in the data the UI was given. That is exactly the sentence a traveller
 *    would budget from.
 */
export function auditLedger(
  ledger: ExplanationLedger,
  plan: Plan,
  ctx: DiscoveryContext,
  opts: ExplainOptions = {},
): LedgerAudit {
  const violations: LedgerViolation[] = [];
  const expected = explainPlan(plan, ctx, opts);

  /*
   * The tripwire, before anything else. Comparing a ledger built from one set of
   * options against a plan described by a different set produces a drift violation
   * for every single id, which reads like a catastrophic data problem and is
   * actually a caller mistake. Saying so in one line is the difference between a
   * five-minute diagnosis and an afternoon.
   */
  if (!deepEqual(ledger.source, expected.source)) {
    return {
      ok: false,
      violations: [
        {
          code: "source_mismatch",
          message: `This ledger was built from different data: it saw ${JSON.stringify(ledger.source)}, the audit was given ${JSON.stringify(expected.source)}.`,
          experienceId: null,
        },
      ],
    };
  }

  const stopIds = new Set(plan.stops.map((stop) => stop.experienceId));
  const rejectedSet = new Set(plan.rejected.map((row) => row.experienceId));
  const scored = new Set([...Object.keys(opts.fits ?? {}), ...Object.keys(opts.scores ?? {})]);

  for (const id of [...stopIds, ...rejectedSet, ...scored].sort()) {
    if (!ledger.byId.has(id)) {
      violations.push({ code: "missing_explanation", message: `No explanation for ${id}.`, experienceId: id });
    }
  }

  for (const item of ledger.explanations) {
    const selected = stopIds.has(item.experienceId);
    const dropped = rejectedSet.has(item.experienceId);
    const known =
      selected || dropped || scored.has(item.experienceId) || (opts.catalogue?.has(item.experienceId) ?? false);
    if (!known) {
      violations.push({
        code: "unknown_experience",
        message: `${item.experienceId} is explained but nothing in the plan or the supplied data mentions it.`,
        experienceId: item.experienceId,
      });
      continue;
    }
    if (selected && dropped) {
      violations.push({
        code: "plan_contradiction",
        message: `The plan both selected and rejected ${item.experienceId}.`,
        experienceId: item.experienceId,
      });
    }
    const derived = expected.byId.get(item.experienceId);
    if (derived && !sameExplanation(item, derived)) {
      violations.push({
        code: "evidence_drift",
        message: `${item.experienceId} no longer matches the data: ${driftIn(item, derived)}.`,
        experienceId: item.experienceId,
      });
    }
  }

  const figures = dataFigures(plan, ctx, opts);
  const claims = [
    ...ledger.explanations.flatMap((item) => item.evidence.map((entry) => entry.claim)),
    ...ledger.explanations.map((item) => item.headline),
    ...ledger.explanations.flatMap((item) => item.actions.map((action) => action.label)),
    ...ledger.relaxations.map((entry) => entry.claim),
    ...(ledger.rescue === null ? [] : [ledger.rescue]),
  ];
  for (const claim of claims) {
    const bad = unsupportedFigures(claim, figures);
    if (bad.length > 0) {
      violations.push({
        code: "ungrounded_claim",
        message: `Nothing in the data holds the figure "${bad[0]}" in: ${claim}`,
        experienceId: null,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
