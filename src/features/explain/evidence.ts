/**
 * Explainability: the engine's decisions, in finished sentences, carrying the
 * numbers that produced them.
 *
 * Four places produce a decision, and this file reads all four. It computes
 * nothing:
 *
 *   filterFeasible  ->  FeasibleResult.rejected  ->  Plan.rejected
 *                       one `Rejection` per hard-constraint failure: the code, a
 *                       sentence, the shortfall, the unit, and whether relaxing
 *                       would fix it.
 *   computeFit      ->  PlanStop.fit
 *                       the feasibility meter (travel / activity / buffer against
 *                       the window) plus `checks[]`, the engine's own per-constraint
 *                       pass/fail with a detail line for each.
 *   score           ->  PlanStop.score.components
 *                       the signed contributions, with the weight applied and
 *                       `profileVersion` so a score stays auditable.
 *   pack            ->  PlanStop.why, Plan.relaxations
 *                       the ranked ledger lines, and what was given up to make the
 *                       plan fit.
 *
 * The rules that keep this honest:
 *
 *  1. **No id is ever a key.** The only lookup table is keyed by the contract's
 *     `RejectionCode` machine key, which the engine chose for a reason. There is
 *     no "this place is great for you" anywhere, and a renamed or newly seeded
 *     experience gets exactly the same treatment as a famous one.
 *  2. **A figure is printed only when the plan holds it.** Every sentence is
 *     composed from a field, and `unsupportedFigures` re-checks the result against
 *     the plan's own numbers — the same mechanism `src/llm/narrate.ts` uses on the
 *     model's prose. A constraint with no number gets the code's sentence with no
 *     figure, per `docs/FEATURES.md` §4's failure behaviour, rather than an
 *     invented one.
 *  3. **An explanation is admissible only if it re-derives.** `auditLedger()`
 *     recomputes every explanation from the current plan and reports any drift,
 *     so a stale or hand-edited ledger is caught instead of rendered. That is what
 *     keeps the why-ledger consistent with the plan it describes.
 *  4. **Deterministic.** Pure functions, no `Date`, no randomness, no module state
 *     and no locale ordering: every sort ends in an explicit key comparison, so the
 *     same plan always produces the same sentences in the same order.
 *
 * `relaxable` is the engine's call, not ours, so recovery actions are only built
 * when it says a relaxation would fix the rejection, and each one is a real
 * mutation of `DiscoveryContext` derived from the shortfall itself.
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
 * feasibility meter's own arithmetic — "12 min to get there" is a fact about the
 * route, not a judgement about the place, and dressing it up as a reason would be
 * us inventing a verdict the engine never made.
 */
export type EvidencePolarity = "opposes" | "supports" | "neutral";

/** `Rejection.unit`, plus `points` (a score contribution is unitless) and `none`. */
export type EvidenceUnit = "minutes" | "minor_units" | "people" | "metres" | "points" | "none";

export type Evidence = {
  /** Stable machine key, namespaced by the producer. Never an experience id. */
  key: string;
  /** A finished sentence. Every figure in it exists in the plan. */
  claim: string;
  polarity: EvidencePolarity;
  source: EvidenceSource;
  /** The figure the claim rests on, in `unit`. Null when the constraint has none. */
  value: number | null;
  unit: EvidenceUnit;
  /** `ScoreComponent.weight`, for score evidence. */
  weight: number | null;
  /** `Experience.provenance` for the field the claim rests on, when declared. */
  provenance: Provenance | null;
};

/** A real `DiscoveryContext` mutation, not a suggestion to think about. */
export type RecoveryAction = {
  id: string;
  /** A finished sentence naming the exact change and its size. */
  label: string;
  /** Applied verbatim. Keys are the ones `ContextChange.patch` already carries. */
  patch: Record<string, unknown>;
};

export type Explanation = {
  experienceId: string;
  /** From the catalogue, when the caller passed one. Never guessed. */
  name: string | null;
  outcome: "selected" | "rejected";
  /** One sentence: why this, or why not that. */
  headline: string;
  /** Ranked. An `opposes` item leads when there is one. */
  evidence: Evidence[];
  /**
   * The constraint that stopped it — the first one the engine emitted, because the
   * gate evaluates its checks in a fixed order and that order IS the precedence.
   * Null for a selected stop.
   */
  blocking: Evidence | null;
  /** Only when the engine said relaxing would fix it. At most three. */
  actions: RecoveryAction[];
  /** `PlanStop.why`, verbatim. The engine's own audit trail. */
  why: string[];
  /** `ScoreBreakdown.profileVersion`, so a claim stays checkable later. */
  scoreVersion: string | null;
};

export type ExplanationLedger = {
  planId: string;
  contextId: string;
  /** Every stop, then every rejected candidate, in the engine's own order. */
  explanations: Explanation[];
  byId: ReadonlyMap<string, Explanation>;
  /** `Plan.relaxations`: what the packer gave up to make the plan fit. */
  relaxations: Evidence[];
};

export type ExplainOptions = {
  /**
   * Optional, and only for the two things a plan does not carry: the display name
   * and `Experience.provenance` for the badge. Omitting it drops both, and never
   * invents either.
   */
  catalogue?: ReadonlyMap<string, Experience>;
};

export type LedgerViolation = {
  code: "missing_explanation" | "plan_contradiction" | "evidence_drift" | "ungrounded_claim";
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
 */
const NO_FIGURE: Record<RejectionCode, string> = {
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
  if (unit === "people") return ` Short by ${shortfall} ${shortfall === 1 ? "person" : "people"}.`;
  if (unit === "metres") return ` ${distance(shortfall)} further out.`;
  return "";
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ---------------------------------------------------------------------------
// Evidence from a selected stop
// ---------------------------------------------------------------------------

/**
 * The provenance line for a field the decision leaned on. Anything `curated` is
 * the absence of a caveat and earns no line; anything `inferred` is a guess and
 * says so, because a badge that only appears when there is nothing to hide is not
 * a badge.
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
      provenance: value,
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

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
      provenance: null,
    })),
  ];
}

function scoreEvidence(stop: PlanStop): Evidence[] {
  return stop.score.components.map((component) => ({
    key: `score:${component.key}`,
    // The engine's own ledger line when it wrote one; otherwise the arithmetic,
    // with the contribution and the weight that produced it.
    claim: component.reason ?? `${component.label} contributed ${component.value} to the score at weight ${component.weight}.`,
    polarity: component.value < 0 ? ("opposes" as const) : ("supports" as const),
    source: "score" as const,
    value: component.value,
    unit: "points" as const,
    weight: component.weight,
    provenance: null,
  }));
}

const POLARITY_RANK: Record<EvidencePolarity, number> = { opposes: 0, supports: 1, neutral: 2 };
/** The engine's ranked contributions, then its own summary, then the meter. */
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

function explainStop(stop: PlanStop, experience: Experience | undefined): Explanation {
  const why = [...stop.why];
  const evidence = [
    ...why.map((line, index) => ({
      key: `why:${index}`,
      claim: line,
      polarity: "supports" as const,
      source: "pack" as const,
      value: null,
      unit: "none" as const,
      weight: null,
      provenance: null,
    })),
    ...scoreEvidence(stop),
    ...fitEvidence(stop.fit),
    ...provenanceEvidence(experience),
  ].sort(compareEvidence);

  return {
    experienceId: stop.experienceId,
    name: experience?.name ?? null,
    outcome: "selected",
    // `PlanStop.why` is the engine's own ranked summary of the stop, so it makes
    // the better sentence than any one contribution. The fallback picks the
    // strongest supporting evidence, and the last fallback says what is true and
    // nothing more, rather than inventing a compliment.
    headline:
      evidence.find((item) => item.source === "pack")?.claim ??
      evidence.find((item) => item.polarity !== "opposes")?.claim ??
      "The engine selected it but recorded no reason.",
    evidence,
    blocking: null,
    actions: [],
    why,
    scoreVersion: stop.score.profileVersion,
  };
}

// ---------------------------------------------------------------------------
// Evidence from a rejection
// ---------------------------------------------------------------------------

function rejectionEvidence(row: Rejection, currency: string): Evidence {
  // The engine's sentence wins: it was written next to the decision. The table is
  // the fallback for a gate that emitted a code without one, and a figure is only
  // added when the shortfall is real.
  const message = row.message.trim();
  return {
    key: `filter:${row.code}`,
    claim: message || `${NO_FIGURE[row.code]}${shortfallClause(row, currency)}`,
    polarity: "opposes",
    source: "filter",
    value: row.shortfall,
    unit: row.unit ?? "none",
    weight: null,
    provenance: null,
  };
}

/**
 * Up to three, each one a patch `ContextChange.patch` already accepts, and each
 * derived from the shortfall the engine reported. Nothing is offered for a
 * constraint that relaxing would not fix — that is what `Rejection.relaxable`
 * means, and we do not get to overrule it.
 */
function recoveryActions(row: Rejection, ctx: DiscoveryContext, currency: string): RecoveryAction[] {
  if (!row.relaxable) return [];
  const actions: RecoveryAction[] = [];
  if (row.unit === "minutes" && row.shortfall !== null && row.shortfall > 0) {
    actions.push({
      id: "add_time",
      label: `Give it ${formatMinutes(row.shortfall)} more.`,
      patch: { availableMin: ctx.availableMin + row.shortfall },
    });
  }
  if (row.unit === "minor_units" && row.shortfall !== null && row.shortfall > 0) {
    actions.push({
      id: "raise_budget",
      label: `Raise the ceiling by ${formatMoney(row.shortfall, currency)}.`,
      patch: { budgetMinor: (ctx.budget?.minor ?? 0) + row.shortfall },
    });
  }
  actions.push({
    id: "drop_it",
    label: "Leave this one out and see what fits instead.",
    patch: { excludedIds: [...new Set([...ctx.excludedIds, row.experienceId])] },
  });
  return actions.slice(0, 3);
}

function explainRejection(
  id: string,
  rows: readonly [Rejection, ...Rejection[]],
  ctx: DiscoveryContext,
  currency: string,
  experience: Experience | undefined,
): Explanation {
  const evidence = rows.map((row) => rejectionEvidence(row, currency));
  const blocking = evidence[0] as Evidence;
  return {
    experienceId: id,
    name: experience?.name ?? null,
    outcome: "rejected",
    headline: blocking.claim,
    evidence,
    blocking,
    actions: recoveryActions(rows[0], ctx, currency),
    why: [],
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
    provenance: null,
  }));
}

/** Rejected ids in the order the engine first mentioned them. */
function rejectedOrder(rows: readonly Rejection[]): [string, Rejection[]][] {
  const grouped = new Map<string, Rejection[]>();
  for (const row of rows) {
    const list = grouped.get(row.experienceId);
    if (list) list.push(row);
    else grouped.set(row.experienceId, [row]);
  }
  return [...grouped.entries()];
}

/**
 * The whole plan's reasoning: every stop it chose, and every candidate it dropped.
 *
 * An id that is both a stop and rejected gets BOTH explanations and no silent
 * resolution — `auditLedger` reports it as a `plan_contradiction`, because that
 * contradiction is a fact about the plan and hiding it would be the one thing an
 * explainability feature must not do.
 */
export function explainPlan(plan: Plan, ctx: DiscoveryContext, opts: ExplainOptions = {}): ExplanationLedger {
  const currency = plan.totalCost.currency || ctx.budget?.currency || "INR";
  const explanations: Explanation[] = [];

  const stops = [...plan.stops].sort(
    (a, b) => a.order - b.order || (a.experienceId < b.experienceId ? -1 : 1),
  );
  for (const stop of stops) {
    explanations.push(explainStop(stop, opts.catalogue?.get(stop.experienceId)));
  }
  for (const [id, rows] of rejectedOrder(plan.rejected)) {
    explanations.push(explainRejection(id, rows as [Rejection, ...Rejection[]], ctx, currency, opts.catalogue?.get(id)));
  }

  return {
    planId: plan.id,
    contextId: plan.contextId,
    explanations,
    byId: new Map(explanations.map((item) => [item.experienceId, item])),
    relaxations: relaxationEvidence(plan),
  };
}

/** The answer for one tapped thing, selected or not. Null when the plan never saw it. */
export function explainOne(
  id: string,
  plan: Plan,
  ctx: DiscoveryContext,
  opts: ExplainOptions = {},
): Explanation | null {
  return explainPlan(plan, ctx, opts).byId.get(id) ?? null;
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
    a.scoreVersion === b.scoreVersion &&
    a.why.length === b.why.length &&
    a.why.every((line, index) => line === b.why[index]) &&
    a.actions.length === b.actions.length &&
    a.actions.every((action, index) => {
      const other = b.actions[index];
      return other !== undefined && action.id === other.id && action.label === other.label && deepEqual(action.patch, other.patch);
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
  if (claimed.scoreVersion !== actual.scoreVersion) return "scoreVersion";
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
 * Every figure the plan can back, in the forms a sentence may legitimately render
 * it. The same expansion `narrate.ts` uses, so "2 h" and "120 min" are the same
 * figure, and a check the reference implementation itself would fail is a check
 * nobody keeps.
 */
function planFigures(plan: Plan, ctx: DiscoveryContext): Set<string> {
  const money: number[] = [plan.totalCost.minor];
  const minutes: number[] = [0, ctx.availableMin, ctx.nowMin, Math.abs(plan.totalMin)];
  if (ctx.budget) money.push(ctx.budget.minor, Math.abs(ctx.budget.minor - plan.totalCost.minor));

  for (const stop of plan.stops) {
    const { fit } = stop;
    money.push(fit.cost.minor);
    if (fit.budget) money.push(fit.budget.minor, Math.abs(fit.cost.minor - fit.budget.minor));
    minutes.push(
      fit.travelMin,
      fit.activityMin,
      fit.bufferMin,
      fit.totalMin,
      fit.availableMin,
      Math.abs(fit.totalMin - fit.availableMin),
      stop.arriveMin,
      stop.departMin,
    );
  }
  for (const leg of plan.legs) minutes.push(leg.minutes);
  for (const row of plan.rejected) {
    if (row.shortfall === null) continue;
    if (row.unit === "minutes") minutes.push(Math.abs(row.shortfall));
    if (row.unit === "minor_units") money.push(Math.abs(row.shortfall));
  }
  return groundedFigures({ moneyMinor: money, minutes, percents: plan.stops.map((s) => s.fit.fitRatio * 100) });
}

/**
 * Recomputes the ledger from the plan it claims to describe and reports the
 * difference. Four things, all of them the ways a why-ledger rots: a stop or a
 * dropped candidate with no answer, an id the plan both selected and rejected, a
 * claim that no longer matches the numbers, and a figure in a sentence the plan
 * does not contain. That last one can fire on a freshly built ledger too, when
 * the engine's own rejection sentence quotes a number nothing else backs — which
 * is exactly the sentence a traveller would budget from.
 */
export function auditLedger(
  ledger: ExplanationLedger,
  plan: Plan,
  ctx: DiscoveryContext,
  opts: ExplainOptions = {},
): LedgerAudit {
  const violations: LedgerViolation[] = [];
  const expected = explainPlan(plan, ctx, opts);
  const stopIds = new Set(plan.stops.map((stop) => stop.experienceId));
  const rejectedIds = new Set(plan.rejected.map((row) => row.experienceId));

  for (const id of [...stopIds, ...rejectedIds]) {
    if (!ledger.byId.has(id)) {
      violations.push({ code: "missing_explanation", message: `No explanation for ${id}.`, experienceId: id });
    }
  }

  for (const item of ledger.explanations) {
    const selected = stopIds.has(item.experienceId);
    const dropped = rejectedIds.has(item.experienceId);
    if (!selected && !dropped) {
      violations.push({
        code: "missing_explanation",
        message: `${item.experienceId} is explained but the plan never mentions it.`,
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
        message: `${item.experienceId} no longer matches the plan: ${driftIn(item, derived)}.`,
        experienceId: item.experienceId,
      });
    }
  }

  const figures = planFigures(plan, ctx);
  const claims = [
    ...ledger.explanations.flatMap((item) => item.evidence.map((entry) => entry.claim)),
    ...ledger.explanations.map((item) => item.headline),
    ...ledger.relaxations.map((entry) => entry.claim),
  ];
  for (const claim of claims) {
    const bad = unsupportedFigures(claim, figures);
    if (bad.length > 0) {
      violations.push({
        code: "ungrounded_claim",
        message: `The plan holds no figure for "${bad[0]}" in: ${claim}`,
        experienceId: null,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
