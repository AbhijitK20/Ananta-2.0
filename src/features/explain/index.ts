/**
 * `src/features/explain/**` — the why-ledger's data layer.
 *
 * Four decision producers in the engine (`filterFeasible`, `computeFit`, `score`,
 * `pack`) already publish what they decided and why: a `Rejection` per hard-gate
 * failure, a `Fit` with per-constraint checks, `ScoreBreakdown.components` with the
 * weights applied, and `PlanStop.why`. This folder turns those four into sentences
 * a traveller can act on, and audits the result back against the plan.
 *
 * Nothing here decides anything, and nothing here is keyed on an experience id.
 * `docs/FEATURES.md` §4 is the spec; `src/features/discovery/diff.ts` is the
 * precedent — reasons come from the engine, and the only fallback is a sentence
 * that says what is true and no more.
 *
 * ```ts
 * const ledger = explainPlan(plan, ctx, { catalogue });
 * const why = ledger.byId.get(tappedId);          // selected or rejected
 * const gate = auditLedger(ledger, plan, ctx);    // refuse to show it if !gate.ok
 * ```
 */
export {
  auditLedger,
  explainOne,
  explainPlan,
  type Evidence,
  type EvidencePolarity,
  type EvidenceSource,
  type EvidenceUnit,
  type ExplainOptions,
  type Explanation,
  type ExplanationLedger,
  type LedgerAudit,
  type LedgerViolation,
  type RecoveryAction,
} from "./evidence";
