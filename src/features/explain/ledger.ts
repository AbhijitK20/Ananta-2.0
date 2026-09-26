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

import type { Explanation, ExplanationLedger, Outcome, RecoveryAction } from "./evidence";

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
