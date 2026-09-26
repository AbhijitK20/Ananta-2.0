/**
 * What became possible, and what stopped being possible.
 *
 * The plan diff answers "which stops moved". It cannot answer the question a
 * traveller actually has after a counterfactual, which is about the things that
 * are NOT in either plan:
 *
 *   "I had ₹500 more — what did that actually unlock?"
 *
 * The engine already has that answer and threw it away. `Plan.rejected` is a
 * first-class contract field, every entry a finished sentence with the real
 * shortfall in it ("Needs 40 min more than you have left"). It is the reason a
 * candidate is not in the day, per docs/FEATURES.md §"why you are NOT seeing
 * something". The plan diff only ever looks at it to explain a stop that LEFT a
 * plan; it never asks what a change made POSSIBLE.
 *
 * So each place in a plan gets one of three states, and comparing two plans gives
 * the crossings:
 *
 *   planned   in `stops`. In your day.
 *   blocked   in `rejected`. Ruled out, with a reason and a number.
 *   unknown   neither. Retrieved and not chosen, which is not the same as
 *             impossible and must never be reported as though it were.
 *
 * The `unknown` state is the load-bearing one. Collapsing it into `blocked` — the
 * obvious shortcut, since a candidate that is not in the plan looks unavailable —
 * would make "₹500 more" look like it did nothing whenever the extra money
 * removed a blocker without the stop making the cut. That is the most useful
 * answer the feature can give, and it is the one a two-state model deletes.
 *
 * One crossing is a finding rather than an outcome:
 *
 *   `planned -> unknown`, a stop that left the day with NO rejection behind it.
 *
 * A dropped stop the engine cannot explain. `docs/FEATURES.md` is explicit that
 * every hard-constraint failure emits a `Rejection`, so this is either a bug in
 * the packer or a silent relaxation, and either way the traveller is about to be
 * shown a plan that quietly lost a stop. It is surfaced, not smoothed over.
 */
import type { Experience, Plan, Rejection, RejectionCode } from "../../contracts";

export type GateState = "planned" | "blocked" | "unknown";

/**
 * `unlocked` and `relaxed` are both improvements, and they are not the same
 * claim: one says the stop is in your day, the other says only that nothing is
 * stopping it any more. Merging them would let the feature claim credit for a
 * stop the traveller is not going to see.
 */
export type GateChangeKind =
  | "unlocked"
  | "relaxed"
  | "closed"
  | "tightened"
  | "dropped";

export type GateChange = {
  id: string;
  name: string;
  from: GateState;
  to: GateState;
  kind: GateChangeKind;
  /**
   * The engine's own sentence, from whichever side had a `Rejection`. Null when
   * neither did — which, for `dropped`, is the entire point.
   */
  reason: string | null;
  code: RejectionCode | null;
  shortfall: number | null;
  unit: Rejection["unit"];
  /** "indoor", "outdoor", … from the catalogue. Null if it is not a known place. */
  indoorOutdoor: Experience["indoorOutdoor"] | null;
};

/** Every id a plan has an opinion about, with that opinion. `stops` wins a tie. */
function statesOf(plan: Plan): ReadonlyMap<string, GateState> {
  const states = new Map<string, GateState>();
  for (const stop of plan.stops) states.set(stop.experienceId, "planned");
  for (const rejection of plan.rejected) {
    if (!states.has(rejection.experienceId)) states.set(rejection.experienceId, "blocked");
  }
  return states;
}

const rejectionIn = (plan: Plan, id: string): Rejection | null =>
  plan.rejected.find((entry) => entry.experienceId === id) ?? null;

/**
 * Null for `unknown <-> planned`: the stop was always possible and the only
 * difference is that the packer chose it. That is a selection change, and
 * `diffPlans` already reports it with a better reason. Returning it here too
 * would double-count every addition in the panel.
 */
function kindOf(from: GateState, to: GateState): GateChangeKind | null {
  if (from === "blocked" && to === "planned") return "unlocked";
  if (from === "blocked" && to === "unknown") return "relaxed";
  if (from === "planned" && to === "blocked") return "closed";
  if (from === "unknown" && to === "blocked") return "tightened";
  if (from === "planned" && to === "unknown") return "dropped";
  return null;
}

/**
 * Sorted by id, so the same pair of plans always yields the same array in the
 * same order. A gate list that reshuffles between renders makes a panel
 * impossible to test and impossible to trust.
 */
export function gateChanges(
  before: Plan,
  after: Plan,
  catalogue: ReadonlyMap<string, Experience>,
): GateChange[] {
  const from = statesOf(before);
  const to = statesOf(after);
  const ids = [...new Set([...from.keys(), ...to.keys()])].sort();

  const changes: GateChange[] = [];
  for (const id of ids) {
    const fromState = from.get(id) ?? "unknown";
    const toState = to.get(id) ?? "unknown";
    const kind = kindOf(fromState, toState);
    if (!kind) continue;

    // The reason for the state it is LEAVING is the informative one: it is the
    // constraint that used to apply. A relaxation is explained by what it freed.
    const reason = rejectionIn(before, id) ?? rejectionIn(after, id);
    changes.push({
      id,
      name: catalogue.get(id)?.name ?? "Unknown place",
      from: fromState,
      to: toState,
      kind,
      reason: reason?.message ?? null,
      code: reason?.code ?? null,
      shortfall: reason?.shortfall ?? null,
      unit: reason?.unit ?? null,
      indoorOutdoor: catalogue.get(id)?.indoorOutdoor ?? null,
    });
  }
  return changes;
}

/** What a change made possible. The answer to "what did the extra ₹500 buy". */
export const unlockedBy = (changes: readonly GateChange[]): GateChange[] =>
  changes.filter((change) => change.kind === "unlocked");

/**
 * Crossings that mean the engine is wrong, as opposed to the world having
 * changed. Currently only a stop that vanished from the plan with no
 * `Rejection` to explain it.
 */
export const findingsIn = (changes: readonly GateChange[]): GateChange[] =>
  changes.filter((change) => change.kind === "dropped");
