/**
 * "Reality changed" — the six things that go wrong in a real day, and the
 * context patch each one means.
 *
 * WHY THIS FILE EXISTS. `RealityPanel` used to build a `ContextChange` with an
 * empty `patch`, on the theory that "the route handler owns the mutation". The
 * route handler owns nothing: the whole app keeps the traveller's situation in
 * the URL, so a trigger that does not write a param navigates to the URL it
 * came from. Six buttons that re-solve nothing is the exact failure the master
 * prompt calls a feature that is 90% wired, and it was sitting on the demo's
 * second acceptance criterion.
 *
 * So each trigger owns three things and nothing else:
 *   - the `kind` and the hand-written `narrative` the swap diff shows;
 *   - the search params it writes, which ARE the context change;
 *   - nothing else. No arithmetic about plans, no feasibility, no scoring.
 *
 * The patch is real because the engine reads every field it touches. The five
 * `DiscoveryContext` fields a trigger can move are all load-bearing:
 * `availableMin` (feasibility + packing), `budget` (the gate), `weather` (the
 * weather gate and a scoring penalty), `accessNeeds` (the accessibility gate) and
 * `excludedIds` (a hard drop with a `Rejection` naming the traveller's reason).
 *
 * The sixth trigger is the one that needed a decision. "Everyone is exhausted"
 * has no dedicated field in the frozen contract, so the honest patch is the two
 * things it actually changes: a shorter window and walking instead of a transit
 * leg. The label says exactly that, because a trigger whose detail line
 * promises "longer dwell" while the context it writes cannot express dwell is
 * copy that lies, and this project has a gate for that.
 *
 * No imports beyond the contract, so both the client panel and the server-side
 * diff can read this table. That is the whole reason it is not in `_fixtures`.
 */
import type { ContextChange, DiscoveryContext } from "@/contracts";

/** The stop `soldout` removes. Null when the plan is empty. */
export interface TriggerInput {
  /** The current query. Copied, never mutated in place. */
  params: URLSearchParams;
  context: DiscoveryContext;
  firstStopId: string | null;
}

export interface ContextTrigger {
  key: string;
  label: string;
  detail: string;
  kind: ContextChange["kind"];
  /**
   * The sentence the swap diff leads with. Written by hand per trigger, never
   * generated from `kind`: "Context changed: time_shrank" is the machine-wording
   * the contract forbids, and it is also unreadable.
   */
  narrative: string;
  /** Writes the context change into `out`. Returns nothing; the diff is the point. */
  patch: (out: URLSearchParams, input: TriggerInput) => void;
}

function withNeed(params: URLSearchParams, need: string): void {
  const needs = new Set((params.get("needs") ?? "").split(",").filter(Boolean));
  needs.add(need);
  params.set("needs", [...needs].join(","));
}

const MIN_WINDOW_MIN = 30;

export const CONTEXT_TRIGGERS: readonly ContextTrigger[] = [
  {
    key: "rain",
    label: "It started raining",
    detail: "Outdoor loses, indoor wins",
    kind: "weather_changed",
    narrative: "It started raining, so anything outdoors lost and the indoor options moved up.",
    patch: (out) => out.set("w", "heavy_rain"),
  },
  {
    key: "time",
    label: "We lost 90 minutes",
    detail: "Fewer stops, closer",
    kind: "time_shrank",
    narrative: "You lost 90 minutes, so the plan is shorter and stays closer to where you are.",
    patch: (out, { context }) =>
      out.set("t", String(Math.max(MIN_WINDOW_MIN, context.availableMin - 90))),
  },
  {
    key: "soldout",
    label: "This one's sold out",
    detail: "Find a replacement",
    kind: "became_unavailable",
    narrative: "The first stop is sold out, so it left the plan and the nearest equivalent took its place.",
    patch: (out, { firstStopId }) => {
      if (firstStopId) out.set("x", firstStopId);
    },
  },
  {
    key: "budget",
    label: "Budget is now ₹600",
    detail: "Prune and show what was cut",
    kind: "budget_cut",
    narrative: "The budget is now ₹600, so anything over that came out of the plan.",
    patch: (out) => out.set("b", "600"),
  },
  {
    key: "restroom",
    label: "Need a bathroom",
    detail: "Filter to on-site",
    kind: "access_need_added",
    narrative: "You need a restroom on site, so everything without one dropped.",
    patch: (out) => withNeed(out, "restroom"),
  },
  {
    key: "exhausted",
    label: "Everyone is exhausted",
    detail: "Shorter day, walk it",
    kind: "mood_changed",
    narrative: "Everyone is tired, so the day got shorter and the legs are walked rather than ridden.",
    patch: (out, { context }) => {
      out.set("t", String(Math.max(MIN_WINDOW_MIN, context.availableMin - 45)));
      out.set("m", "walk");
    },
  },
];

export const TRIGGER_BY_KEY: ReadonlyMap<string, ContextTrigger> = new Map(
  CONTEXT_TRIGGERS.map((trigger) => [trigger.key, trigger]),
);

/**
 * Params that describe the change rather than the situation.
 *
 * `was` is the query the traveller was on before the last change, which is what
 * the plan diff compares against. `intent` is the query they started on, written
 * once and never overwritten, which is what `DiscoveryContext.original` is built
 * from — principle 3 is that the original ask is never replaced, so it has to
 * survive being replaced five times.
 */
const CHANGE_PARAMS = ["was", "intent", "changed"] as const;

export function paramsWithoutHistory(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(params);
  for (const key of CHANGE_PARAMS) out.delete(key);
  return out;
}

/** The query the traveller started on, or null if they have not changed anything. */
export function intentParams(params: URLSearchParams): URLSearchParams | null {
  const raw = params.get("intent");
  return raw ? new URLSearchParams(raw) : null;
}

/** The query from before the most recent change, or null on a first load. */
export function previousParams(params: URLSearchParams): URLSearchParams | null {
  const raw = params.get("was");
  return raw ? new URLSearchParams(raw) : null;
}

/**
 * The query a trigger navigates to.
 *
 * Three writes, in this order, and the order is the whole contract:
 *  1. `intent` is set from the current situation ONCE, and only if absent, so the
 *     baseline is the ask and not the latest mutation;
 *  2. `was` is set to the current situation every time, so the diff is against
 *     what the traveller was actually looking at a second ago;
 *  3. the patch goes on last, over the current situation.
 *
 * `changed` names the trigger so the server can recover its `kind` and
 * `narrative` without trusting the query string to carry a sentence.
 */
export function queryForTrigger(trigger: ContextTrigger, input: TriggerInput): string {
  const current = paramsWithoutHistory(input.params);
  const out = new URLSearchParams(input.params);

  if (!out.get("intent")) out.set("intent", current.toString());
  out.set("was", current.toString());
  trigger.patch(out, input);
  out.set("changed", trigger.key);

  return out.toString();
}

/**
 * The `ContextChange` for a trigger, rebuilt from the trigger table.
 *
 * `patch` carries the fields the trigger actually moved, keyed by their
 * `DiscoveryContext` names, so the diff can say what changed without
 * re-deriving it. It is never used to apply anything: the query already has.
 */
export function changeForTrigger(trigger: ContextTrigger, params: URLSearchParams): ContextChange {
  const moved: Record<string, unknown> = {};
  const before = previousParams(params);
  const after = paramsWithoutHistory(params);

  if (before) {
    for (const [key, value] of after) {
      if (before.get(key) !== value) moved[key] = value;
    }
  }

  return { kind: trigger.kind, narrative: trigger.narrative, patch: moved };
}
