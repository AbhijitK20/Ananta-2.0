/**
 * The ladder: what each increment of one axis is actually worth.
 *
 * A single what-if answers "what would happen if". It does not answer the
 * question a traveller is really asking, which is "is it worth it":
 *
 *   "What if I had ₹500 more?"  ->  a plan
 *   "Is ₹500 more worth it?"    ->  a LADDER
 *
 * The ladder re-solves at each rung and reports the MARGINAL return of the step
 * between two rungs — the stops it gained, the rupees it spent, the experiences
 * it unlocked — and then the single most useful fact available: the rung where
 * the axis stops paying. Past that point more money buys nothing, because
 * something else is binding, and saying so is worth more than another plan.
 *
 *   budget ₹1500 -> ₹2000 -> ₹2500 -> ₹3000
 *     1500  3 stops   1112 m
 *     2000  4 stops   1668 m   +1 stop, unlocks 1 place
 *     2500  4 stops   1668 m   +0, +0  <- saturated
 *     3000  4 stops   1668 m   +0, +0
 *   => "₹500 more — from ₹1,500 to ₹2,000 — buys 1 more stop. The last 2 steps
 *       changed nothing. Past ₹2,000, this axis is spent."
 *
 * That last rung is the insight, and it is not derivable from any single plan.
 * ₹2500 would pay for a fifth stop; the 240-minute window will not hold one. The
 * money stopped mattering and the afternoon started, and the only way to know is
 * to solve both ends and compare.
 *
 * Nothing in that is generated. Every number is a difference between two plans
 * the engine produced, and the saturation claim is the absence of a difference,
 * which is the hardest kind of claim to fake and the easiest to check.
 *
 * COST, stated honestly. A rung is a full `discover()` — retrieve, filter, score,
 * pack, validate. `plannerCalls` on the result is the real number, counted
 * structurally rather than estimated, so a UI can show it BEFORE running. A
 * traveller asking a genuine question is worth several re-solves; a slider firing
 * this on every tick is not, and that decision belongs to the caller.
 */
import type { EnginePort } from "../discovery/engine";
import { hm, money, plural } from "../discovery/format";
import type { DiscoverySession } from "../discovery/replanner";
import { type GateChange, unlockedBy } from "./gates";
import { type ScenarioEdit, type ScenarioOutcome, simulate } from "./scenario";

/**
 * `budget` in paise, `time` in minutes, `walk` in metres. One unit per axis and
 * the unit is named in the type, so a rung value can never be read as the wrong
 * currency.
 */
export type LadderAxis = "budget" | "time" | "walk";

export type LadderUnit = "minor_units" | "minutes" | "metres";

export const LADDER_UNITS: Record<LadderAxis, LadderUnit> = {
  budget: "minor_units",
  time: "minutes",
  walk: "metres",
};

/**
 * One absolute edit for an axis. The ladder is absolute on purpose: a ladder of
 * "₹500 more" applied N times compounds, which is a different question.
 */
export function editFor(axis: LadderAxis, value: number): ScenarioEdit {
  switch (axis) {
    case "budget":
      return { kind: "budget", minor: Math.round(value) };
    case "time":
      return { kind: "time", availableMin: Math.round(value) };
    case "walk":
      return { kind: "walk_cap_m", metres: Math.round(value) };
  }
}

/** The axis value as the traveller would say it. */
export function labelFor(axis: LadderAxis, value: number): string {
  switch (axis) {
    case "budget":
      return money(value);
    case "time":
      return hm(value);
    case "walk":
      return `${value} m`;
  }
}

export type LadderRung = {
  /** Value on the axis, in its own unit. */
  value: number;
  label: string;
  edits: readonly ScenarioEdit[];
  outcome: ScenarioOutcome;
};

/** What one step up the ladder bought. Every field is a difference of two plans. */
export type MarginalStep = {
  from: number;
  to: number;
  /** What the step cost on the axis, in axis units. Always positive. */
  cost: number;
  unit: LadderUnit;
  stops: number;
  spendMinor: number;
  minutes: number;
  walkingMetres: number;
  /** Places that went from impossible to in-your-day at this step. */
  unlocked: GateChange[];
  /**
   * True when the step changed nothing a traveller would notice: the same stops,
   * the same cost. This is the "more of this axis is wasted" signal.
   */
  saturated: boolean;
  /** Why the step was saturated, from the engine, or null when it was not. */
  saturatedBecause: string | null;
};

export type Ladder = {
  axis: LadderAxis;
  unit: LadderUnit;
  rungs: LadderRung[];
  /** One entry fewer than rungs: steps are between rungs. */
  steps: MarginalStep[];
  /**
   * The first rung where the axis stopped paying, or null if it never did. In
   * axis units, so a UI can label it without knowing the axis.
   */
  saturatesAt: number | null;
  /**
   * A real solve per rung, counted structurally. Present so a caller can show or
   * budget the cost BEFORE running, not after being surprised.
   */
  plannerCalls: number;
  /** One or two sentences, arithmetic only. Never generated prose. */
  verdict: string;
  /** Rungs that did not survive planning, with the reason. */
  failures: { value: number; label: string; reason: string }[];
};

const ids = (plan: { stops: readonly { experienceId: string }[] }): string[] =>
  plan.stops.map((stop) => stop.experienceId).sort();

/**
 * A step changed nothing if the day is materially identical: the same places, in
 * any order, for the same money. Order is excluded on purpose — re-ordering the
 * same three stops is churn, not a purchase, and calling it value would be the
 * kind of small lie this feature exists to avoid.
 */
const samePlan = (
  a: { stops: readonly { experienceId: string }[]; totalCost: { minor: number } },
  b: { stops: readonly { experienceId: string }[]; totalCost: { minor: number } },
): boolean =>
  ids(a).join("|") === ids(b).join("|") && a.totalCost.minor === b.totalCost.minor;

/** Why this axis is not paying, named per axis. Never a guess about the engine. */
function saturatedBecauseFor(axis: LadderAxis): string {
  switch (axis) {
    case "budget":
      return "Nothing on the list is being kept out by money any more.";
    case "time":
      return "Nothing on the list fits in the extra time any more.";
    case "walk":
      return "Nothing on the list is close enough to fit the walk any more.";
  }
}

function stepBetween(
  axis: LadderAxis,
  lower: LadderRung,
  upper: LadderRung,
): MarginalStep | null {
  if (!lower.outcome.ok || !upper.outcome.ok) return null;
  const before = lower.outcome.scenario;
  const after = upper.outcome.scenario;
  const saturated = samePlan(before.plan, after.plan);
  return {
    from: lower.value,
    to: upper.value,
    cost: upper.value - lower.value,
    unit: LADDER_UNITS[axis],
    stops: after.compare.stops.delta,
    spendMinor: after.compare.spend.delta,
    minutes: after.compare.plannedMin.delta,
    walkingMetres: after.compare.walkingMetres.delta,
    unlocked: unlockedBy(after.gates),
    saturated,
    saturatedBecause: saturated ? saturatedBecauseFor(axis) : null,
  };
}

/**
 * "₹500 more buys 1 more stop. Past ₹2,000, this axis is spent."
 *
 * Written from the numbers, including the negative case. A ladder where every
 * step bought something has no interesting sentence, and saying so is more
 * useful than manufacturing enthusiasm.
 */
function verdictFor(axis: LadderAxis, steps: MarginalStep[], saturatesAt: number | null): string {
  const first = steps[0];
  if (!first) {
    return "One rung is not a ladder — there is nothing to compare it against.";
  }
  const bought =
    first.stops > 0
      ? `buys ${plural(first.stops, "more stop", "more stops")}`
      : first.unlocked.length > 0
        ? `takes ${plural(first.unlocked.length, "place", "places")} off the blocked list`
        : "changes nothing";

  const lead = `${labelFor(axis, first.cost)} more — from ${labelFor(axis, first.from)} to ${labelFor(axis, first.to)} — ${bought}.`;
  if (saturatesAt === null) return `${lead} Every step paid for itself.`;

  const wasted = steps.filter((step) => step.saturated).length;
  const tail = wasted > 1 ? ` The last ${wasted} steps changed nothing.` : " After that, more buys nothing.";
  return `${lead}${tail} Past ${labelFor(axis, saturatesAt)}, this axis is spent.`;
}

/**
 * Re-solve the trip at each rung of one axis.
 *
 * Values are de-duplicated, rounded and sorted ascending, so "more of the axis"
 * always means "later in the list", whichever axis it is. A caller that passes
 * them out of order gets a ladder that still works but whose steps carry negative
 * costs, so the sort is silent and the marginal arithmetic stays meaningful
 * rather than surprising.
 *
 * A budget ladder needs a budget to be a ladder over. With no ceiling there is no
 * axis to move along, and saying so beats inventing a ₹0 starting rung.
 */
export function ladder(
  engine: EnginePort,
  session: DiscoverySession,
  axis: LadderAxis,
  values: readonly number[],
): Ladder {
  if (axis === "budget" && !session.state.ctx.budget) {
    return {
      axis,
      unit: LADDER_UNITS[axis],
      rungs: [],
      steps: [],
      saturatesAt: null,
      plannerCalls: 0,
      verdict: "There is no budget on this trip, so there is no budget ladder to climb.",
      failures: [],
    };
  }

  const sorted = [...new Set(values.map((value) => Math.round(value)))].sort((a, b) => a - b);
  const rungs: LadderRung[] = sorted.map((value) => ({
    value,
    label: labelFor(axis, value),
    edits: [editFor(axis, value)],
    outcome: simulate(engine, session, [editFor(axis, value)]),
  }));

  const steps: MarginalStep[] = [];
  for (let i = 1; i < rungs.length; i += 1) {
    const lower = rungs[i - 1];
    const upper = rungs[i];
    if (!lower || !upper) continue;
    const step = stepBetween(axis, lower, upper);
    if (step) steps.push(step);
  }

  const firstSaturated = steps.find((step) => step.saturated);
  const saturatesAt = firstSaturated?.to ?? null;
  const failures = rungs
    .filter((rung) => !rung.outcome.ok)
    .map((rung) => ({
      value: rung.value,
      label: rung.label,
      reason: rung.outcome.ok ? "" : rung.outcome.reason,
    }));

  return {
    axis,
    unit: LADDER_UNITS[axis],
    rungs,
    steps,
    saturatesAt,
    plannerCalls: rungs.length,
    verdict: verdictFor(axis, steps, saturatesAt),
    failures,
  };
}
