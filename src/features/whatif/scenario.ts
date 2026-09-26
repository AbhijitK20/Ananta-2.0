/**
 * What-if simulation. A counterfactual trip is answered by RE-PLANNING, never by
 * describing. The whole claim of this file is that "what if I had ₹500 more?"
 * runs `discover()` — retrieve, filter, score, pack, validate — over a cloned
 * context, and then diffs the engine's answer against the plan the traveller
 * already has.
 *
 * Why that distinction matters more than it sounds: a generated sentence about
 * what would happen is unfalsifiable. The traveller cannot check it, so when it
 * is wrong nothing tells them. A plan is checkable — every stop resolves to a
 * real catalogue row, every number in it came out of the solver, and the engine
 * validated it independently. So the answer is always a `Plan`, and the prose is
 * only ever arithmetic on two of them.
 *
 * The seven steps, and where each one lives:
 *
 *   1. clone          cloneSession()          deep copy, re-parsed by the contract
 *   2. patch          opsFor()                the live editor, so a what-if and a
 *                                              real edit cannot diverge
 *   3. plan           discover()              THE REAL PLANNER, full re-solve
 *   4. validate       buildRealityChanged()   + the engine's own validate() inside
 *                                              discover()'s admit()
 *   5. compare        diffPlans()             the same deterministic diff the
 *                                              "reality changed" panel uses
 *   6/7. report       ScenarioResult          added/removed, budget/time/walking/fit
 *
 * Step 3 uses `discover` and NOT `replan`, and that is the one real design call
 * here. `replan` is a minimal-swap adaptation: it assumes the traveller has
 * already committed to the stops in the plan. A what-if has no such commitment —
 * "what if I had ₹500 more?" is only interesting if the planner is free to keep
 * all three current stops AND add a fourth, which a minimal-swap replan would
 * refuse to consider because it is only allowed to swap up to two. So the
 * hypothetical is packed from scratch over the same catalogue, and only then
 * diffed.
 *
 * **The live trip is never mutated.** Not by convention — by construction:
 *
 *   - `cloneSession` deep-copies `state` and `intent` and re-runs them through
 *     `DiscoveryContext.parse`, so the clone is structurally incapable of sharing
 *     a nested object with the original.
 *   - Everything downstream receives the clone. The live `session` object itself
 *     is never passed to `discover`; only its `plan` is read, by `diffPlans` and
 *     `engine.stress`, both of which are pure.
 *   - `simulate` returns no session at all, so there is nothing for a caller to
 *     adopt. The hypothetical plan is a value, and the live plan is a different
 *     value.
 *
 * `__tests__/whatif.test.ts` deep-freezes the live session before simulating, so
 * any write attempt anywhere in this path throws instead of passing quietly.
 */
import {
  DiscoveryContext,
  type ContextChange,
  type Plan,
  type ValidationResult,
  type WeatherNow,
} from "../../contracts";
// The discovery feature's own modules rather than its barrel. Everything used
// here is the real planner and the real diff, re-used as-is; importing the
// specific modules just keeps this feature coupled to the six files it actually
// needs instead of to whatever else `src/features/discovery` grows.
import { type EditorOp, type EditorState, applyOps } from "../discovery/context";
import { diffPlans } from "../discovery/diff";
import type { EnginePort } from "../discovery/engine";
import { hm, money } from "../discovery/format";
import { type RealityChanged, buildRealityChanged } from "../discovery/reality";
import { type DiscoverySession, type Violation, discover } from "../discovery/replanner";
import { type GateChange, gateChanges } from "./gates";

// ---------------------------------------------------------------------------
// 1. Clone
// ---------------------------------------------------------------------------

/**
 * A scenario's trip, deep-copied.
 *
 * `structuredClone` is the stdlib answer and it is enough, because a
 * `DiscoveryContext` is plain JSON-able data by construction. The second half of
 * this function is the part that earns its keep: re-parsing through the
 * contract means a clone that has drifted fails HERE, loudly, instead of turning
 * into a confusing solver result three frames later.
 *
 * `plan` is shared by reference on purpose. It is read-only everywhere in this
 * path, and `discover` replaces it wholesale with a freshly parsed `Plan`, so
 * there is no object the hypothetical and the live trip could both write to.
 *
 * The rest of the session is spread rather than re-enumerated. Fields are added
 * to `DiscoverySession` as features land, and a hand-written copy of the shape
 * would silently drop each new one — the clone would quietly stop being a clone
 * of the session it came from. Only the two mutable editor fields are rebuilt.
 */
function cloneSession(session: DiscoverySession): DiscoverySession {
  return {
    ...session,
    intent: DiscoveryContext.parse(structuredClone(session.intent)),
    state: {
      ctx: DiscoveryContext.parse(structuredClone(session.state.ctx)),
      prefs: { ...session.state.prefs },
    },
    // The last diff and the last panel describe the LIVE plan, so the clone does
    // not claim them. Everything else — `plan`, `catalogue`, `weights` — is
    // carried across read-only: the hypothetical starts from the same trip and
    // the same catalogue, and `discover` replaces `plan` with a freshly parsed
    // object rather than editing it.
    lastDiff: null,
    lastReality: null,
  };
}

// ---------------------------------------------------------------------------
// 2. The hypothetical patch
// ---------------------------------------------------------------------------

/**
 * `max_walk_<metres>m`, e.g. "I do not want to walk more than 1 km" lowers to
 * `max_walk_1000m`.
 *
 * `DiscoveryContext` has no walking-distance field and the contract is frozen,
 * so this is the same bargain `context.ts` already struck for indoor-only and
 * walking tolerance: an open-vocabulary `avoid` token that the engine must
 * honour. The honest fix is one optional numeric field on `DiscoveryContext`,
 * raised in standup.
 *
 * The prefix matters. It is what makes the token idempotent — re-simulating with
 * a 500 m cap has to replace the 1000 m one, not stack on top of it — and it is
 * what `walkCapOf` reads back so the result can be CHECKED rather than trusted.
 */
export const WALK_CAP_PREFIX = "max_walk_";
const WALK_CAP_TOKEN = /^max_walk_(\d+)m$/;

export const walkCapToken = (metres: number): string =>
  `${WALK_CAP_PREFIX}${Math.max(0, Math.round(metres))}m`;

/** The cap the hypothetical asked for, read back out of the frozen context. */
export function walkCapOf(ctx: DiscoveryContext): number | null {
  for (const token of ctx.avoid) {
    const hit = WALK_CAP_TOKEN.exec(token);
    if (hit?.[1]) return Number(hit[1]);
  }
  return null;
}

const CONDITION_WORDS: Record<WeatherNow["condition"], string> = {
  clear: "Clear skies",
  cloudy: "Overcast",
  light_rain: "Light rain",
  heavy_rain: "Heavy rain",
  storm: "A storm",
  heat: "Peak heat",
  wind: "High wind",
};

/**
 * One axis of "what if", as data.
 *
 * `budget_delta` is separate from `budget` on purpose: "₹500 more" and "₹2000"
 * are different questions, and the traveller who asks the first already told us
 * the second. Scalars are absolute; deltas are relative to the live context.
 */
export type ScenarioEdit =
  | { kind: "budget"; minor: number | null }
  | { kind: "budget_delta"; minor: number }
  | { kind: "time"; availableMin: number }
  | { kind: "time_delta"; minutes: number }
  | { kind: "weather"; condition: WeatherNow["condition"]; tempC?: number }
  | { kind: "walk_cap_m"; metres: number }
  | { kind: "indoor_only"; on: boolean }
  | { kind: "exclude"; experienceIds: string[] };

/** Edits that cannot apply to this context, with the sentence to show for it. */
type Refusal = { reason: string };

/**
 * The hypothetical, expressed in the live editor's own `EditorOp`s.
 *
 * This is the load-bearing reuse in the file. If what-if had its own notion of
 * "set the budget", a scenario and a slider drag would be two different ways of
 * making the same edit, and they would drift the first time `withOp` grew a
 * field. Here a scenario is literally an editor op on a cloned state, so
 * `classifyChange` labels it with the same ten `ContextChange.kind`s the real
 * panel uses, and the swap-diff reasons come out already written.
 *
 * Returns a `Refusal` rather than a silently wrong op for the one case where the
 * question does not make sense: there is no budget to add money to. Turning
 * "no limit" into "₹500" would be a restriction dressed up as a loosening, and
 * the plan that came back would be wrong in a way nobody could see.
 */
function opsFor(
  state: EditorState,
  edits: readonly ScenarioEdit[],
): EditorOp[] | Refusal {
  const ops: EditorOp[] = [];
  for (const edit of edits) {
    switch (edit.kind) {
      case "budget":
        ops.push({
          kind: "set_budget",
          budgetMinor: edit.minor,
          note: edit.minor === null ? "No budget at all." : `Budget is ${money(edit.minor)} now.`,
        });
        break;
      case "budget_delta": {
        const current = state.ctx.budget;
        if (!current) return { reason: "There is no budget on this trip, so there is nothing to add to." };
        ops.push({
          kind: "set_budget",
          budgetMinor: current.minor + Math.round(edit.minor),
          note:
            edit.minor >= 0
              ? `${money(edit.minor)} more.`
              : `${money(-edit.minor)} less.`,
        });
        break;
      }
      case "time":
        ops.push({ kind: "set_time", availableMin: edit.availableMin, note: `Only ${hm(edit.availableMin)} now.` });
        break;
      case "time_delta":
        ops.push({
          kind: "set_time",
          availableMin: state.ctx.availableMin + Math.round(edit.minutes),
          note:
            edit.minutes >= 0
              ? `${hm(edit.minutes)} more.`
              : `${hm(-edit.minutes)} less.`,
        });
        break;
      case "weather":
        ops.push({
          kind: "set_weather",
          condition: edit.condition,
          ...(edit.tempC === undefined ? {} : { tempC: edit.tempC }),
          note: `${CONDITION_WORDS[edit.condition]}, ${edit.tempC ?? state.ctx.weather.tempC}°C.`,
        });
        break;
      case "walk_cap_m": {
        // `set_avoid` is safe here despite being a replace: `withOp` re-runs
        // `lowerPrefs` afterwards, which strips and re-adds every preference
        // token, and the traveller's own tokens are carried across explicitly.
        const kept = state.ctx.avoid.filter((token) => !token.startsWith(WALK_CAP_PREFIX));
        ops.push({
          kind: "set_avoid",
          avoid: [...kept, walkCapToken(edit.metres)],
          note: `No more than ${edit.metres} m on foot.`,
        });
        break;
      }
      case "indoor_only":
        ops.push({
          kind: "set_indoor",
          indoorOnly: edit.on,
          note: edit.on ? "Indoors only." : "Outdoors is fine again.",
        });
        break;
      case "exclude":
        ops.push({ kind: "exclude", experienceIds: edit.experienceIds, note: "Without those." });
        break;
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// 4. Validate the hypothetical against ITS OWN constraints
// ---------------------------------------------------------------------------

/**
 * A constraint the hypothetical itself broke.
 *
 * Deliberately not a `Rejection`. A `Rejection` is a per-experience value and the
 * contract requires an `experienceId`; there is no honest id for "the plan as a
 * whole is 113 m over the cap you set". Inventing one would put a fake
 * experience in a list the provider-side unmet-demand feed also reads, so this is
 * a plan-level value with the same four facts a `Rejection` carries.
 */
export type ScenarioBreach = {
  axis: "time" | "budget" | "walking";
  /** The limit the hypothetical set. */
  limit: number;
  /** What the engine's answer came to. */
  actual: number;
  shortfall: number;
  unit: "minutes" | "minor_units" | "metres";
  /** Finished sentence, real numbers in it. */
  message: string;
};

const rupees = (minor: number) => ({ minor, currency: "INR" as const });

/**
 * The hypothetical's own limits, checked against the plan the engine actually
 * returned. Not a substitute for `engine.validate` — this runs after it — but
 * the two check different things: the validator re-derives the plan's internal
 * arithmetic, this asks whether the answer respects the constraint the traveller
 * just invented. A planner that ignores `max_walk_1000m` gets caught here.
 */
function breachesOf(
  plan: Plan,
  ctx: DiscoveryContext,
  walkCapM: number | null,
): ScenarioBreach[] {
  const breaches: ScenarioBreach[] = [];

  const overTime = plan.totalMin - ctx.availableMin;
  if (overTime > 0) {
    breaches.push({
      axis: "time",
      limit: ctx.availableMin,
      actual: plan.totalMin,
      shortfall: overTime,
      unit: "minutes",
      message: `${hm(overTime)} over the ${hm(ctx.availableMin)} you asked for.`,
    });
  }

  if (ctx.budget && plan.totalCost.minor > ctx.budget.minor) {
    const over = plan.totalCost.minor - ctx.budget.minor;
    breaches.push({
      axis: "budget",
      limit: ctx.budget.minor,
      actual: plan.totalCost.minor,
      shortfall: over,
      unit: "minor_units",
      message: `${money(rupees(over))} over the ${money(ctx.budget)} you allowed.`,
    });
  }

  if (walkCapM !== null && plan.totalMetres > walkCapM) {
    const over = plan.totalMetres - walkCapM;
    breaches.push({
      axis: "walking",
      limit: walkCapM,
      actual: plan.totalMetres,
      shortfall: over,
      unit: "metres",
      message: `${over} m more walking than the ${walkCapM} m you allowed.`,
    });
  }

  return breaches;
}

// ---------------------------------------------------------------------------
// 6 + 7. Compare
// ---------------------------------------------------------------------------

/** What the hypothetical did to the plan, in one word. */
export type ScenarioDelta = "unchanged" | "added" | "removed" | "swapped" | "infeasible";

export type AxisComparison = {
  before: number;
  after: number;
  delta: number;
  unit: "count" | "minutes" | "minor_units" | "metres" | "ratio";
};

export type ScenarioComparison = {
  stops: AxisComparison;
  /** What the plan spends. `budgetCeiling` is the limit itself. */
  spend: AxisComparison;
  budgetCeiling: AxisComparison;
  /** What the plan uses of the window. `windowMin` is the window itself. */
  plannedMin: AxisComparison;
  windowMin: AxisComparison;
  walkingMetres: AxisComparison;
  /** Mean `fit.fitRatio`. 0 for a plan with no stops; `stops` says so on the same row. */
  meanFitRatio: AxisComparison;
  utilisation: AxisComparison;
  stress: AxisComparison;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const axis = (before: number, after: number, unit: AxisComparison["unit"]): AxisComparison => ({
  before,
  after,
  delta: round2(after - before),
  unit,
});

const meanFitRatio = (plan: Plan): number =>
  plan.stops.length === 0
    ? 0
    : plan.stops.reduce((sum, stop) => sum + stop.fit.fitRatio, 0) / plan.stops.length;

function comparePlans(
  current: Plan,
  hypothetical: Plan,
  from: DiscoveryContext,
  to: DiscoveryContext,
): ScenarioComparison {
  return {
    stops: axis(current.stops.length, hypothetical.stops.length, "count"),
    spend: axis(current.totalCost.minor, hypothetical.totalCost.minor, "minor_units"),
    budgetCeiling: axis(from.budget?.minor ?? -1, to.budget?.minor ?? -1, "minor_units"),
    plannedMin: axis(current.totalMin, hypothetical.totalMin, "minutes"),
    windowMin: axis(from.availableMin, to.availableMin, "minutes"),
    walkingMetres: axis(current.totalMetres, hypothetical.totalMetres, "metres"),
    meanFitRatio: axis(meanFitRatio(current), meanFitRatio(hypothetical), "ratio"),
    utilisation: axis(current.utilisation, hypothetical.utilisation, "ratio"),
    stress: axis(current.stressScore, hypothetical.stressScore, "ratio"),
  };
}

/**
 * Infeasible outranks everything. A plan that breaks the hypothetical's own
 * budget or walking cap is not "a plan with fewer stops", it is not an answer,
 * and saying so in one enum is harder to get wrong than a boolean buried next to
 * three other flags.
 */
export function deltaOf(added: number, removed: number, feasible: boolean): ScenarioDelta {
  if (!feasible) return "infeasible";
  if (added > 0 && removed > 0) return "swapped";
  if (added > 0) return "added";
  if (removed > 0) return "removed";
  return "unchanged";
}

// ---------------------------------------------------------------------------
// 3. Run it
// ---------------------------------------------------------------------------

export type ScenarioResult = {
  /**
   * A literal discriminant, so a serialised result crossing an API boundary
   * cannot be mistaken for a live plan. A what-if is not bookable and must never
   * reach a booking flow; the cheapest guard is a type that says so at every
   * switch statement.
   */
  kind: "what_if";
  /** The context the planner was actually given. A clone, never the live one. */
  ctx: DiscoveryContext;
  change: ContextChange;
  /** The engine's answer, admitted by the same door a real plan goes through. */
  plan: Plan;
  validation: ValidationResult;
  /** The whole "reality changed" panel, built for a trip that never happened. */
  reality: RealityChanged;
  compare: ScenarioComparison;
  /** What became possible, and what stopped being. See `gates.ts`. */
  gates: GateChange[];
  breaches: ScenarioBreach[];
  feasible: boolean;
  delta: ScenarioDelta;
};

export type ScenarioOutcome =
  | { ok: true; scenario: ScenarioResult }
  | { ok: false; reason: string; violations: Violation[] };

/**
 * The current plan scored against the HYPOTHETICAL context, which neither plan
 * carries — `Plan.stressScore` was computed under the live one. It is the number
 * that separates "this change really matters" from "you would churn anyway", so
 * it belongs in the answer. Degrades to null rather than costing a good answer.
 */
function stressBefore(engine: EnginePort, plan: Plan, ctx: DiscoveryContext): number | null {
  try {
    return engine.stress(plan, ctx).score;
  } catch {
    return null;
  }
}

/**
 * A fresh `pack` returns no `ReplanResult`, so there is no `preservedIntent`
 * flag to report and none is invented here. The flag is EARNED instead, against
 * the two contract fields that say what "preserved the intent" means
 * operationally: a counterfactual that re-adds something the traveller excluded,
 * or drops something they pinned, has not preserved it. It can fail, which is the
 * point.
 */
function intentKept(ctx: DiscoveryContext, plan: Plan): boolean {
  const planned = new Set(plan.stops.map((stop) => stop.experienceId));
  return (
    !ctx.excludedIds.some((id) => planned.has(id)) &&
    ctx.pinnedIds.every((id) => planned.has(id))
  );
}

/**
 * Live session + hypothetical edits -> a real re-solve -> a real comparison.
 *
 * Note what is NOT in the success type: a session. A caller cannot adopt a
 * what-if, because there is nothing here to adopt — just a plan, a context, and
 * the diff between them. Making the wrong thing unrepresentable beats
 * documenting that the right thing should be done.
 */
export function simulate(
  engine: EnginePort,
  session: DiscoverySession,
  edits: readonly ScenarioEdit[],
): ScenarioOutcome {
  const current = session.plan;
  if (!current) {
    return { ok: false, reason: "There is no plan to compare against yet, so there is nothing to simulate.", violations: [] };
  }

  // 1 + 2. Clone, then patch the clone. The live session object is not passed on.
  const base = cloneSession(session);
  const ops = opsFor(base.state, edits);
  if (!Array.isArray(ops)) {
    return { ok: false, reason: ops.reason, violations: [] };
  }
  const edit = applyOps(base.state, ops);
  if (!edit.change) {
    return { ok: false, reason: "That would not change anything, so there is nothing to simulate.", violations: [] };
  }
  const ctx = edit.state.ctx;

  // 3 + 4. THE REAL PLANNER. `discover` is retrieve -> filter -> score -> pack,
  // then admits the result through contract parse, catalogue membership,
  // contextId and the engine's own `validate`. A planner that throws or produces
  // a plan it cannot stand behind fails the whole scenario — the live plan is
  // never touched, so there is nothing to roll back.
  const built = discover(engine, { ...base, state: edit.state });
  if (!built.ok) {
    return {
      ok: false,
      reason: `The hypothetical did not survive planning: ${built.reason}`,
      violations: built.violations,
    };
  }
  const plan = built.plan;

  // 5. The same deterministic diff the "reality changed" panel uses, over the
  // same catalogue, so a what-if and a real replan cannot be read differently.
  const diff = diffPlans(engine, current, plan, {
    catalogue: session.catalogue,
    change: edit.change,
    travelMode: ctx.travelMode,
    // Where the day starts, so a first-stop removal can price its inbound leg.
    origin: ctx.origin.point,
  });
  const reality = buildRealityChanged({
    change: edit.change,
    diff,
    before: current,
    after: plan,
    nextCtx: ctx,
    // The context `current` was ACTUALLY solved under: the live session context
    // before the hypothetical edit. Not `intent` and not the edited `ctx`, for
    // the reason reality.ts gives -- shaping the before-state with either of
    // those reports a plan the traveller was never shown.
    prevCtx: session.state.ctx,
    // The traveller's real creation-time ask, even in a trip that never happened.
    intent: session.intent,
    enginePreservedIntent: intentKept(ctx, plan),
    stressBefore: stressBefore(engine, current, ctx),
  });

  // 4 + 6 + 7.
  const breaches = breachesOf(plan, ctx, walkCapOf(ctx));
  const feasible = breaches.length === 0;

  return {
    ok: true,
    scenario: {
      kind: "what_if",
      ctx,
      change: edit.change,
      plan,
      validation: built.validation,
      reality,
      compare: comparePlans(current, plan, session.state.ctx, ctx),
      gates: gateChanges(current, plan, session.catalogue),
      breaches,
      feasible,
      delta: deltaOf(diff.added.length, diff.removed.length, feasible),
    },
  };
}
