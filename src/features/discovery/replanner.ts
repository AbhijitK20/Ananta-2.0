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
  type ReplanResult,
  type ValidationResult,
  type WeightProfile,
} from "../../contracts";
import type { EnginePort } from "./engine";
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
 * something the UI can render, and the plan must belong to this context.
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
  return { ok: true, plan, validation };
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

export type DiscoverOutcome =
  | { ok: true; session: DiscoverySession; plan: PlanType; validation: ValidationResult }
  | { ok: false; session: DiscoverySession; violations: Violation[]; reason: string };

/** retrieve -> filter -> score -> pack -> admit. Pure engine calls, in that order. */
export function discover(engine: EnginePort, session: DiscoverySession): DiscoverOutcome {
  const ctx = session.state.ctx;
  let packed: PlanType;
  try {
    const shortlist = engine.retrieve({
      context: ctx,
      catalogue: [...session.catalogue.values()],
      limit: RETRIEVE_LIMIT,
    });
    const feasible = engine.filterFeasible(ctx, shortlist);
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
    packed = engine.pack(ctx, ordered);
  } catch (error) {
    return {
      ok: false,
      session,
      violations: [{ code: "engine_error", message: messageOf(error), at: null }],
      reason: "We could not build a plan for this window.",
    };
  }

  const gate = admit(engine, packed, ctx, session.catalogue);
  if (!gate.ok) {
    return {
      ok: false,
      session,
      violations: gate.violations,
      reason: "We built a plan we could not stand behind, so there is nothing to show yet.",
    };
  }
  return { ok: true, session: { ...session, plan: gate.plan }, plan: gate.plan, validation: gate.validation };
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
    }
  | {
      ok: false;
      /** Unchanged. `session.plan` is still the last plan that passed. */
      session: DiscoverySession;
      change: ContextChange;
      violations: Violation[];
      reason: string;
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
): ReplanOutcome {
  const previous = session.plan;
  if (!previous) {
    return {
      ok: false,
      session,
      change,
      violations: [],
      reason: "There is no valid plan to adapt yet, so nothing was changed.",
    };
  }
  const ctx = session.state.ctx;

  let result: ReplanResult;
  try {
    result = engine.replan(previous, ctx, change);
  } catch (error) {
    return {
      ok: false,
      session,
      change,
      violations: [{ code: "engine_error", message: messageOf(error), at: null }],
      reason: "The re-solve failed, so your plan is unchanged.",
    };
  }

  const gate = admit(engine, result.plan, ctx, session.catalogue);
  if (!gate.ok) {
    return {
      ok: false,
      session,
      change,
      violations: gate.violations,
      reason: "The new plan did not hold up, so your previous one stands.",
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
  });

  return {
    ok: true,
    session: { ...session, plan: gate.plan, lastDiff: diff, lastReality: reality },
    plan: gate.plan,
    change,
    diff,
    reality,
    validation: gate.validation,
  };
}

// ---------------------------------------------------------------------------
// The one call a chip makes
// ---------------------------------------------------------------------------

export type ActionOutcome = ReplanOutcome | { ok: false; session: DiscoverySession; reason: string };

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
): ActionOutcome {
  return applyEditorChange(engine, session, runAction(action, actionInput(session)));
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
): ActionOutcome {
  if (!edit || !edit.change) {
    return { ok: false, session, reason: "That would not change anything, so nothing was re-solved." };
  }
  const candidate: DiscoverySession = { ...session, state: edit.state };
  const outcome = replan(engine, candidate, edit.change, session.state.ctx);
  return outcome.ok ? outcome : { ...outcome, session };
}

/** Convenience for the editor panel and the chat sidecar: ops in, plan out. */
export function applyOpsAndReplan(
  engine: EnginePort,
  session: DiscoverySession,
  ops: readonly EditorOp[],
): ActionOutcome {
  return applyEditorChange(engine, session, applyOps(session.state, ops));
}
