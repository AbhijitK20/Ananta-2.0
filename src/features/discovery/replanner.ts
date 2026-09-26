/**
 * The replanner. `Plan` in, `ContextChange` in, engine `replan()` out — and
 * nothing else. We never hand-edit a plan, we never reorder a stop, and we never
 * recompute an objective. If the engine says the plan is wrong we believe it.
 *
 * The whole file exists to make one guarantee:
 *
 *   > A plan the traveller sees has parsed against the contract, passed
 *   > `validate()`, and has every stop in the catalogue.
 *
 * `admit()` is the single door: discover and replan both go through it, so there
 * is no path that can put an unvalidated plan in front of anyone. When it
 * refuses, the previous plan is returned untouched. That is the failure
 * behaviour, and it is the whole of `docs/FEATURES.md`'s "never expose a partial
 * plan" requirement: a plan with a missing `fit`, an unknown stop id, or a
 * drifted `contextId` is not degraded, it is discarded.
 *
 * Order per `docs/ARCHITECTURE.md` §9: context change, then deterministic
 * re-solve, then an independent validation, and only then a diff. A model is
 * not in this loop, so a replan is cheap enough to run on every slider tick.
 */
import {
  Plan,
  type ContextChange,
  type DiscoveryContext,
  type Experience,
  type Plan as PlanType,
  type Rejection,
  type ReplanResult,
  type ValidationResult,
  type WeightProfile,
} from "../../contracts";
import type { EnginePort } from "./engine";
import {
  assessDemand,
  mergeRejections,
  type DemandAssessment,
  type DemandMeta,
} from "./unmet";
import {
  type EditorChange,
  type EditorState,
  applyOps,
  type EditorOp,
  createContext,
  type ContextSeed,
} from "./context";
import { type PlanDiff, diffPlans, indexCatalogue } from "./diff";
import { type ActionInput, runAction, type DiscoveryAction } from "./actions";
import { type RealityChanged, buildRealityChanged } from "./reality";
import {
  type LoadExclusion,
  type LoadReport,
  leadViolation,
  loadOf,
  packWithinLoad,
  replanWithinLoad,
} from "./fatigue";

export type Violation = { code: string; message: string; at: string | null };

/** The contract's own default, restated because `RetrieveInput.limit` is required. */
const RETRIEVE_LIMIT = 120;

export type DiscoverySession = {
  /**
   * The creation-time context, never mutated. Principle 3: the panel diffs the
   * traveller's original intent against the newest plan, so this has to be a
   * separate object rather than a field the editor can reach.
   */
  intent: DiscoveryContext;
  state: EditorState;
  /** The last plan that passed `admit()`. Null until one does. */
  plan: PlanType | null;
  catalogue: ReadonlyMap<string, Experience>;
  weights: WeightProfile;
  lastDiff: PlanDiff | null;
  lastReality: RealityChanged | null;
  /**
   * How much the last admitted plan asked of the body, and the budget it was
   * measured against. Null only before the first plan. The UI reads this; it
   * never computes it, and it is not a mood ring — `budget.basis` is why the
   * plan passed or did not.
   */
  lastLoad: LoadReport | null;
  /** Stops the load model took off the list, with the sentence that said why. */
  lastExclusions: LoadExclusion[];
};

export type SessionInit = {
  engine: EnginePort;
  seed: ContextSeed;
  catalogue: readonly Experience[];
  /** From the bandit. Required, not defaulted: the engine owns the weights. */
  weights: WeightProfile;
};

export function createSession(init: SessionInit): DiscoverySession {
  const state = createContext(init.seed);
  return {
    intent: state.ctx,
    state,
    plan: null,
    catalogue: indexCatalogue(init.catalogue),
    weights: init.weights,
    lastDiff: null,
    lastReality: null,
    lastLoad: null,
    lastExclusions: [],
  };
}

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

export type Admitted =
  | { ok: true; plan: PlanType; validation: ValidationResult }
  | { ok: false; violations: Violation[]; validation: ValidationResult | null };

function zodViolation(error: { issues: { path: PropertyKey[]; message: string }[] }): Violation {
  const first = error.issues[0];
  return {
    code: "contract_violation",
    message: first ? `${first.path.join(".") || "plan"}: ${first.message}` : "does not match the contract",
    at: null,
  };
}

/**
 * Contract parse, then engine validation, then the two structural checks the
 * engine cannot make about a plan it did not build: every stop must resolve to
 * something the UI can render, and the plan must belong to this context. Then
 * the travel-load gate.
 *
 * The load check is last on purpose. It is an opinion about difficulty, the rest
 * are facts, so a plan that is broken in any other way is reported for that
 * reason instead of being argued with about walking. It is here at all because
 * `engine.validate` checks whether the plan is *true*, and no engine check
 * answers whether it is *doable* by the people who are actually going.
 */
function admit(
  engine: EnginePort,
  candidate: unknown,
  ctx: DiscoveryContext,
  catalogue: ReadonlyMap<string, Experience>,
): Admitted {
  const parsed = Plan.safeParse(candidate);
  if (!parsed.success) return { ok: false, violations: [zodViolation(parsed.error)], validation: null };
  const plan = parsed.data;

  const unknown = plan.stops.find((stop) => !catalogue.has(stop.experienceId));
  if (unknown) {
    return {
      ok: false,
      violations: [
        {
          code: "stop_not_in_catalogue",
          message: `Stop ${unknown.experienceId} is not in the catalogue.`,
          at: unknown.experienceId,
        },
      ],
      validation: null,
    };
  }
  if (plan.contextId !== ctx.id) {
    return {
      ok: false,
      violations: [
        {
          code: "context_drift",
          message: `Plan is for context ${plan.contextId}, not ${ctx.id}.`,
          at: plan.contextId,
        },
      ],
      validation: null,
    };
  }

  const validation = engine.validate(plan);
  if (!validation.ok) {
    return { ok: false, violations: validation.violations, validation };
  }

  const load = loadOf(plan, ctx, engine, catalogue);
  if (load.verdict !== "ok") {
    return {
      ok: false,
      violations: load.violations.map((entry) => ({ code: entry.code, message: entry.message, at: entry.at })),
      validation,
    };
  }
  return { ok: true, plan, validation };
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

export type DiscoverOutcome =
  | {
      ok: true;
      session: DiscoverySession;
      plan: PlanType;
      validation: ValidationResult;
      /** Travel load of the plan we are showing, and what it was measured against. */
      load: LoadReport;
      /** Stops the load model removed on the way here. */
      excluded: LoadExclusion[];
      /**
       * What the run meant for demand. `satisfied` when the traveller got stops,
       * `unmet` when candidates existed and every one was eliminated on a hard
       * constraint, `unserved` when nothing was planned and nothing is to blame.
       * A signal is only written when the caller passed `meta`, because the
       * contract row needs a traveller and a time.
       */
      demand: DemandAssessment;
    }
  | {
      ok: false;
      session: DiscoverySession;
      violations: Violation[];
      reason: string;
      load: LoadReport | null;
    };

/**
 * retrieve -> filter -> score -> pack -> admit. Pure engine calls, in that order.
 *
 * The one thing that is not an engine call is inside `packWithinLoad`: if the
 * packed plan asks more of this group than they can do, the offending stop comes
 * off the candidate list and the engine packs again. That is how "less walking"
 * stops being a note to self and becomes the plan.
 */
export function discover(
  engine: EnginePort,
  session: DiscoverySession,
  meta?: DemandMeta,
): DiscoverOutcome {
  const ctx = session.state.ctx;
  let packed: PlanType;
  let solved: ReturnType<typeof packWithinLoad>;
  let rejected: Rejection[] = [];
  let considered = 0;
  try {
    const shortlist = engine.retrieve({
      context: ctx,
      catalogue: [...session.catalogue.values()],
      limit: RETRIEVE_LIMIT,
    });
    considered = shortlist.length;
    const feasible = engine.filterFeasible(ctx, shortlist);
    // Kept because a plan that comes back empty is only evidence about the market
    // if we know which constraints eliminated the candidates.
    rejected = feasible.rejected;
    const byId = new Map(shortlist.map((item) => [item.id, item]));
    const items = feasible.passed
      .map((id) => byId.get(id))
      .filter((item): item is Experience => item !== undefined);
    const scores = engine.score(ctx, items, session.weights);
    const rank = new Map(scores.map((entry) => [entry.experienceId, entry.total]));
    // Score order, id as the tiebreak, so the packer gets a stable input and
    // the eval harness gets a reproducible one.
    const ordered = [...items].sort(
      (a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || a.id.localeCompare(b.id),
    );
    solved = packWithinLoad(engine, ctx, ordered, session.catalogue);
    packed = solved.plan;
  } catch (error) {
    return {
      ok: false,
      session,
      violations: [{ code: "engine_error", message: messageOf(error), at: null }],
      reason: "We could not build a plan for this window.",
      load: null,
    };
  }

  const gate = admit(engine, packed, ctx, session.catalogue);
  if (!gate.ok) {
    return {
      ok: false,
      session,
      violations: gate.violations,
      // A load refusal gets the real sentence, because "nowhere you can walk to"
      // is a different problem from "we made an error" and the traveller can act
      // on one of them.
      reason:
        solved.load.violations.length > 0
          ? leadViolation(solved.load)?.message ?? "We built a plan we could not stand behind, so there is nothing to show yet."
          : "We built a plan we could not stand behind, so there is nothing to show yet.",
      load: solved.load,
    };
  }
  return {
    ok: true,
    session: {
      ...session,
      plan: gate.plan,
      lastLoad: solved.load,
      lastExclusions: solved.excluded,
    },
    plan: gate.plan,
    validation: gate.validation,
    load: solved.load,
    excluded: solved.excluded,
    demand: assessDemand(
      {
        ctx,
        plan: gate.plan,
        // The engine may report a rejection in either place, and counting both
        // would inflate `topBlockingCount`.
        rejected: mergeRejections(rejected, gate.plan.rejected),
        considered,
      },
      meta,
    ),
  };
}

// ---------------------------------------------------------------------------
// Replan
// ---------------------------------------------------------------------------

export type ReplanOutcome =
  | {
      ok: true;
      session: DiscoverySession;
      plan: PlanType;
      change: ContextChange;
      diff: PlanDiff;
      reality: RealityChanged;
      validation: ValidationResult;
      /** Travel load of the plan we are showing, and the budget it was held to. */
      load: LoadReport;
      /** Stops the load model took off the list to get there. */
      excluded: LoadExclusion[];
      /**
       * The same verdict `discover` gives, on the same terms. A re-solve that
       * empties the plan is the strongest unmet-demand signal this product
       * produces: the traveller had something a minute ago and now has nothing,
       * and "nothing" here is a fact about supply, not about our engine.
       */
      demand: DemandAssessment;
    }
  | {
      ok: false;
      /** Unchanged. `session.plan` is still the last plan that passed. */
      session: DiscoverySession;
      change: ContextChange;
      violations: Violation[];
      reason: string;
      load: LoadReport | null;
    };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The previous plan scored against the NEW context, which neither plan carries:
 * `Plan.stressScore` was computed under the old window. It answers "was that
 * swap necessary, or did we churn?", so the panel can say so instead of leaving
 * the traveller to wonder. A throw here must not cost them a good plan, so it
 * degrades to null.
 */
function stressBefore(engine: EnginePort, plan: PlanType, ctx: DiscoveryContext): number | null {
  try {
    return engine.stress(plan, ctx).score;
  } catch {
    return null;
  }
}

/**
 * old plan -> context change -> engine replan -> validation -> new plan -> diff.
 *
 * `replanWithinLoad` is where the load model gets a vote: if the engine's answer
 * is over budget, the offending stop goes on `excludedIds` and the same change is
 * solved once more. One extra engine call, never a local re-solve.
 *
 * On any failure the session comes back untouched, so the caller can keep
 * rendering the previous plan and show `reason`. There is no partial-success
 * branch: a plan that fails `admit()` is not a degraded plan, it is no plan.
 */
export function replan(
  engine: EnginePort,
  session: DiscoverySession,
  change: ContextChange,
  /**
   * The context `session.plan` was solved under. The session handed in already
   * carries the NEW context, so this cannot be read off it; callers that applied
   * an edit have the old one. Defaults to the session's own context, which is
   * right whenever the plan was built from it.
   */
  prevCtx: DiscoveryContext = session.state.ctx,
  /** Attribution for the demand row. Without it the verdict is still reported. */
  meta?: DemandMeta,
): ReplanOutcome {
  const previous = session.plan;
  if (!previous) {
    return {
      ok: false,
      session,
      change,
      violations: [],
      reason: "There is no valid plan to adapt yet, so nothing was changed.",
      load: null,
    };
  }
  const ctx = session.state.ctx;

  let result: ReplanResult;
  let load: LoadReport;
  let excluded: LoadExclusion[];
  try {
    const solved = replanWithinLoad(engine, previous, ctx, change, session.catalogue);
    result = solved.result;
    load = solved.load;
    excluded = solved.excluded;
  } catch (error) {
    return {
      ok: false,
      session,
      change,
      violations: [{ code: "engine_error", message: messageOf(error), at: null }],
      reason: "The re-solve failed, so your plan is unchanged.",
      load: null,
    };
  }

  const gate = admit(engine, result.plan, ctx, session.catalogue);
  if (!gate.ok) {
    return {
      ok: false,
      session,
      change,
      violations: gate.violations,
      reason:
        load.violations.length > 0
          ? leadViolation(load)?.message ?? "The new plan did not hold up, so your previous one stands."
          : "The new plan did not hold up, so your previous one stands.",
      load,
    };
  }

  const diff = diffPlans(engine, previous, gate.plan, {
    catalogue: session.catalogue,
    change,
    travelMode: ctx.travelMode,
    origin: ctx.origin.point,
  });
  const reality = buildRealityChanged({
    change,
    diff,
    before: previous,
    after: gate.plan,
    nextCtx: ctx,
    prevCtx,
    intent: session.intent,
    enginePreservedIntent: result.preservedIntent,
    stressBefore: stressBefore(engine, previous, ctx),
    // Cut for load, so the panel can say "we left this out because you said
    // less walking" instead of quoting an engine rejection about a constraint
    // the traveller never mentioned.
    excluded,
  });

  return {
    ok: true,
    session: {
      ...session,
      plan: gate.plan,
      lastDiff: diff,
      lastReality: reality,
      lastLoad: load,
      lastExclusions: excluded,
    },
    plan: gate.plan,
    change,
    diff,
    reality,
    validation: gate.validation,
    load,
    excluded,
    demand: assessDemand(
      {
        ctx,
        plan: gate.plan,
        // A re-solve does not go through `filterFeasible` again, so the plan's own
        // rejections are the whole record. `considered` is what the previous plan
        // was serving: an empty result from three stops is a different fact from an
        // empty result from nothing.
        rejected: gate.plan.rejected,
        considered: previous.stops.length,
      },
      meta,
    ),
  };
}

// ---------------------------------------------------------------------------
// The one call a chip makes
// ---------------------------------------------------------------------------

export type ActionOutcome =
  | ReplanOutcome
  | { ok: false; session: DiscoverySession; reason: string; load: null };

/**
 * Chip -> editor op -> context change -> replan. The session's editor state is
 * only advanced once the new plan has been admitted, so a rejected replan also
 * rolls the context back: an "indoor only" toggle that could not be honoured
 * must not leave a context that claims to be indoors-only.
 */
export function applyAction(
  engine: EnginePort,
  session: DiscoverySession,
  action: DiscoveryAction,
  meta?: DemandMeta,
): ActionOutcome {
  return applyEditorChange(engine, session, runAction(action, actionInput(session)), meta);
}

export function actionInput(session: DiscoverySession): ActionInput {
  return {
    state: session.state,
    plan: session.plan,
    nameOf: (id) => session.catalogue.get(id)?.name ?? "That place",
  };
}

/** The generic path: any editor edit, then a replan. Used by chips and sliders. */
export function applyEditorChange(
  engine: EnginePort,
  session: DiscoverySession,
  edit: EditorChange | null,
  meta?: DemandMeta,
): ActionOutcome {
  if (!edit || !edit.change) {
    return { ok: false, session, reason: "That would not change anything, so nothing was re-solved.", load: null };
  }
  const candidate: DiscoverySession = { ...session, state: edit.state };
  const outcome = replan(engine, candidate, edit.change, session.state.ctx, meta);
  return outcome.ok ? outcome : { ...outcome, session };
}

/** Convenience for the editor panel and the chat sidecar: ops in, plan out. */
export function applyOpsAndReplan(
  engine: EnginePort,
  session: DiscoverySession,
  ops: readonly EditorOp[],
  meta?: DemandMeta,
): ActionOutcome {
  return applyEditorChange(engine, session, applyOps(session.state, ops), meta);
}
