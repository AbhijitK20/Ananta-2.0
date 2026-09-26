/**
 * The `WhyLedger` adapter.
 *
 * `src/components/fit/WhyLedger.tsx` is Karan's and is not edited here. This file
 * is the other half of it: the data, in exactly the shape that component already
 * declares. Two props it accepts are passed by nobody in the running app —
 *
 *   `why`               the engine's ranked sentences for a stop
 *   `rejectionActions`  the recovery actions, as `{ label, onSelect }` pairs
 *
 * — and both are things only this layer can produce, because both are derived from
 * the decision record. `docs/FEATURES.md` §4 asks for "up to three actions, each a
 * real mutation of the DiscoveryContext"; until the adapter exists that
 * requirement is unmet no matter how good the component is.
 *
 * WHY THE TYPES ARE RESTATED RATHER THAN IMPORTED. `WhyLedgerProps` is declared
 * here structurally, and `ledger.test.ts` proves the two agree by assigning an
 * adapter result to the component's own prop type. That keeps the dependency
 * pointing one way — a feature does not import a component — while still making
 * drift a compile error instead of a silently empty panel. If the component's
 * props change, that test fails with the exact field name, which is the moment to
 * talk rather than the moment a demo shows a blank box.
 *
 * NOTHING IS INVENTED HERE. Every string is an `Evidence.claim` or a
 * `Rejection.message` that the engine wrote, and every action label is a
 * `RecoveryAction` label. The one substitution this file makes is documented on
 * `whyLedgerProps` below.
 */
import type { PlanStop, Rejection, ScoreBreakdown } from "../../contracts";

import type { Evidence, Explanation, ExplanationLedger, Outcome, RecoveryAction } from "./evidence";

/**
 * Mirrors `WhyLedgerProps`. See the file header: kept structurally identical and
 * proven equal by `ledger.test.ts` rather than imported, so the dependency never
 * points from a feature at a component.
 */
export type WhyLedgerProps = {
  /** The scored stop. Omit to render only the "why not that" half. */
  score?: ScoreBreakdown;
  /** The ranked sentences the engine already wrote. */
  why?: PlanStop["why"];
  /** One or more rejections for experiences that did not make it. */
  rejections?: ReadonlyArray<Rejection>;
  /** Names, so a rejection reads as a sentence about a place. */
  rejectionNames?: Readonly<Record<string, string>>;
  /** Recovery actions, keyed by experience id. */
  rejectionActions?: Readonly<
    Record<string, ReadonlyArray<{ label: string; onSelect: () => void }>>
  >;
  className?: string;
};

export type LedgerHandlers = {
  /**
   * Called with the `DiscoveryContext` patch the action represents. The handler
   * owns the mutation; this layer only computes the patch, so the allowed blast
   * radius stays the caller's.
   */
  onAction?: (action: RecoveryAction, experienceId: string) => void;
};

/** A phrase for the outcome, for a sheet title or a badge. Never a verdict. */
const OUTCOME_LABEL: Record<Outcome, string> = {
  selected: "Why this",
  rejected: "Why not this",
  considered: "Why not this one",
  not_considered: "Why nothing is said about this",
};

/** One-line summary of what the ledger covers, for a heading or a summary row. */
export function ledgerSummary(ledger: ExplanationLedger): string {
  const count = (outcome: Outcome): number => ledger.explanations.filter((item) => item.outcome === outcome).length;
  const parts = [
    `${count("selected")} in the plan`,
    `${count("rejected")} did not fit`,
    `${count("considered")} scored but not taken`,
  ];
  const unseen = count("not_considered");
  if (unseen > 0) parts.push(`${unseen} never evaluated`);
  return `${parts.join(", ")}.`;
}

export function outcomeLabel(outcome: Outcome): string {
  return OUTCOME_LABEL[outcome];
}

/**
 * Build the prop object for one tapped experience.
 *
 * `rejections` is the tapped candidate's own rows, and nothing else: the ledger
 * already renders "N did not fit. The rest are in the full ledger." past three, and
 * mixing every other candidate's failure into this one place would bury the answer
 * the traveller actually asked for. The full set is one call away via
 * `explainPlan`.
 *
 * The one substitution: `why` is the engine's own `PlanStop.why` when it published
 * any. For a candidate the packer did not take there are no lines, because `why`
 * belongs to a `PlanStop` and it was never packed — so the ledger supplies its own
 * derived ranking, which is the same sentences the sheet would show under "Why
 * this" anyway. Each line still traces to a `ScoreComponent`, and the audit holds
 * the whole set to the data.
 *
 * `onAction` is optional. Without it the actions are omitted rather than rendered
 * as buttons that do nothing, which is the difference between a read-only panel and
 * a broken one.
 */
export function whyLedgerProps(
  ledger: ExplanationLedger,
  experienceId: string,
  rejectionsById: ReadonlyMap<string, Rejection[]>,
  handlers: LedgerHandlers = {},
): WhyLedgerProps {
  const explanation = ledger.byId.get(experienceId);
  if (!explanation) return {};

  const rejections = rejectionsById.get(experienceId) ?? [];
  // A rejected candidate has no place in the "arithmetic" panel: `WhyLedger`
  // renders `score` under "Why this", and showing a breakdown for something the
  // plan refused would be answering a question nobody asked.
  const score = explanation.outcome === "rejected" ? undefined : (explanation.score ?? undefined);
  const why = explanation.why.length > 0 ? explanation.why : derivedWhy(explanation);

  const props: WhyLedgerProps = {
    rejections,
    why: why.length > 0 ? why : undefined,
  };
  if (score) props.score = score;

  if (explanation.name) props.rejectionNames = { [experienceId]: explanation.name };

  if (handlers.onAction && explanation.actions.length > 0) {
    props.rejectionActions = {
      [experienceId]: explanation.actions.map((action) => ({
        label: action.label,
        onSelect: () => handlers.onAction?.(action, experienceId),
      })),
    };
  }

  return props;
}

/**
 * The ranked lines for a candidate with no `PlanStop.why`: its score components in
 * the ledger's own order, which puts costs first. Deliberately not the `Fit` meter
 * lines — those are shown by `FitMeter`, and repeating them here would be the same
 * number twice in one sheet.
 */
function derivedWhy(explanation: Explanation): string[] {
  return explanation.evidence
    .filter((item) => item.source === "score" || item.source === "pack")
    .map((item) => item.claim)
    .filter((claim) => claim.length > 0);
}

// ---------------------------------------------------------------------------
// Swaps — why the plan changed under the traveller
// ---------------------------------------------------------------------------

/**
 * One row per `ReplanResult.swap`, with both sides of the trade attached.
 *
 * A swap is the most alarming thing the product does — the itinerary the traveller
 * approved changed without them asking — so it needs an answer at least as specific
 * as a fresh recommendation gets. Three things are reported and nothing is
 * inferred: the engine's own `reason`, the signed `scoreDelta`, and the constraint
 * that actually killed the stop that left. The engine's check order is the
 * precedence, so the first constraint is the one that stopped it.
 */
export type SwapExplanation = {
  removedId: string | null;
  addedId: string | null;
  /** `Swap.reason`, verbatim. The engine wrote it next to the decision. */
  reason: string;
  /** The trade the swap made in score. Negative means it scored worse. */
  scoreDelta: number;
  outcome: "replaced" | "added" | "removed";
  /** The explanation of the stop that left, when the previous ledger has one. */
  removed: Explanation | null;
  /** The explanation of the stop that arrived, when the new ledger has one. */
  added: Explanation | null;
  /** What became of the stop that left, in one sentence. */
  reasonDetail: string;
  evidence: Evidence[];
};

const MAX_SWAP_EVIDENCE = 3;

/**
 * Explain every swap in a replan.
 *
 * Both ledgers are required, and the reason is not laziness: "why did this replace
 * that" is a question about the DIFFERENCE, and one side of a difference is not
 * answerable from the other. A missing side yields `null` rather than a guess, so
 * the UI can say the previous answer is gone instead of inventing one.
 */
export function explainSwaps(
  swaps: ReadonlyArray<{
    removedId: string | null;
    addedId: string | null;
    reason: string;
    scoreDelta: number;
  }>,
  before: ExplanationLedger,
  after: ExplanationLedger,
): SwapExplanation[] {
  return swaps.map((swap) => {
    const removed = swap.removedId === null ? null : (before.byId.get(swap.removedId) ?? null);
    const added = swap.addedId === null ? null : (after.byId.get(swap.addedId) ?? null);

    const evidence: Evidence[] = [
      {
        key: "swap:score_delta",
        // Signed and explicit. A swap that scored slightly worse is still the right
        // call, and hiding the cost of it is how a replanner loses trust.
        claim:
          swap.scoreDelta === 0
            ? "The swap cost nothing measurable in score."
            : swap.scoreDelta < 0
              ? `The swap cost ${Math.abs(swap.scoreDelta)} of score, and it was still the right call.`
              : `The swap gained ${swap.scoreDelta} of score.`,
        polarity: swap.scoreDelta < 0 ? "opposes" : "neutral",
        source: "pack",
        value: swap.scoreDelta,
        unit: "points",
        weight: null,
        learned: false,
        provenance: null,
      },
    ];

    // The blocking constraint of the stop that left, carried across verbatim. This
    // is the sentence that answers "why did I lose that one", and the gate wrote it,
    // not this file.
    if (removed?.blocking) evidence.push(removed.blocking);
    // And the caveat on the stop that arrived, if it has one, so a swap is never
    // presented to the traveller as a straight upgrade.
    const caveat = added?.evidence.find((item) => item.polarity === "opposes");
    if (caveat) evidence.push(caveat);

    const outcome: SwapExplanation["outcome"] =
      swap.removedId !== null && swap.addedId !== null
        ? "replaced"
        : swap.addedId !== null
          ? "added"
          : "removed";

    return {
      removedId: swap.removedId,
      addedId: swap.addedId,
      reason: swap.reason,
      scoreDelta: swap.scoreDelta,
      outcome,
      removed,
      added,
      reasonDetail: detailFor(outcome, removed, added),
      evidence: evidence.slice(0, MAX_SWAP_EVIDENCE),
    };
  });
}

/** One sentence about what happened, assembled only from outcomes already known. */
function detailFor(outcome: SwapExplanation["outcome"], removed: Explanation | null, added: Explanation | null): string {
  const name = (item: Explanation | null): string => item?.name ?? "the stop";
  if (outcome === "replaced") return `${name(removed)} made way for ${name(added)}.`;
  if (outcome === "added") return `${name(added)} was added${added?.blocking ? "" : " to a plan that had room for it"}.`;
  return `${name(removed)} came out and nothing replaced it.`;
}

/** Total score cost of a set of swaps, for a panel summary. Signed. */
export function swapCost(swaps: readonly SwapExplanation[]): number {
  return Math.round(swaps.reduce((sum, swap) => sum + swap.scoreDelta, 0) * 100) / 100;
}
