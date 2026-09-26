/**
 * Repairing a trip that is already under way.
 *
 * `replanner.ts` re-solves against a context. That is the right primitive for "you
 * have less time" and the wrong one for the three things that actually go wrong in
 * the field, none of which is a context edit:
 *
 *  - the traveller is two hours into the day, so the window is a *remaining* window
 *    and half the plan is history;
 *  - a stop is done, or has a booking nobody can cancel;
 *  - a place is gone, and nobody is going to tell the engine that except us.
 *
 * So this file is the layer that knows those three facts, and it owns four jobs:
 *
 *  1. **Read the trip.** `readTrip` turns `(session, event)` into a `TripState`: what
 *     is finished, what is paid for, what is gone, how much day is left. Done is
 *     derived from the clock, because a stop the traveller is standing in is history
 *     whether or not anybody pressed a button.
 *
 *  2. **Fold the day forward.** `advance_clock` moves `nowMin` on and takes the same
 *     minutes off `availableMin`, so the engine is handed a residual window and
 *     re-solves what is left. `original.availableMin` still holds the whole day, so
 *     "you are using 80% of what is left" and "you have been out for two hours" are
 *     both true at once.
 *
 *  3. **Declare the locks.** Finished stops and uncancellable bookings go into
 *     `pinnedIds` — the contract's own "already in the plan" list, and the only channel
 *     the engine reads. That is how "replan only the remaining portion" is expressed:
 *     the engine is told what it may not touch, and it still does the choosing.
 *
 *  4. **Refuse a plan that broke a lock.** `admit()` can check a plan is true. It
 *     cannot check that a finished activity survived, because the finished activity is
 *     not in the plan it is validating. So after the door, this file checks the two
 *     invariants nobody else can, and a failure discards the new plan exactly the way
 *     a missing `fit` does.
 *
 * What this file deliberately does NOT do:
 *
 *  - It does not pick the replacement. The replacement is whatever the engine's
 *    feasibility -> scoring -> packing pipeline returns. There is no table of `old
 *    place -> new place`, no second planner, and no text substitution: a swap in the
 *    diff is a stop the engine actually put in `Plan.stops`.
 *  - It does not invent a `ContextChange.kind`. Every edit goes through `applyOps`, so
 *    the one classifier in `context.ts` still decides the kind and a chip, a slider and
 *    a repair cannot disagree about it.
 *  - It does not re-time, reorder or re-score a finished stop. They leave here
 *    byte-identical, because an activity the traveller already did cannot be improved by
 *    being computed again.
 *
 * The only text this file composes is the reason a *finished* stop is still in the
 * plan, which is a fact about the trip rather than a justification for anything. Every
 * other sentence is the engine's `Rejection.message`, the engine's `PlanStop.why`, or
 * the reporter's own words — and `RepairExplanation.source` says which, so "we never
 * generate a reason" is a checkable claim rather than a promise in a comment.
 */
import type { ContextChange, Experience, Plan, RejectionCode, ValidationResult } from "../../contracts";
import { FLOOR_MIN, type EditorOp, applyOps } from "./context";
import type { PlanDiff } from "./diff";
import type { EnginePort } from "./engine";
import { type DiscoverySession, type ReplanOutcome, type Violation, replan } from "./replanner";
import type { RealityChanged } from "./reality";

// ---------------------------------------------------------------------------
// What changed in the world
// ---------------------------------------------------------------------------

/**
 * Why a place is not there any more. Four causes, because four different things
 * happened and the traveller is owed the difference: the venue shut, the slot sold, the
 * provider cannot host the party, or the listing was pulled.
 *
 * Reported as a contract gap: `ContextChange.kind` has `became_unavailable` and nothing
 * finer, so the cause cannot survive into the change itself. It lives here, and in
 * `RepairGap.code`, instead.
 */
export type GoneCause = "closed" | "sold_out" | "no_capacity" | "withdrawn";

/**
 * A place that is off the table, with the sentence that says why. `message` is written
 * by whoever reported it — the provider's status feed, the slot table, the traveller —
 * and is carried through untouched. Nothing here composes it, so it cannot be a
 * generated excuse.
 */
export type GonePlace = {
  id: string;
  cause: GoneCause;
  /** A finished sentence. "The 15:00 slot is gone, the provider is full." */
  message: string;
};

/** The contract's own code for each cause, so a UI can group them. */
const CAUSE_CODE: Record<GoneCause, RejectionCode> = {
  closed: "closed_during_window",
  sold_out: "sold_out",
  no_capacity: "capacity_exceeded",
  withdrawn: "excluded_by_traveller",
};

/**
 * Everything that can go wrong mid-day, in one shape. Every field is optional because
 * any one of them alone is a legitimate event, and the clock moving is the common case:
 * it is the only failure that happens without anybody deciding anything.
 */
export type RepairEvent = {
  /** Wall clock now, minutes from midnight. Omit to leave the clock alone. */
  nowMin?: number;
  /**
   * Stops already done. Derived from the clock when omitted, and only ever added to when
   * supplied: a stop the traveller says they did is history whether or not the
   * arithmetic agrees.
   */
  completed?: readonly string[];
  /**
   * Stops with a confirmed booking that cannot be altered — a non-refundable table, a
   * timed entry ticket. Still ahead of us, so the clock does not cover them. A stop that
   * is both done and booked is counted as done, once.
   */
  locked?: readonly string[];
  /** Places that are gone. */
  gone?: readonly GonePlace[];
  /**
   * Traveller edits — weather, time, budget, walking, preferences, access needs. The
   * same `EditorOp`s the chips and the chat sidecar produce, applied through the same
   * reducer, into the same replan.
   */
  ops?: readonly EditorOp[];
};

// ---------------------------------------------------------------------------
// The trip as it actually is
// ---------------------------------------------------------------------------

export type TripState = {
  /** Wall clock, minutes from midnight. Never earlier than the context's own. */
  nowMin: number;
  /** Minutes of the day already spent. */
  elapsedMin: number;
  /** What is left of the traveller's window. Floored, exactly as the editor is. */
  remainingMin: number;
  /** Done. Past, irreversible, never re-planned. */
  completed: readonly string[];
  /** Ahead of us and paid for. Untouchable, but still to be walked to. */
  booked: readonly string[];
  /** `completed + booked`: what went onto `pinnedIds`, and what is checked. */
  locked: readonly string[];
  /** Reported gone, whether or not it was in the plan to begin with. */
  gone: readonly GonePlace[];
  /** The first stop still ahead of the traveller. */
  nextUp: string | null;
  /** True when the "done" list came from the clock rather than from a report. */
  completedFromClock: boolean;
};

/**
 * Reads the day forward. A stop is done when it is behind the clock, so the common case
 * needs no bookkeeping from the caller.
 *
 * The clock is clamped forwards. A device with a wrong clock, or an event replayed out
 * of order, must not un-finish an activity: re-planning a market the traveller is
 * standing in is the exact failure this file exists to prevent, and it is worse than
 * doing nothing.
 */
export function readTrip(session: DiscoverySession, event: RepairEvent): TripState {
  const ctx = session.state.ctx;
  const nowMin = Math.max(ctx.nowMin, Math.round(event.nowMin ?? ctx.nowMin));
  const elapsedMin = nowMin - ctx.nowMin;

  const completed = new Set(event.completed ?? []);
  for (const stop of session.plan?.stops ?? []) {
    if (stop.departMin <= nowMin) completed.add(stop.experienceId);
  }
  // Done beats booked. A ticket that has already been used is not a constraint on the
  // future, and counting it twice would make the traveller look more committed to the
  // day than they are.
  const booked = new Set((event.locked ?? []).filter((id) => !completed.has(id)));

  return {
    nowMin,
    elapsedMin,
    remainingMin: Math.max(FLOOR_MIN, ctx.availableMin - elapsedMin),
    completed: [...completed].sort(),
    booked: [...booked].sort(),
    locked: [...new Set([...completed, ...booked])].sort(),
    gone: [...(event.gone ?? [])],
    nextUp: session.plan?.stops.find((stop) => stop.departMin > nowMin)?.experienceId ?? null,
    completedFromClock: (event.completed ?? []).length === 0,
  };
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/** Where a sentence came from. Load-bearing for the "never generated" claim. */
export type ReasonSource = "engine" | "reporter" | "context" | "trip";

export type RepairExplanation = {
  id: string;
  status: "removed" | "added" | "preserved";
  /** The contract's code when there is one. Null when the reason is not a refusal. */
  code: RejectionCode | null;
  /** A finished sentence. Never generated. */
  message: string;
  shortfall: number | null;
  unit: "minutes" | "minor_units" | "people" | "metres" | null;
  source: ReasonSource;
};

/** A gone place, as a structured reason the UI can render against that stop. */
export type RepairGap = {
  id: string;
  cause: GoneCause;
  code: RejectionCode;
  /** The reporter's own sentence. Never composed here. */
  message: string;
  /** True when the engine independently recorded it, so the two accounts agree. */
  engineAccounted: boolean;
};

/**
 * The reported gaps. Nothing is filtered against the previous plan: a place that is *in*
 * the plan and has just become unavailable is the whole point, and dropping it from this
 * list would turn the most common real failure into a silent no-op.
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
// The outcome
// ---------------------------------------------------------------------------

/**
 * What the traveller can be told, as data. Every field is a claim the feature makes, and
 * every one of them is derived from the plan that was actually returned rather than from
 * the intention, so a UI can render a trust badge without recomputing anything and a
 * test can assert the guarantee instead of trusting the prose.
 */
export type RepairGuarantees = {
  /** Every finished stop is still in the plan. */
  completedPreserved: boolean;
  /** Every unalterable booking is still in the plan. */
  bookedPreserved: boolean;
  /** Nothing we were told is gone is still planned. */
  goneExcluded: boolean;
  /** The whole resulting plan passed `admit()`, including `engine.validate`. */
  revalidated: boolean;
  /** The creation-time intent was not overwritten. */
  intentPreserved: boolean;
  /**
   * Finished stops that came out of the re-solve with every field unchanged, times
   * included. The strongest form of the claim and the one a regression breaks first:
   * comparing ids proves nothing, because a re-solve that recomputes a stop keeps the
   * id.
   */
  untouched: readonly string[];
};

export type RepairOutcome =
  | {
      ok: true;
      session: DiscoverySession;
      plan: Plan;
      change: ContextChange;
      diff: PlanDiff;
      reality: RealityChanged;
      validation: ValidationResult;
      trip: TripState;
      gaps: RepairGap[];
      explanations: RepairExplanation[];
      guarantees: RepairGuarantees;
      /**
       * Set when the re-solve came back with nothing in it. A specific sentence rather
       * than an empty plan the traveller has to interpret.
       */
      dayOver: string | null;
    }
  | {
      ok: false;
      /** Unchanged. `session.plan` is still the last plan that passed. */
      session: DiscoverySession;
      change: ContextChange | null;
      violations: Violation[];
      reason: string;
      trip: TripState;
      gaps: RepairGap[];
    };

// ---------------------------------------------------------------------------
// The repair
// ---------------------------------------------------------------------------

/**
 * The ops a repair turns into, in the order they have to happen: the clock and the locks
 * first, so the classifier sees the real window, and the traveller's own edits last, so
 * their `note` ends up in the narrative.
 */
export function repairOps(trip: TripState, event: RepairEvent): EditorOp[] {
  const ops: EditorOp[] = [];
  if (event.nowMin !== undefined) ops.push({ kind: "advance_clock", nowMin: event.nowMin });
  if (trip.locked.length > 0) ops.push({ kind: "pin", experienceIds: [...trip.locked] });
  for (const gap of trip.gone) ops.push({ kind: "exclude", experienceIds: [gap.id], note: gap.message });
  ops.push(...(event.ops ?? []));
  return ops;
}

/**
 * Repair a plan that is already running.
 *
 * old plan + what the day looks like now -> one context edit -> the engine's own
 * re-solve -> the single `admit()` door -> the lock check -> a diff you can read.
 *
 * Every failure path returns the previous plan *and the previous context* untouched.
 * There is no branch that ships a half-repaired day, and none that leaves behind a
 * context claiming something the plan does not honour.
 */
export function repair(
  engine: EnginePort,
  session: DiscoverySession,
  event: RepairEvent,
): RepairOutcome {
  const previous = session.plan;
  const trip = readTrip(session, event);
  const gaps = readGaps(event.gone ?? []);

  if (!previous) {
    return {
      ok: false,
      session,
      change: null,
      violations: [],
      reason: "There is no valid itinerary to repair yet, so nothing was changed.",
      trip,
      gaps,
    };
  }

  const edit = applyOps(session.state, repairOps(trip, event));
  if (!edit.change) {
    return {
      ok: false,
      session,
      change: null,
      violations: [],
      reason: "Nothing about the day actually changed, so nothing was re-solved.",
      trip,
      gaps,
    };
  }

  // The one re-solve. The candidate carries the residual window, the pins and the
  // exclusions; the engine decides what fills the rest.
  //
  // No fourth argument: `replan` has carried two different optional parameters in this
  // slot during development — a `prevCtx` for the reality panel's before/after, and a
  // `DemandMeta` for attributing an unmet-demand row — and passing either one blind
  // would be a coin flip. Both are optional by design, so the call is made with what is
  // certain. Wiring demand attribution in is a one-line change once the signature
  // settles, and it is worth doing: a repair that empties the plan is the most valuable
  // row the provider side ever sees.
  const outcome = replan(engine, { ...session, state: edit.state }, edit.change);
  // A refused re-solve hands back the candidate session, which is the edited context. Roll
  // it back, exactly as `applyEditorChange` does for a chip: a "less time" edit that
  // could not be honoured must not leave a context that claims there is less time.
  if (!outcome.ok) return { ...outcome, session, trip, gaps };

  const breach = lockBreach(outcome.plan, trip, session.catalogue);
  if (breach) {
    return {
      ok: false,
      session,
      change: edit.change,
      violations: [breach],
      reason:
        "That repair would have changed something you have already done, so your previous plan stands.",
      trip,
      gaps,
    };
  }

  // Now there is a new plan to check the engine's own account against.
  const settled = readGaps(event.gone ?? [], outcome.plan);
  const kept = outcome.plan.stops.map((stop) => stop.experienceId);

  return {
    ...withReasons(outcome, settled, edit.change.narrative),
    trip,
    gaps: settled,
    explanations: explain(outcome.plan, outcome.diff, settled, trip, session.catalogue),
    guarantees: {
      completedPreserved: trip.completed.every((id) => kept.includes(id)),
      bookedPreserved: trip.booked.every((id) => kept.includes(id)),
      goneExcluded: settled.every((gap) => !kept.includes(gap.id)),
      revalidated: outcome.validation.ok,
      intentPreserved: outcome.reality.intentPreserved,
      untouched: trip.completed.filter((id) => unchangedStop(previous, outcome.plan, id)),
    },
    dayOver: dayOverReason(previous, outcome.plan, trip),
  };
}

/**
 * The two invariants this file owns, because `admit()` cannot be asked to check them:
 * the plan it validates does not know what was finished before the re-solve, and an
 * engine is not the right place to be told about a provider's withdrawal.
 *
 * A finished stop, or a booking that cannot be moved, has to be in the new plan. A place
 * we were told is gone has to be out of it. Either way the answer is to keep the old
 * plan, not to patch the new one.
 */
function lockBreach(
  plan: Plan,
  trip: TripState,
  catalogue: ReadonlyMap<string, Experience>,
): Violation | null {
  const planned = new Set(plan.stops.map((stop) => stop.experienceId));

  const lost = trip.locked.find((id) => !planned.has(id));
  if (lost !== undefined) {
    return {
      code: "locked_stop_dropped",
      message: `${catalogue.get(lost)?.name ?? lost} is already done or booked, and the new plan dropped it.`,
      at: lost,
    };
  }

  const still = trip.gone.find((place) => planned.has(place.id));
  if (still) {
    return {
      code: "unavailable_still_planned",
      message: `${catalogue.get(still.id)?.name ?? still.id} is no longer available, and the new plan still has it.`,
      at: still.id,
    };
  }
  return null;
}

/**
 * "There is nothing else that fits" is a real answer and a common one, but a plan that
 * simply stops growing is not a way to say it — the traveller cannot tell "we could not
 * find anything" from "we ran out of day".
 *
 * So this is computed against the *locks*, not against the whole plan. A plan that ends
 * up holding only what was already finished or already booked, with no new stop added,
 * gets a sentence saying how much day is left and that nothing fits in it. A plan with
 * one locked stop and two new ones does not, because something was added.
 */
function dayOverReason(before: Plan, after: Plan, trip: TripState): string | null {
  const heldCount = after.stops.filter((stop) => trip.locked.includes(stop.experienceId)).length;
  if (after.stops.length > heldCount) return null;
  if (after.stops.length === 0 && before.stops.length === 0) return null;
  const why = after.rejected.find((entry) => entry.shortfall !== null)?.message;
  return (
    `${trip.remainingMin} min is all that is left, and nothing else fits.` + (why ? ` ${why}` : "")
  );
}

/**
 * Put the reporter's sentence on every removal we can name, so the swap diff says *why*
 * each thing left rather than "dropped after: something happened".
 *
 * `diff.removed` and `reality.removed` are the same objects, so writing the reason once
 * updates both. `Plan.rejected` is left exactly as the engine wrote it: those are the
 * engine's accounts and this layer does not get to edit them.
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

/**
 * A structured reason for every stop that moved, and for every one that did not.
 *
 * Precedence, and it is the whole point of the `source` field:
 *   1. the engine's own `Rejection` for that id, with its real shortfall;
 *   2. the reporter's sentence, for a place gone that the engine recorded only as
 *      "excluded by the traveller";
 *   3. the change's own narrative, when the engine gave no account at all.
 * A removal with no engine account is a finding, so it is labelled `context` rather than
 * dressed up as a reason.
 */
function explain(
  after: Plan,
  diff: PlanDiff,
  gaps: readonly RepairGap[],
  trip: TripState,
  catalogue: ReadonlyMap<string, Experience>,
): RepairExplanation[] {
  const out: RepairExplanation[] = [];

  for (const entry of diff.removed) {
    const rejection = after.rejected.find((item) => item.experienceId === entry.id);
    const gap = gaps.find((item) => item.id === entry.id);
    const reporter = gap !== undefined && entry.reason === gap.message;
    out.push({
      id: entry.id,
      status: "removed",
      code: rejection?.code ?? gap?.code ?? null,
      message: entry.reason,
      shortfall: rejection?.shortfall ?? null,
      unit: rejection?.unit ?? null,
      source: rejection ? "engine" : reporter ? "reporter" : "context",
    });
  }

  for (const entry of diff.added) {
    out.push({
      id: entry.id,
      status: "added",
      // An addition is not a refusal, so it carries no code. The reason is the winning
      // scoring term, in the engine's words.
      code: null,
      message: entry.reason,
      shortfall: null,
      unit: null,
      source: "engine",
    });
  }

  for (const id of trip.locked) {
    const stop = after.stops.find((item) => item.experienceId === id);
    if (!stop) continue;
    const done = trip.completed.includes(id);
    out.push({
      id,
      status: "preserved",
      code: null,
      message: done
        ? `${catalogue.get(id)?.name ?? id} is already done, kept exactly as it was.`
        : `${catalogue.get(id)?.name ?? id} is booked and cannot be moved, so it stays at ${clock(stop.arriveMin)}.`,
      shortfall: null,
      unit: null,
      source: "trip",
    });
  }
  return out;
}

/** Minutes from midnight, as a clock time. Used in the sentence about a held booking. */
const clock = (min: number): string =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * Did this finished stop come through the re-solve untouched?
 *
 * Compared by value, not by reference, because a re-solve rebuilds the stop list and an
 * identity check would always fail while telling you nothing. Every field the contract
 * has is in the comparison, which is the point: `arriveMin` is the obvious one to check
 * and `fit.cost.minor` is the one a careless re-time would quietly move.
 */
function unchangedStop(before: Plan, after: Plan, id: string): boolean {
  const was = before.stops.find((stop) => stop.experienceId === id);
  const now = after.stops.find((stop) => stop.experienceId === id);
  if (!was || !now) return false;
  return JSON.stringify(was) === JSON.stringify(now);
}

// ---------------------------------------------------------------------------
// Naming a place that is gone
// ---------------------------------------------------------------------------

/**
 * The first stop the traveller has not reached yet. The `sold_out` chip in `actions.ts`
 * always drops `stops[0]`, which is the wrong stop the moment they are standing in it;
 * this is the one that is not.
 */
export function upcoming(plan: Plan | null, nowMin: number): string | null {
  return plan?.stops.find((stop) => stop.departMin > nowMin)?.experienceId ?? null;
}

/**
 * A `GonePlace` from a cause, with the sentence that cause always means. The name comes
 * in so the sentence is finished — "Colaba Market is closed" beats "closed" — and a caller
 * holding better words from the provider passes its own.
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
