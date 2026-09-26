/**
 * Realistic repair, against an engine that decides rather than one that answers.
 *
 * `discovery.test.ts` covers the feature against `fakeEngine`, which returns the
 * plan the test hands it. That is right for the diff, the guard and the panel, and
 * it cannot answer the only question this file asks: **when the day goes wrong,
 * does the itinerary actually change into something feasible?**
 *
 * So this file drives the same production entry points — `createSession`,
 * `discover`, `repair` — against `deterministicEngine()` in `./engine`, which runs
 * a real feasibility -> scoring -> packing pipeline. Every assertion below reads
 * `Plan.stops`, `Plan.legs`, `Plan.rejected`, `DiscoveryContext` or
 * `RepairOutcome`; none of them reads a label. A fixture that answered from a
 * table could not pass any of them, and neither could a display-only swap.
 *
 * Imports are deliberately module-relative rather than through the `..` barrel, so
 * a broken sibling module cannot take this file down with it.
 */
import { describe, expect, it } from "vitest";
import { type ContextChange, type DiscoveryContext, type Plan, type RejectionCode } from "../../../contracts";
import { INDOOR_TOKEN, WALK_TOKENS, type ContextSeed } from "../context";
import type { EnginePort } from "../engine";
import { type RepairEvent, repair } from "../repair";
import { createSession, discover, type DiscoverySession } from "../replanner";
import {
  check,
  deterministicEngine,
  metresBetween,
  validatePlan,
  walkLimitPerLeg,
  type FixtureOptions,
} from "./engine";
import { WEIGHTS, exp } from "./fixtures";

// ---------------------------------------------------------------------------
// A small, walkable city
// ---------------------------------------------------------------------------

const ORIGIN = { lat: 19.0, lon: 72.87 };
const PARTY = 2;

const SEED: ContextSeed = {
  id: "ctx-repair",
  origin: { label: "Colaba", point: ORIGIN },
  availableMin: 180,
  nowMin: 600,
  budgetMinor: 200000,
  partySize: PARTY,
  interests: ["market", "cafe", "street_food"],
};

const price = (minor: number) => ({ minor, currency: "INR" as const });

/** 250 m, 350 m and then 1 km / 1.1 km / 3.9 km / 5.5 km hops from the origin. */
const CATALOGUE = [
  exp({ id: "chai", name: "Chai stall", category: "street_food", indoorOutdoor: "outdoor", durationMin: 20, pricePerPerson: price(10000), location: { lat: 19.002, lon: 72.871 }, keywords: ["street_food"], weatherSensitive: "rain" }),
  exp({ id: "market", name: "Colaba Market", category: "market", indoorOutdoor: "outdoor", durationMin: 45, pricePerPerson: price(20000), location: { lat: 19.005, lon: 72.872 }, keywords: ["market", "local"], weatherSensitive: "rain" }),
  exp({ id: "cafe", name: "Cafe with a courtyard", category: "cafe", indoorOutdoor: "covered", durationMin: 40, pricePerPerson: price(25000), location: { lat: 19.012, lon: 72.878 }, keywords: ["cafe"] }),
  exp({ id: "mosque", name: "Neighbourhood mosque", category: "mosque", indoorOutdoor: "indoor", durationMin: 25, pricePerPerson: price(0), location: { lat: 19.008, lon: 72.882 }, keywords: ["heritage"] }),
  exp({ id: "tiffin", name: "Tiffin room", category: "restaurant", indoorOutdoor: "indoor", durationMin: 50, pricePerPerson: price(30000), location: { lat: 19.02, lon: 72.884 }, keywords: ["street_food", "food"] }),
  exp({ id: "gallery", name: "Art gallery", category: "gallery", indoorOutdoor: "indoor", durationMin: 60, pricePerPerson: price(40000), location: { lat: 19.03, lon: 72.892 }, keywords: ["gallery", "heritage"] }),
  exp({ id: "photowalk", name: "Photography walk", category: "adventure", indoorOutdoor: "outdoor", durationMin: 120, pricePerPerson: price(15000), location: { lat: 19.0085, lon: 72.8825 }, keywords: ["nature"] }),
];

const CATALOGUE_MAP = new Map(CATALOGUE.map((item) => [item.id, item]));
const at = (id: string) => CATALOGUE_MAP.get(id)!.location;

// ---------------------------------------------------------------------------
// The app's own path
// ---------------------------------------------------------------------------

function engineFor(overrides: Partial<FixtureOptions> = {}) {
  return deterministicEngine({ catalogue: CATALOGUE, weights: WEIGHTS, ...overrides });
}

/** Seed a session and build its first plan, the way the app does. */
function started(): {
  engine: ReturnType<typeof engineFor>;
  session: DiscoverySession;
  initial: Plan;
  ctx: DiscoveryContext;
} {
  const engine = engineFor();
  const session = createSession({ engine, seed: SEED, catalogue: CATALOGUE, weights: WEIGHTS });
  const first = discover(engine, session);
  if (!first.ok) throw new Error(`the catalogue produced no plan: ${first.reason}`);
  return { engine, session: first.session, initial: first.plan, ctx: first.session.state.ctx };
}

/**
 * An engine that re-solves correctly but forgets the pins it was given: it packs
 * an empty day. The lock check is the only thing between that and a traveller
 * losing a market they already walked to.
 */
function amnesiac(): EnginePort {
  const engine = engineFor();
  return {
    ...engine,
    replan: (_prev: Plan, ctx: DiscoveryContext, change: ContextChange) => ({
      plan: deterministicEngine({ catalogue: CATALOGUE, weights: WEIGHTS }).pack(ctx, []),
      change,
      swaps: [],
      preservedIntent: true,
      summary: change.narrative,
    }),
  };
}

const ids = (plan: Plan): string[] => plan.stops.map((stop) => stop.experienceId);
const codes = (plan: Plan): [string, RejectionCode][] =>
  plan.rejected.map((entry) => [entry.experienceId, entry.code] as [string, RejectionCode]);

/** The first stop the traveller has not reached yet. */
function nextUp(plan: Plan, nowMin: number): string {
  const stop = plan.stops.find((item) => item.departMin > nowMin);
  if (!stop) throw new Error("the plan has no upcoming stop");
  return stop.experienceId;
}

/**
 * The largest hop between consecutive stops, in metres, through the same
 * great-circle the router fixture uses. "How far apart is this plan" is a
 * property of the plan, so the test measures it rather than reading a claim.
 */
function spreadOf(plan: Plan, ctx: DiscoveryContext): number {
  let worst = 0;
  let here = ctx.origin.point ?? ORIGIN;
  for (const stop of plan.stops) {
    worst = Math.max(worst, metresBetween(here, at(stop.experienceId)));
    here = at(stop.experienceId);
  }
  return worst;
}

/** Runs a repair and fails loudly, so a later assertion cannot drift past it. */
function repaired(engine: ReturnType<typeof engineFor>, session: DiscoverySession, event: RepairEvent) {
  const outcome = repair(engine, session, event);
  expect(
    outcome.ok,
    outcome.ok ? "" : `${outcome.reason} ${JSON.stringify(outcome.violations)}`,
  ).toBe(true);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome;
}

// ===========================================================================
// Test 1 — an experience becomes unavailable
// ===========================================================================

describe("an experience that is no longer available", () => {
  it("gets replaced by a feasible stop the pipeline chose", () => {
    const { engine, session, initial, ctx } = started();
    const gone = nextUp(initial, ctx.nowMin);

    const outcome = repaired(engine, session, {
      nowMin: ctx.nowMin,
      gone: [{ id: gone, cause: "sold_out", message: "Colaba Market sold out for the 11:00 slot." }],
    });

    // 1. The itinerary actually changed, and it changed because the place is gone.
    expect(ids(outcome.plan)).not.toEqual(ids(initial));
    expect(ids(outcome.plan)).not.toContain(gone);
    expect(outcome.diff.removed.map((stop) => stop.id)).toEqual([gone]);
    expect(outcome.diff.added.length).toBeGreaterThan(0);

    // 2. The replacement is real: a catalogue row that passes the same hard gate
    //    the engine applied, fits the window it was solved in, and costs what the
    //    plan says it costs. Re-derived here, not read off a label.
    const after = outcome.session.state.ctx;
    expect(outcome.plan.stops.length).toBeGreaterThan(0);
    for (const stop of outcome.plan.stops) {
      const row = CATALOGUE_MAP.get(stop.experienceId);
      expect(row, stop.experienceId).toBeDefined();
      expect(check(after, row!, null), stop.experienceId).toBeNull();
      expect(stop.departMin - after.nowMin).toBeLessThanOrEqual(after.availableMin);
      expect(stop.fit.cost.minor).toBe((row!.pricePerPerson?.minor ?? 0) * after.partySize);
      expect(stop.score.total).toBeGreaterThan(0);
    }

    // 3. It came through the same door every other plan does.
    expect(outcome.validation.ok).toBe(true);
    expect(validatePlan(outcome.plan).ok).toBe(true);
    expect(outcome.session.state.ctx.id).toBe(SEED.id);
  });

  it("records why it is gone, in the contract's own vocabulary", () => {
    const { engine, session, initial, ctx } = started();
    const gone = nextUp(initial, ctx.nowMin);
    const message = "The provider withdrew the 12:00 slot and cannot rebook it.";

    const outcome = repaired(engine, session, {
      nowMin: ctx.nowMin,
      gone: [{ id: gone, cause: "withdrawn", message }],
    });

    expect(codes(outcome.plan)).toContainEqual([gone, "excluded_by_traveller"]);
    expect(outcome.gaps).toEqual([
      { id: gone, cause: "withdrawn", code: "excluded_by_traveller", message, engineAccounted: true },
    ]);
    // The diff, the panel and the headline all carry the reporter's sentence.
    expect(outcome.diff.removed.find((stop) => stop.id === gone)?.reason).toBe(message);
    expect(outcome.reality.removed.find((stop) => stop.id === gone)?.reason).toBe(message);
    expect(outcome.reality.reason).toContain(message);
    expect(outcome.reality.reason).not.toMatch(/undefined|NaN|\[object/);
  });

  it("refuses a re-solve that still plans the place we were told is gone", () => {
    const { engine, session, initial, ctx } = started();
    const gone = nextUp(initial, ctx.nowMin);
    // An engine that ignores the exclusion, to prove the guard is not advisory.
    const stubborn: EnginePort = {
      ...engine,
      replan: (prev: Plan, _ctx: DiscoveryContext, change: ContextChange) => ({
        plan: prev,
        change,
        swaps: [],
        preservedIntent: true,
        summary: change.narrative,
      }),
    };

    const outcome = repair(stubborn, session, {
      nowMin: ctx.nowMin,
      gone: [{ id: gone, cause: "closed", message: "Closed for a private event." }],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.session.plan).toBe(initial);
    expect(outcome.violations).toEqual([
      {
        code: "unavailable_still_planned",
        message: `${CATALOGUE_MAP.get(gone)!.name} is no longer available, and the new plan still has it.`,
        at: gone,
      },
    ]);
  });
});

// ===========================================================================
// Test 2 — less time
// ===========================================================================

describe("when there is less time than the plan assumed", () => {
  it("packs a shorter day that still ends inside the new window", () => {
    const { engine, session, initial, ctx } = started();
    const LOST = 90;
    expect(ids(initial).length).toBeGreaterThan(2);

    const outcome = repaired(engine, session, { nowMin: ctx.nowMin + LOST });

    // The clock moved and the window came down by the same number, so the two can
    // never disagree about how much day is left.
    const after = outcome.session.state.ctx;
    expect(after.nowMin).toBe(SEED.nowMin + LOST);
    expect(after.availableMin).toBe(SEED.availableMin - LOST);
    // The whole day is still on the record. That is principle 3 doing its job.
    expect(after.original.availableMin).toBe(SEED.availableMin);
    expect(outcome.change.kind).toBe("time_shrank");

    // Shorter, and shorter for the reason we asked for rather than by luck.
    expect(outcome.plan.totalMin).toBeLessThan(initial.totalMin);
    expect(outcome.plan.stops.length).toBeLessThan(initial.stops.length);
    expect(outcome.diff.timeDeltaMin).toBeLessThan(0);
    expect(outcome.reality.after.totalMin).toBe(outcome.plan.totalMin);
    expect(outcome.reality.after.availableMin).toBe(after.availableMin);

    // Still a real day: it ends before the deadline and it validated.
    expect(outcome.plan.stops.at(-1)!.departMin).toBeLessThanOrEqual(after.nowMin + after.availableMin);
    expect(outcome.plan.totalMin).toBeLessThanOrEqual(after.availableMin);
    expect(outcome.validation.ok).toBe(true);
    expect(validatePlan(outcome.plan).ok).toBe(true);

    // And it says what it had to leave out, with a real number in the sentence.
    const photowalk = outcome.plan.rejected.find((entry) => entry.experienceId === "photowalk");
    expect(photowalk?.code).toBe("duration_exceeds_budget");
    expect(photowalk?.shortfall).toBe(30);
    expect(photowalk?.message).toContain("90 min are left");
  });

  it("uses the extra time when there is more of it", () => {
    const { engine, session, initial, ctx } = started();
    const outcome = repaired(engine, session, {
      nowMin: ctx.nowMin,
      ops: [{ kind: "set_time", availableMin: SEED.availableMin + 120, note: "We are here all afternoon." }],
    });

    const after = outcome.session.state.ctx;
    expect(outcome.change.kind).toBe("time_grew");
    expect(after.availableMin).toBe(SEED.availableMin + 120);

    // More window, a longer day, and still a day that fits inside it.
    expect(outcome.plan.totalMin).toBeGreaterThan(initial.totalMin);
    expect(outcome.plan.stops.length).toBeGreaterThanOrEqual(initial.stops.length);
    expect(outcome.plan.totalMin).toBeLessThanOrEqual(after.availableMin);
    expect(outcome.plan.stops.at(-1)!.departMin).toBeLessThanOrEqual(after.nowMin + after.availableMin);
    expect(outcome.validation.ok).toBe(true);
  });
});

// ===========================================================================
// Test 3 — less walking
// ===========================================================================

describe("when the group can walk less than before", () => {
  it("produces a plan whose every hop is inside the new walking limit", () => {
    const { engine, session, initial, ctx } = started();
    expect(walkLimitPerLeg(ctx)).toBe(Infinity);

    const outcome = repaired(engine, session, {
      nowMin: ctx.nowMin,
      ops: [{ kind: "set_walking", walking: "minimal", note: "Everyone's legs have had it." }],
    });

    // The preference really landed in the context the planner reads.
    const after = outcome.session.state.ctx;
    expect(after.avoid).toContain(WALK_TOKENS.minimal);
    expect(walkLimitPerLeg(after)).toBe(500);

    // The old plan would not have satisfied that limit. If it did, the rest of
    // this test would be asserting nothing, so it says so out loud.
    expect(spreadOf(initial, ctx)).toBeGreaterThan(500);

    // And the new one does, hop by hop, through the same router. The limit is per
    // leg, so the first hop is measured from where they are standing and every
    // later one from the stop before it.
    const hops = outcome.plan.stops.map((stop) => at(stop.experienceId) ?? ORIGIN);
    expect(outcome.plan.stops.length).toBeGreaterThan(0);
    expect(spreadOf(outcome.plan, after)).toBeLessThanOrEqual(500);
    expect(metresBetween(after.origin.point ?? ORIGIN, hops[0]!)).toBeLessThanOrEqual(500);
    for (let i = 1; i < hops.length; i += 1) {
      expect(metresBetween(hops[i - 1]!, hops[i]!), `hop ${i}`).toBeLessThanOrEqual(500);
    }

    // It got there by planning less, and by saying what it gave up — not by
    // shipping a plan that quietly over-promises.
    expect(outcome.plan.stops.length).toBeLessThan(initial.stops.length);
    expect(outcome.plan.rejected.filter((entry) => entry.code === "too_far").length).toBeGreaterThan(0);
    expect(outcome.diff.removed.length).toBeGreaterThan(0);
    expect(outcome.validation.ok).toBe(true);
  });

  it("keeps the walking-sensitive stops indoors when the weather turns", () => {
    const { engine, session, initial, ctx } = started();
    expect(initial.stops.some((stop) => CATALOGUE_MAP.get(stop.experienceId)!.indoorOutdoor === "outdoor")).toBe(true);

    const outcome = repaired(engine, session, {
      nowMin: ctx.nowMin,
      ops: [{ kind: "set_weather", condition: "heavy_rain", note: "It started raining." }],
    });

    expect(outcome.change.kind).toBe("weather_changed");
    for (const stop of outcome.plan.stops) {
      expect(CATALOGUE_MAP.get(stop.experienceId)!.indoorOutdoor, stop.experienceId).not.toBe("outdoor");
    }
    for (const entry of outcome.plan.rejected) {
      if (entry.code === "weather_unsafe") expect(entry.message).toContain("no cover");
    }
    expect(outcome.plan.rejected.some((entry) => entry.code === "weather_unsafe")).toBe(true);
  });

  it("treats indoors-only as a hard filter", () => {
    const { engine, session, ctx } = started();
    const outcome = repaired(engine, session, {
      nowMin: ctx.nowMin,
      ops: [{ kind: "set_indoor", indoorOnly: true, note: "Indoors from here." }],
    });

    expect(outcome.session.state.ctx.avoid).toContain(INDOOR_TOKEN);
    for (const stop of outcome.plan.stops) {
      expect(CATALOGUE_MAP.get(stop.experienceId)!.indoorOutdoor, stop.experienceId).not.toBe("outdoor");
    }
  });
});

// ===========================================================================
// Test 4 — completed activities
// ===========================================================================

describe("what has already happened", () => {
  it("is never re-generated, across five different things going wrong", () => {
    const { engine, session, initial, ctx } = started();
    const doneId = ids(initial)[0]!;
    const done = initial.stops[0]!;
    const now = done.departMin;
    const soldOut = nextUp(initial, now);

    const events: RepairEvent[] = [
      { nowMin: now, gone: [{ id: soldOut, cause: "sold_out", message: "Sold out for our slot." }] },
      { nowMin: now, ops: [{ kind: "set_time", availableMin: 90, note: "Less time than we thought." }] },
      { nowMin: now, ops: [{ kind: "set_walking", walking: "minimal", note: "Short legs only." }] },
      { nowMin: now, ops: [{ kind: "set_budget", budgetMinor: 30000, note: "Much cheaper now." }] },
      { nowMin: now, ops: [{ kind: "set_weather", condition: "storm", note: "Storm by the sea." }] },
    ];

    let live = session;
    for (const event of events) {
      const label = event.ops?.[0]?.kind ?? "unavailable";
      const outcome = repaired(engine, live, event);

      // Byte-identical: same arrive, same depart, same order, same fit, same
      // score, same why. A re-solve that recomputed a finished stop would show
      // up here as a different object, not as a different label.
      const kept = outcome.plan.stops.find((stop) => stop.experienceId === doneId);
      expect(kept, `${label} dropped or rewrote the finished stop`).toEqual(done);
      expect(outcome.locks.completed).toContain(doneId);
      expect(outcome.locks.completedFromClock).toBe(true);
      expect(outcome.diff.removed.map((stop) => stop.id)).not.toContain(doneId);
      expect(outcome.validation.ok, label).toBe(true);
      live = outcome.session;
    }
    expect(ids(live.plan!)).toContain(doneId);
    // The clock really did move, and the original ask really did survive it.
    expect(live.state.ctx.nowMin).toBe(now);
    expect(live.state.ctx.original.availableMin).toBe(SEED.availableMin);
    expect(ctx.id).toBe(SEED.id);
  });

  it("keeps a booking that cannot be altered, and says so in the context", () => {
    const { engine, session, initial, ctx } = started();
    const booked = ids(initial)[1]!;

    const outcome = repaired(engine, session, {
      nowMin: ctx.nowMin,
      locked: [booked],
      ops: [{ kind: "set_time", availableMin: 120, note: "Half an hour less than we thought." }],
    });

    expect(outcome.locks.booked).toEqual([booked]);
    expect(outcome.locks.hold).toEqual([booked]);
    expect(outcome.locks.completed).toEqual([]);
    expect(ids(outcome.plan)).toContain(booked);
    // Pinned into the context the planner reads, which is the only channel the
    // engine has. Not a flag this feature keeps to itself.
    expect(outcome.session.state.ctx.pinnedIds).toContain(booked);
    // The booking still sits at the time it had. A locked stop is not re-timed.
    expect(outcome.plan.stops.find((stop) => stop.experienceId === booked)?.arriveMin).toBe(
      initial.stops.find((stop) => stop.experienceId === booked)?.arriveMin,
    );
    expect(outcome.validation.ok).toBe(true);
  });

  it("refuses to keep a booking that no longer fits rather than quietly dropping it", () => {
    const { engine, session, initial, ctx } = started();
    const booked = ids(initial)[1]!;

    // A window too small to reach the booking from where they are standing.
    const outcome = repair(engine, session, {
      nowMin: ctx.nowMin,
      locked: [booked],
      ops: [{ kind: "set_time", availableMin: 70, note: "We have to be back." }],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The booking is still in the plan the traveller is left holding. It is never
    // dropped on the floor, and never quietly re-timed to make it fit.
    expect(ids(outcome.session.plan!)).toContain(booked);
    expect(outcome.session.state.ctx).toEqual(session.state.ctx);
    expect(outcome.locks.booked).toEqual([booked]);
  });

  it("counts a stop that is both done and booked as done, once", () => {
    const { engine, session, initial, ctx } = started();
    const doneId = ids(initial)[0]!;

    const outcome = repaired(engine, session, {
      nowMin: ctx.nowMin,
      completed: [doneId],
      locked: [doneId],
    });

    expect(outcome.locks.completed).toEqual([doneId]);
    expect(outcome.locks.booked).toEqual([]);
    expect(outcome.locks.hold).toEqual([doneId]);
    // A stop the traveller reports doing, that the clock thinks is still ahead,
    // is history anyway. The report wins.
    expect(outcome.locks.completedFromClock).toBe(false);
  });

  it("refuses a repair that would drop a finished stop, and keeps the old plan", () => {
    const { session, initial, ctx } = started();
    const doneId = ids(initial)[0]!;

    const outcome = repair(amnesiac(), session, {
      nowMin: ctx.nowMin + 30,
      completed: [doneId],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("locked_stop_dropped");
    expect(outcome.violations[0]?.at).toBe(doneId);
    expect(outcome.session.plan).toBe(initial);
  });

  it("picks the stop that is next, not the one already behind the traveller", () => {
    const { initial } = started();
    const now = initial.stops[0]!.departMin;
    expect(nextUp(initial, now)).toBe(ids(initial)[1]);
  });
});

// ===========================================================================
// Refusals
// ===========================================================================

describe("refusals", () => {
  it("does nothing when nothing about the day changed", () => {
    const { engine, session, initial, ctx } = started();
    const outcome = repair(engine, session, { nowMin: ctx.nowMin });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.change).toBeNull();
    expect(outcome.session.plan).toBe(initial);
    expect(outcome.reason).toContain("Nothing");
  });

  it("refuses to repair a trip that has no plan yet", () => {
    const engine = engineFor();
    const session = createSession({ engine, seed: SEED, catalogue: CATALOGUE, weights: WEIGHTS });

    const outcome = repair(engine, session, { nowMin: SEED.nowMin + 30 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.session.plan).toBeNull();
    expect(outcome.reason).toContain("no valid itinerary");
  });

  it("rolls the context back when the repair is refused, exactly like a chip", () => {
    const { session, initial, ctx } = started();
    const before = session.state.ctx;

    const outcome = repair(amnesiac(), session, {
      nowMin: before.nowMin + 30,
      ops: [{ kind: "set_walking", walking: "minimal", note: "Short legs only." }],
    });

    expect(outcome.ok).toBe(false);
    // The failed edit left no trace: no clock movement, no walking token.
    expect(outcome.session.state.ctx).toEqual(before);
    expect(outcome.session.plan).toBe(initial);
    expect(ctx.nowMin).toBe(before.nowMin);
  });
});
