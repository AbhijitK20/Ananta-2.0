/**
 * Realistic repair of a trip that is already under way.
 *
 * `replanner.ts` re-solves against a context. That is the right primitive for
 * "you have less time" and the wrong one for the three things that actually go
 * wrong in the field, none of which is a context edit:
 *
 *  - the traveller is two hours into the day, so the window is a *remaining*
 *    window and half the plan is history;
 *  - a stop is done, or has a booking nobody can cancel;
 *  - a place is gone, and nobody is going to tell the engine that except us.
 *
 * So this file is the layer that knows those three facts, and it owns exactly
 * three responsibilities:
 *
 *  1. **Fold the day forward.** `advance_clock` moves `nowMin` on and takes the
 *     same number of minutes off `availableMin`, so the engine is handed a
 *     residual window and re-solves what is left. `original.availableMin` still
 *     holds the whole day, so "you are using 80% of what is left" and "you have
 *     been out for two hours" are both true at once.
 *  2. **Declare the locks.** Done stops and uncancellable bookings go into
 *     `pinnedIds`, which is the contract's own "already in the plan" list and is
 *     the only channel the engine reads. That is how "replan only the remaining
 *     portion" is expressed — the engine is told what it may not touch, and it
 *     still does the choosing.
 *  3. **Refuse a plan that broke a lock.** After `replan()` hands back an
 *     admitted plan, this checks the two invariants no engine check can be asked
 *     to make about a plan it just built: a finished stop survived, and a place
 *     we were told is gone is not in the plan. A plan that fails is discarded
 *     and the previous one stands, which is the same stance `admit()` takes.
 *
 * What this file deliberately does NOT do:
 *
 *  - It does not pick the replacement. The replacement is whatever the engine's
 *    feasibility -> scoring -> packing pipeline returns. There is no table of
 *    `old place -> new place` here, no second planner, and no text substitution:
 *    a swap that shows up in the diff is a stop the engine actually put in
 *    `Plan.stops`.
 *  - It does not invent a `ContextChange.kind`. Every edit goes through
 *    `applyOps`, so the one classifier in `context.ts` still decides the kind and
 *    a chip, a slider and this event cannot disagree about it.
 *  - It does not re-time, reorder or re-score a stop. Preserved stops leave here
 *    byte-identical, because a stop the traveller already did cannot be improved
 *    by being computed again.
 *
 * The only text written here is the `message` on a `GonePlace`, and that is the
 * provider's or the traveller's own sentence, passed straight through. Every
 * other reason in the outcome is either the engine's `Rejection.message`, the
 * engine's `PlanStop.why`, or the diff's own numbers.
 */
import type { ContextChange, Plan, RejectionCode, ValidationResult } from "../../contracts";
import { type EditorOp, applyOps } from "./context";
import type { PlanDiff } from "./diff";
import type { EnginePort } from "./engine";
import {
  type DiscoverySession,
  type ReplanOutcome,
  type Violation,
  replan,
} from "./replanner";
import type { RealityChanged } from "./reality";

// ---------------------------------------------------------------------------
// What changed in the world
// ---------------------------------------------------------------------------

/**
 * Why a place is not there any more. Four causes, because four different things
 * happened and the traveller needs to be told which: the venue shut, the slot
 * sold, the provider cannot host the party, or the listing was pulled.
 */
export type GoneCause = "closed" | "sold_out" | "no_capacity" | "withdrawn";

/**
 * A place that is off the table, with the sentence that says why. `message` is
 * written by whoever reported it — the provider's status feed, the traveller, the
 * slot table — and is carried through untouched. Nothing here composes it, so it
 * cannot be a generated excuse.
 */
export type GonePlace = {
  id: string;
  cause: GoneCause;
  /** A finished sentence. "The 15:00 slot is gone, the provider is full." */
  message: string;
};

/** The contract's own code for each cause, so the UI can group them. */
const CAUSE_CODE: Record<GoneCause, RejectionCode> = {
  closed: "closed_during_window",
  sold_out: "sold_out",
  no_capacity: "capacity_exceeded",
  withdrawn: "excluded_by_traveller",
};

/**
 * Everything that can go wrong mid-day, in one shape. Every field is optional
 * because any one of them alone is a legitimate event, and the clock moving is
 * the common case: it is the only failure that happens without anybody deciding
 * anything.
 */
export type RepairEvent = {
  /** Wall clock now, minutes from midnight. Omit to leave the clock alone. */
  nowMin?: number;
  /**
   * Stops already done. Derived from the clock when omitted: any stop whose
   * `departMin` has passed is history, which is the case that needs no UI at all.
   */
  completed?: readonly string[];
  /**
   * Stops with a confirmed booking that cannot be altered — a non-refundable
   * table, a timed entry ticket. Still ahead of us, so the clock does not cover
   * them. A stop that is both done and booked is counted as done, once.
   */
  locked?: readonly string[];
  /** Places that are gone. */
  gone?: readonly GonePlace[];
  /**
   * Traveller edits — weather, time, budget, walking, preferences, access needs.
   * The same `EditorOp`s the chips and the chat sidecar produce, applied through
   * the same reducer, into the same replan.
   */
  ops?: readonly EditorOp[];
};

// ---------------------------------------------------------------------------
// What we are holding on to
// ---------------------------------------------------------------------------

export type RepairLocks = {
  /** Done. Past, irreversible, never re-planned. */
  completed: readonly string[];
  /** Ahead of us and paid for. Untouchable, but still to be walked to. */
  booked: readonly string[];
  /** `completed + booked`: what went onto `pinnedIds`, and what is checked. */
  hold: readonly string[];
  /** True when the "done" list came from the clock rather than from a report. */
  completedFromClock: boolean;
};

/**
 * Reads the day forward. A stop is done when it is behind the clock, so the
 * common case needs no bookkeeping from the caller; an explicit `completed` list
 * only ever adds to that, never removes from it, because a stop the traveller
 * says they did is history whether or not the arithmetic agrees.
 */
export function readLocks(plan: Plan | null, nowMin: number, event: RepairEvent): RepairLocks {
  const completed = new Set(event.completed ?? []);
  for (const stop of plan?.stops ?? []) {
    if (stop.departMin <= nowMin) completed.add(stop.experienceId);
  }
  const booked = new Set((event.locked ?? []).filter((id) => !completed.has(id)));
  return {
    completed: [...completed].sort(),
    booked: [...booked].sort(),
    hold: [...new Set([...completed, ...booked])].sort(),
    completedFromClock: (event.completed ?? []).length === 0,
  };
}

/** A gone place, as a structured reason the UI can render against that stop. */
export type RepairGap = {
  id: string;
  cause: GoneCause;
  code: RejectionCode;
  /** The reporter's own sentence. Never composed here. */
  message: string;
  /** True when the engine also recorded it, so the two accounts agree. */
  engineAccounted: boolean;
};

/**
 * The reported gaps, before the re-solve. Nothing is filtered against the
 * previous plan here: a place that is *in* the plan and has just become
 * unavailable is the whole point, and dropping it from this list would turn the
 * most common real failure into a silent no-op.
 *
 * `engineAccounted` is filled in afterwards, against the plan the engine actually
 * returned, because until then there is no new account to check.
 */
function readGaps(gone: readonly GonePlace[], accountedIn?: Plan | null): RepairGap[] {
  return gone.map((place) => ({
    id: place.id,
    cause: place.cause,
    code: CAUSE_CODE[place.cause],
    message: place.message,
    engineAccounted: (accountedIn?.rejected ?? []).some((entry) => entry.experienceId === place.id),
  }));
}

// ---------------------------------------------------------------------------
// The repair
// ---------------------------------------------------------------------------

export type RepairOutcome =
  | {
      ok: true;
      session: DiscoverySession;
      plan: Plan;
      change: ContextChange;
      diff: PlanDiff;
      reality: RealityChanged;
      validation: ValidationResult;
      locks: RepairLocks;
      gaps: RepairGap[];
    }
  | {
      ok: false;
      /** Unchanged. `session.plan` is still the last plan that passed. */
      session: DiscoverySession;
      change: ContextChange | null;
      violations: Violation[];
      reason: string;
      locks: RepairLocks;
      gaps: RepairGap[];
    };

/**
 * The ops a repair event turns into, in the order they have to happen: the clock
 * and the locks first, so the classifier sees the real window, and the
 * traveller's own edits last, so their `note` ends up in the narrative.
 */
export function repairOps(event: RepairEvent, locks: RepairLocks, gaps: readonly RepairGap[]): EditorOp[] {
  const ops: EditorOp[] = [];
  if (event.nowMin !== undefined) ops.push({ kind: "advance_clock", nowMin: event.nowMin });
  if (locks.hold.length > 0) ops.push({ kind: "pin", experienceIds: [...locks.hold] });
  for (const gap of gaps) ops.push({ kind: "exclude", experienceIds: [gap.id], note: gap.message });
  ops.push(...(event.ops ?? []));
  return ops;
}

/**
 * Repair a plan that is already running.
 *
 * old plan + what the day looks like now -> one context edit -> the engine's own
 * re-solve -> the single `admit()` door -> the lock check -> a diff you can read.
 *
 * Every failure path returns the previous plan untouched. There is no branch that
 * ships a half-repaired day: a re-solve that dropped something already done, or
 * kept something we were told is gone, is refused exactly the way a plan with a
 * missing `fit` is refused.
 */
export function repair(
  engine: EnginePort,
  session: DiscoverySession,
  event: RepairEvent,
): RepairOutcome {
  const previous = session.plan;
  if (!previous) {
    return {
      ok: false,
      session,
      change: null,
      violations: [],
      reason: "There is no valid itinerary to repair yet, so nothing was changed.",
      locks: readLocks(previous, event.nowMin ?? session.state.ctx.nowMin, event),
      gaps: readGaps(event.gone ?? []),
    };
  }

  const nowMin = event.nowMin ?? session.state.ctx.nowMin;
  const locks = readLocks(previous, nowMin, event);
  const gaps = readGaps(event.gone ?? []);

  const edit = applyOps(session.state, repairOps(event, locks, gaps));
  if (!edit.change) {
    return {
      ok: false,
      session,
      change: null,
      violations: [],
      reason: "Nothing about the day actually changed, so nothing was re-solved.",
      locks,
      gaps,
    };
  }

  // The one re-solve. The candidate carries the residual window, the pins and the
  // exclusions; the engine decides what fills the rest.
  const outcome = replan(engine, { ...session, state: edit.state }, edit.change);
  // A refused re-solve hands back the candidate session, which is the edited
  // context. Roll it back, exactly as `applyEditorChange` does for a chip: a
  // "less time" edit that could not be honoured must not leave a context that
  // claims there is less time.
  if (!outcome.ok) return { ...outcome, session, locks, gaps };

  const breach = lockBreach(outcome.plan, locks, gaps, session.catalogue);
  if (breach) {
    return {
      ok: false,
      session,
      change: edit.change,
      violations: [breach],
      reason:
        "That repair would have changed something you have already done, so your previous plan stands.",
      locks,
      gaps,
    };
  }

  // Now there is a new plan to check the engine's account against.
  const settled = readGaps(event.gone ?? [], outcome.plan);
  return { ...withReasons(outcome, settled, edit.change.narrative), locks, gaps: settled };
}

/**
 * The two invariants the feature owns, because the engine cannot be asked to
 * check them about a plan it just built. Returns the violation, or null.
 *
 * A stop the traveller has finished, or a booking that cannot be moved, has to
 * be in the new plan. A place we were told is gone has to be out of it. Either
 * way the answer is to keep the old plan, not to patch the new one.
 */
function lockBreach(
  plan: Plan,
  locks: RepairLocks,
  gaps: readonly RepairGap[],
  catalogue: ReadonlyMap<string, { name: string }>,
): Violation | null {
  const planned = new Set(plan.stops.map((stop) => stop.experienceId));

  const lost = locks.hold.find((id) => !planned.has(id));
  if (lost !== undefined) {
    return {
      code: "locked_stop_dropped",
      message: `${catalogue.get(lost)?.name ?? lost} is already done or booked, and the new plan dropped it.`,
      at: lost,
    };
  }

  const gone = gaps.find((gap) => planned.has(gap.id));
  if (gone) {
    return {
      code: "unavailable_still_planned",
      message: `${catalogue.get(gone.id)?.name ?? gone.id} is no longer available, and the new plan still has it.`,
      at: gone.id,
    };
  }
  return null;
}

/**
 * Put the reporter's sentence on every removal we can name, so the swap diff
 * says *why* each thing left rather than "dropped after: something happened".
 *
 * `diff.removed` and `reality.removed` are the same objects, so writing the
 * reason once updates both. `Plan.rejected` is left exactly as the engine wrote
 * it: those are the engine's accounts and this layer does not get to edit them.
 */
function withReasons(
  outcome: Extract<ReplanOutcome, { ok: true }>,
  gaps: readonly RepairGap[],
  narrative: string,
): Extract<ReplanOutcome, { ok: true }> {
  if (gaps.length === 0) return outcome;
  for (const gap of gaps) {
    const entry = outcome.diff.removed.find((stop) => stop.id === gap.id);
    if (entry) entry.reason = gap.message;
  }
  const first = outcome.diff.removed[0]?.reason;
  outcome.reality.reason = first ? `${narrative} ${first}` : `${narrative} Nothing had to change.`;
  return outcome;
}

// ---------------------------------------------------------------------------
// Naming a place that is gone
// ---------------------------------------------------------------------------

/**
 * The first stop the traveller has not reached yet. The `sold_out` chip in
 * `actions.ts` always drops `stops[0]`, which is the wrong stop once they are
 * standing in it; this is the one that is not.
 */
export function upcoming(plan: Plan | null, nowMin: number): string | null {
  return plan?.stops.find((stop) => stop.departMin > nowMin)?.experienceId ?? null;
}

/**
 * A `GonePlace` from a cause, with the sentence that cause always means. The
 * name comes in so the sentence is finished — "Colaba Market is closed" beats
 * "closed" — and a caller that has better words from the provider passes its own.
 */
export function gone(id: string, cause: GoneCause, name: string): GonePlace {
  const messages: Record<GoneCause, string> = {
    closed: `${name} is closed now.`,
    sold_out: `${name} sold out.`,
    no_capacity: `${name} cannot take our party.`,
    withdrawn: `${name} was withdrawn by the provider.`,
  };
  return { id, cause, message: messages[cause] };
}
