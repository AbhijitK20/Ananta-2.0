/**
 * `src/features/explain/**` — the why-ledger's data layer.
 *
 * Four decision producers in the engine (`filterFeasible`, `computeFit`, `score`,
 * `pack`) already publish what they decided and why: a `Rejection` per hard-gate
 * failure, a `Fit` with per-constraint checks, `ScoreBreakdown.components` with the
 * weights applied, and `PlanStop.why`. This folder turns those into sentences a
 * traveller can act on, covers the candidates that were scored and then had no
 * room, and audits the result back against the data.
 *
 * Nothing here decides anything, and nothing here is keyed on an experience id.
 * `docs/FEATURES.md` §4 is the spec; `src/features/discovery/diff.ts` is the
 * precedent — reasons come from the engine, and the only fallback is a sentence
 * that says what is true and no more.
 *
 * ```ts
 * const ledger = explainPlan(plan, ctx, { catalogue, fits, scores });
 * const why = ledger.byId.get(tappedId);           // selected | rejected | considered
 * const props = whyLedgerProps(ledger, tappedId, rejectionsById, { onAction });
 * const gate = auditLedger(ledger, plan, ctx, { catalogue, fits, scores });
 * ```
 */
export {
  auditLedger,
  explainOne,
  explainPlan,
  rejectedIds,
  scoreCandidates,
  type Evidence,
  type EvidencePolarity,
  type EvidenceSource,
  type EvidenceUnit,
  type ExplainOptions,
  type Explanation,
  type ExplanationLedger,
  type LedgerAudit,
  type LedgerSource,
  type LedgerViolation,
  type MustSee,
  type Outcome,
  type RecoveryAction,
  type ScoreFn,
} from "./evidence";

export {
  explainSwaps,
  ledgerSummary,
  outcomeLabel,
  swapCost,
  whyLedgerProps,
  type LedgerHandlers,
  type SwapExplanation,
  type WhyLedgerProps,
} from "./ledger";
