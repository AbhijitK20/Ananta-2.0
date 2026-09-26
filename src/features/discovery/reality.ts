/**
 * The "reality changed" panel: one object the UI renders without doing any
 * arithmetic, and without a model in the loop.
 *
 * The panel answers four questions and nothing else:
 *   REMOVED / ADDED / UNCHANGED / REASON
 *
 * `REASON` is the change's own sentence plus the engine's blocking constraint
 * for the first thing that left, so it is the two facts a traveller needs —
 * "rain started" and "needs 40 min more than you have left" — and not a
 * paragraph. Every sentence in here is either written here with real numbers
 * interpolated, or written by the engine in a `Rejection.message` or a
 * `PlanStop.why`. `docs/FEATURES.md` §4 lets a model narrate this later; nothing
 * in this file waits for that.
 *
 * `intent` is the visible half of principle 3. It is built from the
 * creation-time context the session keeps, never from the current one, so the
 * panel can honestly say what the traveller is still asking for after the plan
 * has been re-solved five times.
 */
import type { ContextChange, DiscoveryContext, Plan, RelaxationApplied } from "@/contracts";
import type { PlanDiff } from "./diff";
import type { LoadExclusion } from "./fatigue";
import { hm, money, plural } from "./format";

/** The swap budget from `docs/EVAL_SPEC.md`. Over it is a finding, not a state. */
export const SWAP_BUDGET = 2;

export type PlanShape = {
  stops: number;
  totalMin: number;
  availableMin: number;
  cost: number;
  currency: string;
  utilisation: number;
  stressScore: number;
};

export type RealityChanged = {
  change: ContextChange;
  /** The panel headline: what happened, and what it killed. */
  reason: string;
  swapCount: number;
  removed: PlanDiff["removed"];
  added: PlanDiff["added"];
  unchanged: PlanDiff["unchanged"];
  before: PlanShape;
  after: PlanShape;
  /**
   * The old plan's stress under the NEW context, which `Plan.stressScore` cannot
   * tell you because it was scored under the old one. Null if the engine could
   * not answer. Without it, a swap and a pointless churn look identical.
   */
  stressBefore: number | null;
  /** "Still looking for: ..." — from the creation-time context. */
  intent: string[];
  /** False only if something overwrote `DiscoveryContext.original`. */
  intentPreserved: boolean;
  relaxations: RelaxationApplied[];
  /**
   * Stops the travel-load model took off the list, each with the sentence that
   * justified it. Separate from `removed`, because the engine's own rejection
   * for these says "excluded by traveller" or similar and the traveller did not
   * exclude them — we did, because the group cannot walk that far.
   */
  excludedForLoad: LoadExclusion[];
  /** The single highest-impact fix, from the top stress factor. */
  rescue: string | null;
  warnings: string[];
};

export type RealityInput = {
  change: ContextChange;
  diff: PlanDiff;
  before: Plan;
  after: Plan;
  nextCtx: DiscoveryContext;
  /**
   * The context `before` was actually produced under. Not `intent` and not
   * `nextCtx`: after a time edit the old plan was solved against the old window,
   * and shaping it with either of those reports a before-state the traveller was
   * never shown.
   */
  prevCtx: DiscoveryContext;
  intent: DiscoveryContext;
  enginePreservedIntent: boolean;
  stressBefore: number | null;
  excluded?: LoadExclusion[];
};

function shapeOf(plan: Plan, ctx: DiscoveryContext): PlanShape {
  return {
    stops: plan.stops.length,
    totalMin: plan.totalMin,
    availableMin: ctx.availableMin,
    cost: plan.totalCost.minor,
    currency: plan.totalCost.currency,
    utilisation: plan.utilisation,
    stressScore: plan.stressScore,
  };
}

/** The original ask, rebuilt from the context the session started with. */
export function intentLines(intent: DiscoveryContext): string[] {
  const lines: string[] = [];
  if (intent.interests.length > 0) lines.push(intent.interests.join(", "));
  for (const request of intent.requests) lines.push(request.pos);
  if (intent.childAges.length > 0) {
    lines.push(`${plural(intent.childAges.length, "child", "children")} in the group`);
  }
  lines.push(`${hm(intent.original.availableMin)} from ${intent.origin.label}`);
  if (intent.original.budget) lines.push(`under ${money(intent.original.budget)}`);
  return lines;
}

function headline(change: ContextChange, diff: PlanDiff): string {
  if (diff.removed.length === 0) return `${change.narrative} Nothing had to change.`;
  const cause = diff.removed[0]?.reason;
  return cause ? `${change.narrative} ${cause}` : change.narrative;
}

function warningsFor(diff: PlanDiff, intentPreserved: boolean, enginePreserved: boolean): string[] {
  const warnings: string[] = [];
  if (diff.swapCount > SWAP_BUDGET) {
    warnings.push(
      `${plural(diff.swapCount, "swap", "swaps")} for one change. ${SWAP_BUDGET} is the budget, so the engine is wrong here.`,
    );
  }
  if (!intentPreserved) warnings.push("The original request was overwritten. It must never be.");
  if (!enginePreserved) warnings.push("The engine reports the original intent was not preserved.");
  return warnings;
}

export function buildRealityChanged(input: RealityInput): RealityChanged {
  const { change, diff, before, after, nextCtx, intent } = input;
  const intentPreserved = JSON.stringify(intent.original) === JSON.stringify(nextCtx.original);
  const rescue = after.stressFactors.find((factor) => factor.rescue)?.rescue ?? null;

  return {
    change,
    reason: headline(change, diff),
    swapCount: diff.swapCount,
    removed: diff.removed,
    added: diff.added,
    unchanged: diff.unchanged,
    before: shapeOf(before, input.prevCtx),
    after: shapeOf(after, nextCtx),
    stressBefore: input.stressBefore,
    intent: intentLines(intent),
    intentPreserved,
    relaxations: after.relaxations,
    excludedForLoad: input.excluded ?? [],
    rescue,
    warnings: warningsFor(diff, intentPreserved, input.enginePreservedIntent),
  };
}
