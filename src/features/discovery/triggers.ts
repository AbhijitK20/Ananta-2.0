/**
 * The conditions a day can go wrong, and where each one is actually reachable.
 *
 * `actions.ts` has the chips a traveller taps, and they cover most of it. They cannot
 * cover three things, and all three are the same underlying problem: a chip produces
 * `EditorOp`s against the current state, and each of these needs to name a specific
 * stop or move the clock.
 *
 *  - **The next one** is closed. The `sold_out` chip drops `stops[0]`, which is the
 *    right stop at 10:00 and the wrong one at 14:00 when they are standing in it.
 *    "The next one" is only knowable against a clock.
 *  - **Our booking** cannot be held. A different cause, a different remedy, and it has
 *    to survive as a structured reason rather than as a chip label.
 *  - **We have more time.** The chip set is entirely about things going wrong. A day
 *    that opens up is the same re-solve with a bigger window.
 *
 * So the chips stay where they are and these three live here, on top of the same
 * `repair()` call.
 *
 * `CONDITION_COVERAGE` is the part worth keeping. It names the eight conditions from
 * `docs/FEATURES.md` §3 and, for each, the ids that reach it. That turns "we handle
 * all the conditions" from a sentence in a demo script into something a test can fail
 * on the day a chip is renamed — which is exactly the kind of coverage that silently
 * rots otherwise.
 */
import { type EditorOp } from "./context";
import { type GoneCause, type RepairEvent, gone, upcoming } from "./repair";
import type { DiscoverySession } from "./replanner";
import { REALITY_TRIGGERS, SUGGESTIONS, type DiscoveryAction } from "./actions";

/** The eight conditions from `docs/FEATURES.md` §3, as machine keys. */
export const CONDITIONS = [
  "experience_unavailable",
  "weather_changed",
  "less_time",
  "more_time",
  "lower_budget",
  "less_walking",
  "preference_changed",
  "slot_unavailable",
] as const;
export type Condition = (typeof CONDITIONS)[number];

export const MORE_TIME_MIN = 60;

export type TriggerInput = {
  session: DiscoverySession;
  /** Where the traveller is standing. A trigger that names a stop needs this. */
  nowMin: number;
  /** Name a specific stop instead of inferring one. A provider feed has an id. */
  id?: string;
  /** Overrides for the sized triggers, so a panel can offer a different amount. */
  minutes?: number;
  budgetMinor?: number | null;
  /** The reporter's own words, when there are better ones than ours. */
  message?: string;
  cause?: GoneCause;
};

export type RepairTrigger = {
  id: string;
  condition: Condition;
  label: string;
  hint: string;
  /**
   * The event to fire, or `null` when the condition is not true right now — the same
   * convention as `runAction`, so the UI hides a chip rather than paying for a repair
   * that would do nothing.
   */
  build: (input: TriggerInput) => RepairEvent | null;
};

const nameOf = (session: DiscoverySession, id: string): string =>
  session.catalogue.get(id)?.name ?? "That place";

/** The stop a trigger should fire at: the named one, else the next one up. */
function targetOf(input: TriggerInput): string | null {
  return input.id ?? upcoming(input.session.plan, input.nowMin);
}

export const REPAIR_TRIGGERS: readonly RepairTrigger[] = [
  {
    id: "more_time",
    condition: "more_time",
    label: `We have ${MORE_TIME_MIN} more minutes`,
    hint: "Backfills the free time with the next best thing that fits.",
    build: ({ session, nowMin, minutes }) => {
      const extra = minutes ?? MORE_TIME_MIN;
      if (extra <= 0) return null;
      const op: EditorOp = {
        kind: "set_time",
        availableMin: session.state.ctx.availableMin + extra,
        note: `${extra} minutes more than we thought.`,
      };
      return { nowMin, ops: [op] };
    },
  },
  {
    id: "next_stop_closed",
    condition: "experience_unavailable",
    label: "The next one is closed",
    hint: "Drops the stop that is actually next, and leaves the day before it alone.",
    build: (input) => {
      const id = targetOf(input);
      if (!id) return null;
      return {
        nowMin: input.nowMin,
        gone: [
          {
            id,
            cause: "closed",
            message: input.message ?? `${nameOf(input.session, id)} is closed now.`,
          },
        ],
      };
    },
  },
  {
    id: "booking_lost",
    condition: "slot_unavailable",
    label: "Our slot is gone",
    hint: "The provider cannot hold the booking, so that stop has to be rebooked.",
    build: (input) => {
      const id = targetOf(input);
      if (!id) return null;
      const cause = input.cause ?? "no_capacity";
      return {
        nowMin: input.nowMin,
        gone: [
          input.message
            ? { id, cause, message: input.message }
            : gone(id, cause, nameOf(input.session, id)),
        ],
      };
    },
  },
];

export const TRIGGER_BY_ID: ReadonlyMap<string, RepairTrigger> = new Map(
  REPAIR_TRIGGERS.map((trigger) => [trigger.id, trigger]),
);

/** Fires a trigger, or `null` when the condition is not true. Never applies it. */
export function runTrigger(trigger: RepairTrigger, input: TriggerInput): RepairEvent | null {
  return trigger.build(input);
}

/**
 * Where each of the eight conditions is reached, by id.
 *
 * Two entries for `experience_unavailable` on purpose: the chip is the blunt version
 * and drops the first stop whatever the time is, the trigger is the one that reads the
 * clock. Both are real, and which is correct depends on when it fires.
 */
export const CONDITION_COVERAGE: Readonly<Record<Condition, readonly string[]>> = {
  experience_unavailable: ["sold_out", "next_stop_closed"],
  weather_changed: ["rain"],
  less_time: ["time_lost", "less_time"],
  more_time: ["more_time"],
  lower_budget: ["budget", "cheaper"],
  less_walking: ["less_walking", "exhausted"],
  preference_changed: ["more_local", "indoor_only", "family_friendly", "more_food", "more_culture"],
  slot_unavailable: ["booking_lost"],
};

const CHIPS_BY_ID: ReadonlyMap<string, DiscoveryAction> = new Map(
  [...REALITY_TRIGGERS, ...SUGGESTIONS].map((action) => [action.id, action]),
);

/** Every id a panel can fire, chips and triggers together. */
export const ALL_CONDITION_IDS: ReadonlySet<string> = new Set([
  ...CHIPS_BY_ID.keys(),
  ...TRIGGER_BY_ID.keys(),
]);
