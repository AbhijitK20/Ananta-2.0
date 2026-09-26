/**
 * The feasibility gate, checked against the twelve rows of `docs/FEATURES.md` §3.
 *
 * This file tests the *gate fixture*, not the feature, and it is worth saying why that
 * is not circular. The contract publishes 24 `RejectionCode`s. Before this, not one of
 * them was produced by any code in the repository: the gate was specified and
 * unreachable at the same time, so "we have a feasibility gate" was a claim with nothing
 * behind it. What is asserted here is that the contract **permits** a correct answer for
 * all twelve, that each answer carries a real number, and that two of them cannot be
 * answered at all without a date the context does not have.
 *
 * Every `Rejection` goes through the real schema, and every plan through `Plan.parse`, so
 * a drifting message or a missing field fails here rather than in production.
 */
import { describe, expect, it } from "vitest";
import {
  Rejection as RejectionSchema,
  RejectionCode,
  type DiscoveryContext,
  type Experience,
  type Slot,
} from "../../../contracts";
import { createContext } from "../context";
import {
  ASSUMED_CALENDAR,
  type Facts,
  check,
  deriveSlotAvailability,
  hoursVerdict,
  openMinutes,
  parseHours,
  validatePlan,
} from "./engine";
import {
  CATALOGUE,
  CATALOGUE_MAP,
  FACTS,
  ORIGIN,
  PARTY,
  POTTERY_SLOT,
  POTTERY_SLOT_FREE,
  POTTERY_SLOT_HALF,
  SEED,
  city,
  codes,
  ctxWith,
  ids,
} from "./city";
import { exp } from "./fixtures";

const row = (id: string): Experience => {
  const item = CATALOGUE_MAP.get(id);
  if (!item) throw new Error(`no catalogue row called ${id}`);
  return item;
};

/** Every code the gate produces for one candidate, with the origin as `from`. */
const codesFor = (id: string, patch: Parameters<typeof ctxWith>[0] = {}, facts: Facts = FACTS): string[] =>
  check(ctxWith(patch), row(id), facts, ORIGIN).map((entry) => entry.code);

const find = (id: string, code: string, patch: Parameters<typeof ctxWith>[0] = {}, facts: Facts = FACTS) =>
  check(ctxWith(patch), row(id), facts, ORIGIN).find((entry) => entry.code === code);

describe("1. distance is a nearest-neighbour constraint, not a radius", () => {
  it("measures from the last accepted place, so a limit cuts the chain and not the map", () => {
    expect(codesFor("cafe")).not.toContain("too_far");

    // At 500 m, measured from where they are standing, the chai stall is in and the
    // market — 590 m out — is not.
    const minimal = { prefs: { walking: "minimal" as const } };
    expect(codesFor("chai", minimal)).not.toContain("too_far");
    expect(codesFor("market", minimal)).toContain("too_far");
    expect(codesFor("cafe", minimal)).toContain("too_far");

    // The same market, measured from the chai stall they are already standing at, is
    // 350 m away and fits. A radius from the centre of the city cannot express that;
    // this is the difference between check 1 being a distance and being a hop.
    const hop = check(ctxWith(minimal), row("market"), FACTS, row("chai").location);
    expect(hop.map((entry) => entry.code)).not.toContain("too_far");
    expect(codesFor("market", minimal)).toContain("too_far");

    const far = check(ctxWith(minimal), row("cafe"), FACTS, row("chai").location).find(
      (entry) => entry.code === "too_far",
    );
    expect(far?.unit).toBe("metres");
    expect(far?.shortfall).toBeGreaterThan(500);
    expect(far?.message).toMatch(/is \d+ m from the last stop, over the 500 m walking limit\./);
  });
});

describe("2, 9. the window decides what fits and what can still be booked", () => {
  it("rejects a long stop with the real shortfall", () => {
    const short = check(ctxWith({ availableMin: 45 }), row("photowalk"), FACTS, ORIGIN);
    expect(short.map((entry) => entry.code)).toContain("duration_exceeds_budget");
    const over = short.find((entry) => entry.code === "duration_exceeds_budget");
    expect(over?.shortfall).toBe(75);
    expect(over?.unit).toBe("minutes");
    expect(over?.message).toContain("120 min");
  });

  it("asks for booking notice only from places that need booking", () => {
    expect(codesFor("photowalk", { availableMin: 120 })).toContain("lead_time_too_short");
    const notice = find("photowalk", "lead_time_too_short", { availableMin: 120 });
    expect(notice?.shortfall).toBe(120);
    expect(notice?.message).toContain("needs booking 240 min ahead");
    // Enough notice, no complaint.
    expect(codesFor("photowalk", { availableMin: 300 })).not.toContain("lead_time_too_short");

    // A walk-in venue never fails this check, however short the window.
    const walkIn = exp({ id: "walkin", name: "Walk-in counter" });
    expect(check(ctxWith({ availableMin: 20 }), walkIn, FACTS, ORIGIN).map((e) => e.code)).not.toContain(
      "lead_time_too_short",
    );
  });
});

describe("3. opening hours, in the three forms the contract has a code for", () => {
  const calendar = ASSUMED_CALENDAR;

  it("reports a place that is shut now, and says which day it assumed", () => {
    const shut = hoursVerdict(row("gallery"), calendar, 600, 660);
    expect(shut?.code).toBe("closed_now");
    expect(shut?.soft).toBe(false);
    // The weekday is in the sentence because the context carries no date. See the
    // `Calendar` note in engine.ts: this assumption IS the contract gap.
    expect(shut?.message).toMatch(/is shut at 10:00 on a Wednesday\./);
  });

  it("reports a place that shuts part-way through the window, with the minutes lost", () => {
    // 19:00 to 20:30 against hours that stop at 20:00: half the window is gone.
    const partial = hoursVerdict(row("mosque"), calendar, 1140, 1230);
    expect(partial?.code).toBe("closed_during_window");
    expect(partial?.shortfall).toBe(30);
    // A window that ends exactly on closing time is fully open, not a shortfall.
    expect(hoursVerdict(row("mosque"), calendar, 1140, 1200), "ends at closing").toBeNull();
    expect(partial?.unit).toBe("minutes");
    expect(partial?.soft).toBe(false);
  });

  it("degrades to soft when the hours are unknown, and never throws", () => {
    for (const id of ["unverified", "garbled"]) {
      const soft = hoursVerdict(row(id), calendar, 600, 660);
      expect(soft?.code, id).toBe("hours_unverified");
      expect(soft?.soft, id).toBe(true);
      expect(soft?.message, id).toContain("take the hours on trust");
    }
    // And a soft failure does not drop the candidate: it is in both lists, which is how
    // "degrades to soft" is encoded given `FeasibleResult` has no `soft` flag.
    const ctx = ctxWith();
    const out = check(ctx, row("unverified"), FACTS, ORIGIN);
    expect(out.map((entry) => entry.code)).toEqual(["hours_unverified"]);
  });
});

describe("4, 5, 6, 7. budget, capacity, access and diet", () => {
  it("separates the total ceiling from the per-person one", () => {
    const total = find("cafe", "over_budget", { budgetMinor: 40000 });
    expect(total?.shortfall).toBe(10000);
    expect(total?.unit).toBe("minor_units");

    const perPerson = check(
      ctxWith({ budgetMinor: null, budgetPerPersonMinor: 20000 }),
      row("tiffin"),
      FACTS,
      ORIGIN,
    ).find((entry) => entry.code === "over_budget_per_person");
    expect(perPerson?.shortfall).toBe(10000);
    expect(perPerson?.message).toContain("per person");
  });

  it("counts capacity from the listing and from the slot, in people", () => {
    const listing = find("tiny", "capacity_exceeded");
    expect(listing?.shortfall).toBe(PARTY - 1);
    expect(listing?.unit).toBe("people");
    expect(listing?.message).toBe("Two-seat counter seats 1 and we are 2.");

    const half = check(ctxWith(), row("pottery"), { ...FACTS, slots: [POTTERY_SLOT_HALF] }, ORIGIN).find(
      (entry) => entry.code === "capacity_exceeded",
    );
    expect(half?.message).toContain("Only 1 left on the 10:30 slot");
    expect(half?.shortfall).toBe(1);
  });

  it("treats an unknown access field as unknown, not as a no", () => {
    // Tri-state on purpose: OSM's `wheelchair` is three-state, so `null` is a real state
    // and a gate that vetoes on it deletes most of the catalogue before ranking starts.
    expect(codesFor("chai", { accessNeeds: ["wheelchair"] })).not.toContain("not_step_free");
    expect(codesFor("steps", { accessNeeds: ["wheelchair"] })).toContain("not_step_free");
    expect(codesFor("steps", { accessNeeds: ["lowStairs"] })).toContain("no_low_stairs");
    expect(codesFor("steps", { accessNeeds: ["restroom"] })).toContain("no_restroom");
    expect(codesFor("cafe", { accessNeeds: ["wheelchair"] })).not.toContain("not_step_free");

    // The two the catalogue has no row for are probed rather than faked into it.
    const probe = exp({
      id: "probe",
      name: "Probe",
      accessibility: {
        stepFree: null,
        strollerOk: false,
        lowStairs: null,
        seatingAvailable: null,
        hearingLoop: false,
        restroomOnSite: null,
      },
    });
    const stroller = check(ctxWith({ accessNeeds: ["stroller"] }), probe, FACTS, ORIGIN).map((e) => e.code);
    expect(stroller).toContain("not_stroller_ok");
    const loop = check(ctxWith({ accessNeeds: ["hearingLoop"] }), probe, FACTS, ORIGIN).map((e) => e.code);
    expect(loop).toContain("no_hearing_loop");
  });

  it("reads diets as open vocabulary, and absence as unknown", () => {
    expect(codesFor("tiffin", { diets: ["vegetarian"] })).not.toContain("diet_mismatch");
    expect(codesFor("tiffin", { diets: ["halal"] })).toContain("diet_mismatch");
    // A place that declares no diets is not a mismatch.
    expect(codesFor("cafe", { diets: ["halal"] })).not.toContain("diet_mismatch");
  });
});

describe("8. a slot that is gone, and one that is not", () => {
  it("reads the slot table and names the arithmetic", () => {
    const gone = find("pottery", "sold_out");
    expect(gone?.relaxable).toBe(false);
    expect(gone?.message).toContain("is gone");
    expect(gone?.message).toContain("capacity:2, confirmed:2");
    expect(codesFor("pottery", {}, { ...FACTS, slots: [POTTERY_SLOT_FREE] })).not.toContain("sold_out");
  });

  it("subtracts committed counts in order, so overselling is impossible", () => {
    const available = deriveSlotAvailability(POTTERY_SLOT);
    expect(available.remaining).toBe(0);
    expect(available.status).toBe("gone");
    expect(available.derivedFrom).toEqual(["capacity:2", "confirmed:2", "pending:0", "carts:0"]);

    // Confirmed wins over held: a cart does not save a seat that is already sold.
    const contested: Slot = {
      ...POTTERY_SLOT,
      held: { pendingOrders: 1, confirmedOrders: 2, carts: 1 },
    };
    expect(deriveSlotAvailability(contested).remaining).toBe(0);

    // Never negative, whatever the counts say.
    const oversold: Slot = { ...POTTERY_SLOT, capacity: 1, held: { pendingOrders: 5, confirmedOrders: 5, carts: 5 } };
    expect(deriveSlotAvailability(oversold).remaining).toBe(0);

    // A nearly-gone slot is ordered, not gone: one seat left is a queue, not a refusal.
    const nearly: Slot = { ...POTTERY_SLOT, capacity: 4, held: { pendingOrders: 0, confirmedOrders: 3, carts: 0 } };
    expect(deriveSlotAvailability(nearly)).toMatchObject({ remaining: 1, status: "ordered" });
  });
});

describe("10, 11, 12. weather, duplicates, season", () => {
  it("rejects what the weather ruins and nothing else", () => {
    expect(codesFor("market", { weather: { condition: "clear" } })).not.toContain("weather_unsafe");
    const wet = find("market", "weather_unsafe", { weather: { condition: "heavy_rain" } });
    expect(wet?.message).toContain("has no cover");
    expect(codesFor("cafe", { weather: { condition: "storm" } })).not.toContain("weather_unsafe");
  });

  it("will not re-plan what is already planned, and never relaxes a traveller's own no", () => {
    expect(codesFor("chai", { excludedIds: ["chai"] })).toContain("excluded_by_traveller");
    expect(codesFor("chai", { pinnedIds: ["chai"] })).toContain("already_planned");
    const excluded = find("chai", "excluded_by_traveller", { excludedIds: ["chai"] });
    expect(excluded?.relaxable).toBe(false);
  });

  it("decides season against a calendar the context does not carry", () => {
    const out = find("seasonal", "seasonal_mismatch");
    expect(out?.message).toContain("month-11/12/1");
    expect(out?.message).toContain("we are in month 2");
    // Move the calendar and the same row is fine, which is the proof the verdict came
    // from the calendar rather than from the id.
    const december: Facts = { ...FACTS, calendar: { ...ASSUMED_CALENDAR, month: 12, name: "Friday" } };
    expect(codesFor("seasonal", {}, december)).not.toContain("seasonal_mismatch");
  });
});

describe("the gate emits nothing it cannot back up", () => {
  it("gives every rejection a schema, a finished sentence and a number when it has one", () => {
    const ctx = ctxWith({ accessNeeds: ["wheelchair", "restroom"], diets: ["halal"], budgetMinor: 100000 });
    const everything = CATALOGUE.flatMap((item) => check(ctx, item, FACTS, ORIGIN));
    expect(everything.length).toBeGreaterThan(0);

    for (const entry of everything) {
      expect(RejectionSchema.safeParse(entry).success, entry.message).toBe(true);
      expect(RejectionCode.safeParse(entry.code).success, entry.code).toBe(true);
      expect(entry.message, entry.code).toMatch(/[.!]$/);
      expect(entry.message, entry.code).not.toMatch(/constraint|undefined|NaN|\[object/);
      if (entry.shortfall !== null) {
        // A number in the message is a number the traveller can check.
        expect(entry.shortfall, entry.code).toBeGreaterThan(0);
        expect(entry.unit, `${entry.code} has a shortfall but no unit`).not.toBeNull();
        expect(entry.message, entry.code).toMatch(/\d/);
      }
    }
  });

  it("emits a code per problem, not just the first one", () => {
    // A cheap, inaccessible, wrong-diet, over-budget, out-of-season, stairs-up,
    // wrong-weather place has many things wrong with it and the traveller is owed all of
    // them. Reporting only the first hides the rest.
    const bad = exp({
      id: "bad",
      name: "Everything wrong at once",
      category: "restaurant",
      durationMin: 200,
      pricePerPerson: { minor: 90000, currency: "INR" },
      capacity: 1,
      minAge: 18,
      indoorOutdoor: "outdoor",
      weatherSensitive: "rain",
      bestMonths: [1],
      diets: ["vegan"],
      accessibility: {
        stepFree: false,
        strollerOk: false,
        lowStairs: false,
        seatingAvailable: null,
        hearingLoop: false,
        restroomOnSite: false,
      },
    });
    const ctx = ctxWith({
      accessNeeds: ["wheelchair", "stroller", "lowStairs", "hearingLoop", "restroom"],
      diets: ["halal"],
      budgetMinor: 50000,
      weather: { condition: "storm" },
      partySize: 1,
    });
    const found = new Set(check(ctx, bad, FACTS, ORIGIN).map((entry) => entry.code));
    for (const expected of [
      "not_step_free",
      "not_stroller_ok",
      "no_low_stairs",
      "no_hearing_loop",
      "no_restroom",
      "inaccessible",
      "over_budget",
      "diet_mismatch",
      "weather_unsafe",
      "seasonal_mismatch",
      "duration_exceeds_budget",
    ]) {
      expect([...found], expected).toContain(expected);
    }
  });
});

describe("opening hours, on its own", () => {
  it("reads a run of days as a run, not as its two ends", () => {
    // The bug this guards: treating `Mo-Su` as {Monday, Sunday} reports a shop that is
    // open every day as shut on Wednesday, and it looks like data quality rather than a
    // bug.
    const allWeek = parseHours("Mo-Su 08:00-23:00");
    expect(openMinutes(allWeek!, 3, 600, 660)).toBe(60);
    const weekdays = parseHours("Mo-Fr 11:00-14:30,16:00-19:00");
    expect(openMinutes(weekdays!, 3, 690, 750)).toBe(60);
    expect(openMinutes(weekdays!, 3, 870, 930)).toBe(0);
    expect(openMinutes(weekdays!, 6, 690, 750)).toBe(0);
    const weekend = parseHours("Sa-Su 10:00-12:00");
    expect(openMinutes(weekend!, 6, 600, 660)).toBe(60);
    expect(openMinutes(weekend!, 3, 600, 660)).toBe(0);
  });

  it("keeps only the part of a range that falls on the named day", () => {
    const night = parseHours("Fr-Sa 22:00-02:00");
    expect(openMinutes(night!, 5, 1320, 1440)).toBe(120);
    expect(openMinutes(night!, 5, 60, 120)).toBe(0);
  });

  it("returns null for anything it does not fully understand, and never throws", () => {
    for (const raw of ["", "Mo-Su", "Mo-Su 9am-6pm extra", "Mo-Su 09:00", "Xy 09:00-18:00", "Mo-Su 25:99-99:99"]) {
      expect(parseHours(raw), raw).toBeNull();
    }
    // `off` is an answer, not a failure.
    expect(parseHours("Mo-Su off")).toMatchObject({ allDay: false, ranges: [] });
    expect(parseHours("24/7")).toEqual({ allDay: true });
  });
});

describe("the first plan, and what it admits to leaving out", () => {
  it("is a real day that passes an independent recompute", () => {
    const run = city();
    expect(ids(run.initial).length).toBeGreaterThan(2);
    expect(run.initial.stops.at(-1)!.departMin).toBeLessThanOrEqual(run.ctx.nowMin + run.ctx.availableMin);
    expect(validatePlan(run.initial).ok).toBe(true);
  });

  it("accounts for every row it dropped, with the spec's own code for each", () => {
    const dropped = codes(city().initial);
    expect(dropped).toContainEqual(["pottery", "sold_out"]); // 8
    expect(dropped).toContainEqual(["seasonal", "seasonal_mismatch"]); // 12
    // 3, decided by the gate: the gallery is shut on the assumed weekday.
    expect(dropped).toContainEqual(["gallery", "closed_now"]);
    expect(codes(city().initial).filter(([, code]) => code === "closed_during_window")).toEqual([]);
    expect(dropped).toContainEqual(["tiny", "capacity_exceeded"]); // 5
    // 3, soft: recorded. The gate passed the row and said why it knows nothing about
    // the hours, which is the whole point of "degrades to soft; it does not throw and it
    // does not silently pass". Whether it then fit the day is the window's business.
    expect(dropped).toContainEqual(["unverified", "hours_unverified"]);
    expect(dropped).toContainEqual(["garbled", "hours_unverified"]);
    for (const id of ["unverified", "garbled"]) {
      const blocking = check(ctxWith(), row(id), FACTS, ORIGIN).filter(
        (entry) => entry.code !== "hours_unverified",
      );
      expect(blocking, id).toEqual([]);
    }
    // With room in the day, a soft row really is planned rather than dropped.
    const roomy = city({ facts: { ...FACTS, calendar: { ...ASSUMED_CALENDAR } } });
    expect(ids(roomy.initial).length).toBeGreaterThan(0);
    expect(ids(roomy.initial)).toContain("chai");
  });

  it("is byte-for-byte identical on a second run", () => {
    // Determinism is what the eval harness rests on. If this fails, a "reproducible"
    // number in the docs is not reproducible.
    const first = city().initial;
    const second = city().initial;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.engineVersion).toBe(first.engineVersion);
  });

  it("scores with the weight profile it was handed, and the profile's keys", () => {
    const stop = city().initial.stops[0]!;
    expect(stop.score.profileVersion).toBe("test-1");
    expect(stop.score.components.map((part) => part.key)).toEqual(
      expect.arrayContaining(["interest", "proximity", "rating"]),
    );
  });

  it("keeps the context and the plan on the same contract", () => {
    const run = city();
    expect(run.ctx.id).toBe(SEED.id);
    expect(run.initial.contextId).toBe(SEED.id);
    expect(run.ctx.original.availableMin).toBe(SEED.availableMin);
  });
});

export type { DiscoveryContext };
