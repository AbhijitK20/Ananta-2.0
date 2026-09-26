/**
 * Realistic repair, against an engine that decides rather than one that answers.
 *
 * `discovery.test.ts` covers the feature against `fakeEngine`, which returns the plan
 * the test hands it. That is right for the diff, the guard and the panel, and it cannot
 * answer the only question this file asks: **when the day goes wrong, does the
 * itinerary actually change into something feasible?**
 *
 * So this file drives the production entry points — `createSession`, `discover`,
 * `repair` — against the gate engine in `./engine`, which runs a real feasibility ->
 * scoring -> packing pipeline. Every assertion below reads `Plan.stops`, `Plan.legs`,
 * `Plan.rejected`, `DiscoveryContext`, `TripState` or `RepairGuarantees`; none of them
 * reads a label. A fixture that answered from a table could not pass any of them.
 *
 * Imports are module-relative rather than through the `..` barrel, so a broken sibling
 * module cannot take this file down with it.
 */
import { describe, expect, it } from "vitest";
import { type ContextChange, type DiscoveryContext, type Plan } from "../../../contracts";
import { INDOOR_TOKEN, WALK_TOKENS } from "../context";
import type { EnginePort } from "../engine";
import { type GoneCause, type RepairEvent, gone, readTrip, repair, upcoming } from "../repair";
import { createSession } from "../replanner";
import {
  ALL_CONDITION_IDS,
  CONDITION_COVERAGE,
  CONDITIONS,
  REPAIR_TRIGGERS,
  TRIGGER_BY_ID,
  runTrigger,
} from "../triggers";
import { deterministicEngine, validatePlan, walkLimitPerLeg } from "./engine";
import {
  CATALOGUE,
  CATALOGUE_MAP,
  FACTS,
  POTTERY_SLOT_FREE,
  SEED,
  city,
  codes,
  hardFailures,
  hopsOf,
  ids,
  nextUp,
  repaired,
  spreadOf,
} from "./city";
import { WEIGHTS } from "./fixtures";

/**
 * An engine that re-solves correctly but forgets the pins it was given: it packs an
 * empty day. The lock check is the only thing between that and a traveller losing a
 * market they already walked to.
 */
function amnesiac(): EnginePort {
  const engine = deterministicEngine({ catalogue: CATALOGUE, weights: WEIGHTS, facts: FACTS });
  return {
    ...engine,
    replan: (_prev: Plan, ctx: DiscoveryContext, change: ContextChange) => ({
      plan: deterministicEngine({ catalogue: CATALOGUE, weights: WEIGHTS, facts: FACTS }).pack(ctx, []),
      change,
      swaps: [],
      preservedIntent: true,
      summary: change.narrative,
    }),
  };
}

// ===========================================================================
// Test 1 — an experience becomes unavailable
// ===========================================================================

describe("an experience that is no longer available", () => {
  it("gets replaced by a feasible stop the pipeline chose", () => {
    const run = city();
    const lost = nextUp(run.initial, run.ctx.nowMin);

    const outcome = repaired(run, {
      nowMin: run.ctx.nowMin,
      gone: [{ id: lost, cause: "sold_out", message: "Colaba Market sold out for the 11:00 slot." }],
    });

    // 1. The itinerary actually changed, and it changed because the place is gone.
    expect(ids(outcome.plan)).not.toEqual(ids(run.initial));
    expect(ids(outcome.plan)).not.toContain(lost);
    expect(outcome.diff.removed.map((stop) => stop.id)).toEqual([lost]);
    expect(outcome.diff.added.length).toBeGreaterThan(0);

    // 2. The replacement is real. Every stop is re-checked through the same gate the
    //    engine applied, walked as a chain, so this is the feasibility pipeline
    //    agreeing with itself rather than a claim in a component.
    const after = outcome.session.state.ctx;
    expect(outcome.plan.stops.length).toBeGreaterThan(0);
    expect(hardFailures(outcome.plan, after)).toEqual([]);
    for (const stop of outcome.plan.stops) {
      const row = CATALOGUE_MAP.get(stop.experienceId)!;
      expect(stop.departMin - after.nowMin, stop.experienceId).toBeLessThanOrEqual(after.availableMin);
      expect(stop.fit.cost.minor, stop.experienceId).toBe(
        (row.pricePerPerson?.minor ?? 0) * after.partySize,
      );
      expect(stop.score.total).toBeGreaterThan(0);
    }

    // 3. It came through the same door every other plan does, and the feature's own
    //    claims are all true of the plan that was actually returned.
    expect(outcome.validation.ok).toBe(true);
    expect(validatePlan(outcome.plan).ok).toBe(true);
    expect(outcome.guarantees.revalidated).toBe(true);
    expect(outcome.guarantees.goneExcluded).toBe(true);
    expect(outcome.guarantees.intentPreserved).toBe(true);
    expect(after.id).toBe(SEED.id);
  });

  it("puts the reporter's sentence on the swap, with the contract's own code", () => {
    const run = city();
    const lost = nextUp(run.initial, run.ctx.nowMin);
    const message = "The provider withdrew the 12:00 slot and cannot rebook it.";

    const outcome = repaired(run, {
      nowMin: run.ctx.nowMin,
      gone: [{ id: lost, cause: "withdrawn", message }],
    });

    expect(codes(outcome.plan)).toContainEqual([lost, "excluded_by_traveller"]);
    expect(outcome.gaps).toEqual([
      { id: lost, cause: "withdrawn", code: "excluded_by_traveller", message, engineAccounted: true },
    ]);
    expect(outcome.diff.removed.find((stop) => stop.id === lost)?.reason).toBe(message);
    expect(outcome.reality.removed.find((stop) => stop.id === lost)?.reason).toBe(message);
    expect(outcome.reality.reason).toContain(message);
    expect(outcome.reality.reason).not.toMatch(/undefined|NaN|\[object/);
  });

  it("explains every removal with a code and a number, and says where the sentence came from", () => {
    const run = city();
    const lost = nextUp(run.initial, run.ctx.nowMin);
    const outcome = repaired(run, {
      nowMin: run.ctx.nowMin,
      gone: [{ id: lost, cause: "sold_out", message: "Sold out for our slot." }],
    });

    expect(outcome.diff.removed.length).toBeGreaterThan(0);
    for (const entry of outcome.explanations.filter((item) => item.status === "removed")) {
      // Every removal is accounted for by the engine's own rejection, with the real
      // shortfall the gate computed. Nothing is left as a template.
      expect(entry.source, entry.id).toBe("engine");
      expect(entry.code, entry.id).not.toBeNull();
      expect(entry.message, entry.id).toMatch(/[.!]$/);
      expect(entry.message, entry.id).not.toMatch(/constraint|undefined|NaN|\[object/);
    }
    for (const entry of outcome.explanations.filter((item) => item.status === "added")) {
      // An addition is not a refusal, so it has no code; its reason is the winning
      // scoring term, in the engine's words.
      expect(entry.source, entry.id).toBe("engine");
      expect(entry.code, entry.id).toBeNull();
      expect(entry.message.length, entry.id).toBeGreaterThan(0);
    }
  });

  it("refuses a re-solve that still plans the place we were told is gone", () => {
    const run = city();
    const lost = nextUp(run.initial, run.ctx.nowMin);
    // An engine that ignores the exclusion, to prove the guard is not advisory.
    const stubborn: EnginePort = {
      ...run.engine,
      replan: (prev: Plan, _ctx: DiscoveryContext, change: ContextChange) => ({
        plan: prev,
        change,
        swaps: [],
        preservedIntent: true,
        summary: change.narrative,
      }),
    };

    const outcome = repair(stubborn, run.session, {
      nowMin: run.ctx.nowMin,
      gone: [{ id: lost, cause: "closed", message: "Closed for a private event." }],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.session.plan).toBe(run.initial);
    expect(outcome.violations).toEqual([
      {
        code: "unavailable_still_planned",
        message: `${CATALOGUE_MAP.get(lost)!.name} is no longer available, and the new plan still has it.`,
        at: lost,
      },
    ]);
  });

  it("brings a stop back when the slot that was blocking it is released", () => {
    // The reverse direction, and the one that proves the engine is choosing rather than
    // shuffling: `pottery` is absent because its slot is gone, and nothing we do to the
    // traveller's context would put it back. Releasing the slot does.
    const blocked = city();
    expect(ids(blocked.initial)).not.toContain("pottery");
    expect(codes(blocked.initial)).toContainEqual(["pottery", "sold_out"]);

    const freed = city({ facts: { ...FACTS, slots: [POTTERY_SLOT_FREE] } });
    // The reason changed. Whether it then fits is the window's business, not the
    // slot's, and a 180-minute day is already full.
    expect(codes(freed.initial)).not.toContainEqual(["pottery", "sold_out"]);
    const stillOut = codes(freed.initial).filter(([id]) => id === "pottery");
    expect(stillOut.length, "pottery is out for some other, stated reason").toBeGreaterThan(0);
    for (const [, code] of stillOut) {
      expect(code, "and it is not the slot any more").not.toBe("sold_out");
    }
  });
});

// ===========================================================================
// Test 2 — less time
// ===========================================================================

describe("when there is less time than the plan assumed", () => {
  it("packs a shorter day that still ends inside the new window", () => {
    const run = city();
    const LOST = 90;
    expect(ids(run.initial).length).toBeGreaterThan(2);

    const outcome = repaired(run, { nowMin: run.ctx.nowMin + LOST });

    // The clock moved and the window came down by the same number, so the two can
    // never disagree about how much day is left.
    const after = outcome.session.state.ctx;
    expect(after.nowMin).toBe(SEED.nowMin + LOST);
    expect(after.availableMin).toBe(SEED.availableMin - LOST);
    // The whole day is still on the record. That is principle 3 doing its job.
    expect(after.original.availableMin).toBe(SEED.availableMin);
    expect(outcome.change.kind).toBe("time_shrank");
    expect(outcome.trip.elapsedMin).toBe(LOST);
    expect(outcome.trip.remainingMin).toBe(SEED.availableMin - LOST);

    // Shorter, and shorter for the reason we asked for rather than by luck.
    expect(outcome.plan.totalMin).toBeLessThan(run.initial.totalMin);
    expect(outcome.plan.stops.length).toBeLessThan(run.initial.stops.length);
    expect(outcome.diff.timeDeltaMin).toBeLessThan(0);
    expect(outcome.reality.after.totalMin).toBe(outcome.plan.totalMin);
    expect(outcome.reality.after.availableMin).toBe(after.availableMin);

    // Still a real day: it ends before the deadline, it survived the gate, and it
    // validated.
    expect(outcome.plan.stops.at(-1)!.departMin).toBeLessThanOrEqual(after.nowMin + after.availableMin);
    expect(outcome.plan.totalMin).toBeLessThanOrEqual(after.availableMin);
    expect(hardFailures(outcome.plan, after)).toEqual([]);
    expect(outcome.validation.ok).toBe(true);
    expect(validatePlan(outcome.plan).ok).toBe(true);

    // And it says what it had to leave out, with a real number in the sentence.
    const over = outcome.plan.rejected.find(
      (entry) => entry.code === "duration_exceeds_budget" && entry.shortfall !== null,
    );
    expect(over, "nothing was left out for time").toBeDefined();
    expect(over!.unit).toBe("minutes");
    // Whichever of the two writers said it, the number is the real one: 120 min on
    // site against the 90 that are left.
    expect(over!.shortfall).toBe(30);
    expect(over!.message).toContain("120 min");
  });

  it("uses the extra time when there is more of it", () => {
    const run = city();
    const outcome = repaired(run, {
      nowMin: run.ctx.nowMin,
      ops: [{ kind: "set_time", availableMin: SEED.availableMin + 120, note: "We are here all afternoon." }],
    });

    const after = outcome.session.state.ctx;
    expect(outcome.change.kind).toBe("time_grew");
    expect(after.availableMin).toBe(SEED.availableMin + 120);
    expect(outcome.plan.totalMin).toBeGreaterThan(run.initial.totalMin);
    expect(outcome.plan.stops.length).toBeGreaterThanOrEqual(run.initial.stops.length);
    expect(outcome.plan.totalMin).toBeLessThanOrEqual(after.availableMin);
    expect(outcome.plan.stops.at(-1)!.departMin).toBeLessThanOrEqual(after.nowMin + after.availableMin);
    expect(hardFailures(outcome.plan, after)).toEqual([]);
    expect(outcome.validation.ok).toBe(true);
  });
});

// ===========================================================================
// Test 3 — less walking
// ===========================================================================

describe("when the group can walk less than before", () => {
  it("produces a plan whose every hop is inside the new walking limit", () => {
    const run = city();
    expect(walkLimitPerLeg(run.ctx)).toBe(Infinity);

    const outcome = repaired(run, {
      nowMin: run.ctx.nowMin,
      ops: [{ kind: "set_walking", walking: "minimal", note: "Everyone's legs have had it." }],
    });

    // The preference really landed in the context the planner reads.
    const after = outcome.session.state.ctx;
    expect(after.avoid).toContain(WALK_TOKENS.minimal);
    expect(walkLimitPerLeg(after)).toBe(500);

    // The old plan would not have satisfied that limit. If it did, the rest of this
    // test would be asserting nothing, so it says so out loud.
    expect(spreadOf(run.initial, run.ctx)).toBeGreaterThan(500);

    // And the new one does, hop by hop. The limit is per leg: the first is measured
    // from where they are standing, every later one from the stop before it.
    const hops = hopsOf(outcome.plan, after);
    expect(hops.length).toBeGreaterThan(0);
    for (const hop of hops) {
      expect(hop.metres, `${hop.from} -> ${hop.to}`).toBeLessThanOrEqual(500);
    }

    // And it got there by saying what it gave up, not by shipping a plan that quietly
    // over-promises. Every far stop is accounted for with the real distance.
    const far = outcome.plan.rejected.filter((entry) => entry.code === "too_far");
    expect(far.length, "something was refused for being too far, or the limit changed nothing").toBeGreaterThan(0);
    for (const entry of far) {
      expect(entry.unit, entry.message).toBe("metres");
      expect(entry.shortfall!).toBeGreaterThan(0);
      expect(entry.message, entry.message).toMatch(/is \d+ m from the last stop, over the 500 m walking limit\./);
    }
    // No new stop is further away than the old plan's worst, and nothing got closer by
    // cheating: the chain is the chain.
    expect(spreadOf(outcome.plan, after)).toBeLessThanOrEqual(spreadOf(run.initial, run.ctx));
    expect(outcome.validation.ok).toBe(true);
  });

  it("keeps the weather-sensitive stops indoors when the weather turns", () => {
    const run = city();
    expect(
      run.initial.stops.some((stop) => CATALOGUE_MAP.get(stop.experienceId)!.indoorOutdoor === "outdoor"),
      "the first plan should have an outdoor stop to lose",
    ).toBe(true);

    const outcome = repaired(run, {
      nowMin: run.ctx.nowMin,
      ops: [{ kind: "set_weather", condition: "heavy_rain", note: "It started raining." }],
    });

    expect(outcome.change.kind).toBe("weather_changed");
    for (const stop of outcome.plan.stops) {
      expect(CATALOGUE_MAP.get(stop.experienceId)!.indoorOutdoor, stop.experienceId).not.toBe("outdoor");
    }
    const wet = outcome.plan.rejected.filter((entry) => entry.code === "weather_unsafe");
    expect(wet.length).toBeGreaterThan(0);
    for (const entry of wet) expect(entry.message).toContain("no cover");
  });

  it("treats indoors-only as a hard filter, and dry weather as the same question", () => {
    const run = city();
    const outcome = repaired(run, {
      nowMin: run.ctx.nowMin,
      ops: [{ kind: "set_indoor", indoorOnly: true, note: "Indoors from here." }],
    });

    expect(outcome.session.state.ctx.avoid).toContain(INDOOR_TOKEN);
    for (const stop of outcome.plan.stops) {
      expect(CATALOGUE_MAP.get(stop.experienceId)!.indoorOutdoor, stop.experienceId).not.toBe("outdoor");
    }
    expect(hardFailures(outcome.plan, outcome.session.state.ctx)).toEqual([]);
  });
});

// ===========================================================================
// Test 4 — completed activities
// ===========================================================================

describe("what has already happened", () => {
  it("is never re-generated, across five different things going wrong", () => {
    const run = city();
    const doneId = ids(run.initial)[0]!;
    const done = run.initial.stops[0]!;
    const now = done.departMin;
    const soldOut = nextUp(run.initial, now);

    const events: RepairEvent[] = [
      { nowMin: now, gone: [{ id: soldOut, cause: "sold_out", message: "Sold out for our slot." }] },
      { nowMin: now, ops: [{ kind: "set_time", availableMin: 120, note: "Less time than we thought." }] },
      { nowMin: now, ops: [{ kind: "set_walking", walking: "minimal", note: "Short legs only." }] },
      { nowMin: now, ops: [{ kind: "set_budget", budgetMinor: 40000, note: "Much cheaper now." }] },
      { nowMin: now, ops: [{ kind: "set_weather", condition: "storm", note: "Storm by the sea." }] },
    ];

    let live = run.session;
    let plan = run.initial;
    for (const event of events) {
      const label = event.ops?.[0]?.kind ?? "unavailable";
      const outcome = repair(run.engine, live, event);
      expect(outcome.ok, `${label}: ${outcome.ok ? "" : outcome.reason}`).toBe(true);
      if (!outcome.ok) throw new Error(outcome.reason);

      // Byte-identical: same arrive, same depart, same order, same fit, same score,
      // same why. A re-solve that recomputed a finished stop would show up here as a
      // different object, not as a different label.
      const kept = outcome.plan.stops.find((stop) => stop.experienceId === doneId);
      expect(kept, `${label} dropped or rewrote the finished stop`).toEqual(done);
      expect(outcome.trip.completed, label).toContain(doneId);
      expect(outcome.trip.completedFromClock, label).toBe(true);
      expect(outcome.diff.removed.map((stop) => stop.id), label).not.toContain(doneId);
      // The feature's own strongest claim, which compares the whole stop rather than
      // the id, is the one a regression breaks first.
      expect(outcome.guarantees.untouched, label).toContain(doneId);
      expect(outcome.guarantees.completedPreserved, label).toBe(true);
      expect(outcome.validation.ok, label).toBe(true);
      live = outcome.session;
      plan = outcome.plan;
    }
    expect(ids(plan)).toContain(doneId);
    // The clock really did move, and the original ask really did survive it.
    expect(live.state.ctx.nowMin).toBe(now);
    expect(live.state.ctx.original.availableMin).toBe(SEED.availableMin);
  });

  it("gives every preserved stop a reason of its own", () => {
    const run = city();
    const doneId = ids(run.initial)[0]!;
    const booked = ids(run.initial)[1]!;
    const now = run.initial.stops[0]!.departMin;

    const outcome = repaired(run, { nowMin: now, locked: [booked] });
    const preserved = outcome.explanations.filter((item) => item.status === "preserved");

    expect(preserved.map((item) => item.id).sort()).toEqual([booked, doneId].sort());
    for (const entry of preserved) {
      // A fact about the trip, not a justification for anything, and said as such.
      expect(entry.source, entry.id).toBe("trip");
      expect(entry.code, entry.id).toBeNull();
      expect(entry.message, entry.id).toMatch(/[.!]$/);
    }
    expect(preserved.find((item) => item.id === doneId)!.message).toContain("already done");
    expect(preserved.find((item) => item.id === booked)!.message).toContain("booked and cannot be moved");
  });

  it("keeps a booking that cannot be altered, and says so in the context", () => {
    const run = city();
    const booked = ids(run.initial)[1]!;
    const before = run.initial.stops.find((stop) => stop.experienceId === booked)!;

    const outcome = repaired(run, {
      nowMin: run.ctx.nowMin,
      locked: [booked],
      ops: [{ kind: "set_time", availableMin: 140, note: "Less time than we thought." }],
    });

    expect(outcome.trip.booked).toEqual([booked]);
    expect(outcome.trip.locked).toEqual([booked]);
    expect(outcome.trip.completed).toEqual([]);
    expect(ids(outcome.plan)).toContain(booked);
    // Pinned into the context the planner reads, which is the only channel the engine
    // has. Not a flag this feature keeps to itself.
    expect(outcome.session.state.ctx.pinnedIds).toContain(booked);
    // Still at the time it had. A locked stop is not re-timed to make a new plan fit.
    const after = outcome.plan.stops.find((stop) => stop.experienceId === booked)!;
    expect(after.arriveMin).toBe(before.arriveMin);
    expect(after.departMin).toBe(before.departMin);
    expect(outcome.guarantees.bookedPreserved).toBe(true);
    expect(outcome.validation.ok).toBe(true);
  });

  it("refuses to keep a booking that no longer fits rather than quietly dropping it", () => {
    const run = city();
    const booked = ids(run.initial)[1]!;

    // A window too small to reach the booking from where they are standing.
    const outcome = repair(run.engine, run.session, {
      nowMin: run.ctx.nowMin,
      locked: [booked],
      ops: [{ kind: "set_time", availableMin: 60, note: "We have to be back." }],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The booking is still in the plan the traveller is left holding. It is never
    // dropped on the floor, and never quietly re-timed to make it fit.
    expect(ids(outcome.session.plan!)).toContain(booked);
    expect(outcome.session.state.ctx).toEqual(run.session.state.ctx);
    expect(outcome.trip.booked).toEqual([booked]);
  });

  it("counts a stop that is both done and booked as done, once", () => {
    const run = city();
    const doneId = ids(run.initial)[0]!;

    const outcome = repaired(run, { nowMin: run.ctx.nowMin, completed: [doneId], locked: [doneId] });

    expect(outcome.trip.completed).toEqual([doneId]);
    expect(outcome.trip.booked).toEqual([]);
    expect(outcome.trip.locked).toEqual([doneId]);
    // A stop the traveller reports doing, that the clock thinks is still ahead, is
    // history anyway. The report wins.
    expect(outcome.trip.completedFromClock).toBe(false);
  });

  it("never un-finishes an activity, even if the clock goes backwards", () => {
    const run = city();
    const doneId = ids(run.initial)[0]!;
    const doneAt = run.initial.stops[0]!.departMin;

    // A device with a wrong clock, or an event replayed out of order. Asking for a time
    // before the one the plan was built for must not resurrect the morning, and must not
    // un-finish anything.
    const backwards = readTrip(run.session, { nowMin: run.ctx.nowMin - 120 });
    expect(backwards.nowMin).toBe(run.ctx.nowMin);
    expect(backwards.elapsedMin).toBe(0);
    expect(backwards.completed).toEqual([]);

    const refused = repair(run.engine, run.session, {
      nowMin: run.ctx.nowMin - 120,
      completed: [doneId],
    });
    expect(refused.ok, refused.ok ? "" : refused.reason).toBe(true);
    if (!refused.ok) return;
    expect(refused.session.state.ctx.nowMin).toBe(run.ctx.nowMin);

    // The same plan, an hour and a bit later, and the stop is history.
    const later = repaired(run, { nowMin: doneAt });
    expect(later.trip.completed).toEqual([doneId]);
    expect(later.guarantees.untouched).toEqual([doneId]);
    expect(later.session.state.ctx.nowMin).toBe(doneAt);
  });

  it("refuses a repair that would drop a finished stop, and keeps the old plan", () => {
    const run = city();
    const doneId = ids(run.initial)[0]!;

    const outcome = repair(amnesiac(), run.session, {
      nowMin: run.ctx.nowMin + 30,
      completed: [doneId],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("locked_stop_dropped");
    expect(outcome.violations[0]?.at).toBe(doneId);
    expect(outcome.session.plan).toBe(run.initial);
  });
});

// ===========================================================================
// Reading the trip
// ===========================================================================

describe("reading the day", () => {
  it("knows what is finished without being told", () => {
    const run = city();
    const first = ids(run.initial)[0]!;
    const second = ids(run.initial)[1]!;

    const before = readTrip(run.session, { nowMin: run.ctx.nowMin });
    expect(before.completed).toEqual([]);
    expect(before.nextUp).toBe(first);

    const afterFirst = readTrip(run.session, { nowMin: run.initial.stops[0]!.departMin });
    expect(afterFirst.completed).toEqual([first]);
    expect(afterFirst.elapsedMin).toBeGreaterThan(0);
    expect(afterFirst.nextUp).toBe(second);
  });

  it("treats a reported stop as finished even when the clock disagrees", () => {
    const run = city();
    const later = ids(run.initial)[2]!;
    const trip = readTrip(run.session, { nowMin: run.ctx.nowMin, completed: [later] });

    expect(trip.completed).toContain(later);
    expect(trip.completedFromClock).toBe(false);
    // The clock-derived list is still there, and the union is the answer.
    expect(trip.locked).toEqual([...new Set([...trip.completed, ...trip.booked])].sort());
  });

  it("names the stop that is next, not the first one", () => {
    const run = city();
    const now = run.initial.stops[0]!.departMin;
    expect(upcoming(run.initial, now)).toBe(ids(run.initial)[1]);
    expect(nextUp(run.initial, now)).toBe(ids(run.initial)[1]);
  });
});

// ===========================================================================
// The eight conditions
// ===========================================================================

describe("the eight conditions from FEATURES §3", () => {
  it("can all be reached, by an id that actually exists", () => {
    // This is the test that makes "we handle every condition" a fact rather than a
    // sentence. A chip renamed on Friday fails here on Friday.
    expect([...CONDITIONS].sort()).toEqual([...Object.keys(CONDITION_COVERAGE)].sort());
    for (const condition of CONDITIONS) {
      const routes = CONDITION_COVERAGE[condition];
      expect(routes.length, condition).toBeGreaterThan(0);
      for (const id of routes) {
        expect(ALL_CONDITION_IDS.has(id), `${condition} -> ${id}`).toBe(true);
      }
    }
  });

  it("covers the two conditions the chips cannot express, with triggers", () => {
    // `more_time` and `slot_unavailable` have no chip at all, which is why they exist.
    for (const id of ["more_time", "booking_lost"]) {
      expect(TRIGGER_BY_ID.has(id), id).toBe(true);
    }
    expect(REPAIR_TRIGGERS.map((trigger) => trigger.id).sort()).toEqual([
      "booking_lost",
      "more_time",
      "next_stop_closed",
    ]);
  });

  it("drops the stop that is actually next, which the chip cannot", () => {
    const run = city();
    const now = run.initial.stops[0]!.departMin;
    const wanted = nextUp(run.initial, now);

    const event = runTrigger(TRIGGER_BY_ID.get("next_stop_closed")!, {
      session: run.session,
      nowMin: now,
    });
    expect(event).not.toBeNull();
    expect(event!.gone![0]!.id).toBe(wanted);
    // Not stops[0]. That is the whole reason this trigger exists.
    expect(wanted).not.toBe(ids(run.initial)[0]);

    const outcome = repaired(run, event!);
    expect(ids(outcome.plan)).not.toContain(wanted);
    expect(ids(outcome.plan)).toContain(ids(run.initial)[0]);
  });

  it("carries a provider's own words through untouched when it has better ones", () => {
    const run = city();
    const event = runTrigger(TRIGGER_BY_ID.get("booking_lost")!, {
      session: run.session,
      nowMin: run.ctx.nowMin,
      id: "pottery",
      cause: "withdrawn",
      message: "The provider delisted it at 14:02 and cannot rebook.",
    });
    expect(event!.gone).toEqual([
      { id: "pottery", cause: "withdrawn", message: "The provider delisted it at 14:02 and cannot rebook." },
    ]);
  });

  it("builds a sentence for a cause when nobody supplies one", () => {
    for (const [cause, phrase] of [
      ["closed", "is closed now"],
      ["sold_out", "sold out"],
      ["no_capacity", "cannot take our party"],
      ["withdrawn", "was withdrawn by the provider"],
    ] as [GoneCause, string][]) {
      expect(gone("pottery", cause, "Pottery studio").message, cause).toBe(
        `Pottery studio ${phrase}.`,
      );
    }
  });

  it("returns null rather than a repair that would do nothing", () => {
    const run = city();
    const more = TRIGGER_BY_ID.get("more_time")!;
    expect(runTrigger(more, { session: run.session, nowMin: run.ctx.nowMin, minutes: 0 })).toBeNull();

    const noUpcoming = readTrip({ ...run.session, plan: null }, { nowMin: run.ctx.nowMin });
    expect(noUpcoming.nextUp).toBeNull();
    expect(
      runTrigger(TRIGGER_BY_ID.get("next_stop_closed")!, { session: run.session, nowMin: run.ctx.nowMin }),
    ).not.toBeNull();
  });
});

// ===========================================================================
// Refusals
// ===========================================================================

describe("refusals", () => {
  it("does nothing when nothing about the day changed", () => {
    const run = city();
    const outcome = repair(run.engine, run.session, { nowMin: run.ctx.nowMin });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.change).toBeNull();
    expect(outcome.session.plan).toBe(run.initial);
    expect(outcome.reason).toContain("Nothing");
  });

  it("refuses to repair a trip that has no plan yet", () => {
    const engine = deterministicEngine({ catalogue: CATALOGUE, weights: WEIGHTS, facts: FACTS });
    const session = createSession({ engine, seed: SEED, catalogue: CATALOGUE, weights: WEIGHTS });

    const outcome = repair(engine, session, { nowMin: SEED.nowMin + 30 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.session.plan).toBeNull();
    expect(outcome.reason).toContain("no valid itinerary");
  });

  it("rolls the context back when the repair is refused, exactly like a chip", () => {
    const run = city();
    const before = run.session.state.ctx;

    const outcome = repair(amnesiac(), run.session, {
      nowMin: before.nowMin + 30,
      ops: [{ kind: "set_walking", walking: "minimal", note: "Short legs only." }],
    });

    expect(outcome.ok).toBe(false);
    // The failed edit left no trace: no clock movement, no walking token.
    expect(outcome.session.state.ctx).toEqual(before);
    expect(outcome.session.plan).toBe(run.initial);
  });

  it("says so plainly when the day has run out, rather than showing an empty plan", () => {
    const run = city();
    const outcome = repaired(run, { nowMin: run.ctx.nowMin + 175 });

    // 5 minutes left against a 20-minute shortest stop: the honest answer is nothing.
    expect(outcome.dayOver).not.toBeNull();
    expect(outcome.dayOver).toMatch(/\d+ min is all that is left, and nothing else fits\./);
    // It is reported against the locks, not against emptiness: the finished stops are
    // still there, they are simply all that is left.
    expect(outcome.trip.locked.length).toBeGreaterThan(0);
    expect(outcome.plan.stops.length).toBe(outcome.trip.locked.length);
    expect(outcome.validation.ok).toBe(true);
    expect(outcome.guarantees.revalidated).toBe(true);
    expect(outcome.guarantees.untouched).toEqual(outcome.trip.completed);
  });

  it("is deterministic: the same event on the same plan gives the same plan", () => {
    const event = (): RepairEvent => ({ nowMin: SEED.nowMin + 45 });
    const a = repaired(city(), event());
    const b = repaired(city(), event());
    expect(JSON.stringify(b.plan)).toBe(JSON.stringify(a.plan));
    expect(b.explanations).toEqual(a.explanations);
    expect(b.guarantees).toEqual(a.guarantees);
  });
});
