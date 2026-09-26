/**
 * Unmet demand: a real discovery request that has no feasible candidate.
 *
 * The catalogue below is real contract rows and the gate below is a real, if
 * small, feasibility filter — it applies the contract's own hard constraints
 * (window, price, capacity, access) and emits a `Rejection` per violated one with
 * the actual shortfall in it. Nothing here is a canned answer: the "no feasible
 * candidate" outcome is *earned* by those rules, and the signal is built from the
 * rejections they produced. The fake engine in `./fixtures` cannot be used for
 * this, because it passes every candidate and never decides anything.
 *
 * `tests/**` is Abhijit's path (TASKS.md ownership table), so these live beside
 * the code they cover and `vitest run` picks them up from the default glob.
 */
import { describe, expect, it } from "vitest";
import {
  Plan,
  UnmetDemand,
  type DiscoveryContext,
  type Experience,
  type FeasibleResult,
  type Fit,
  type Rejection,
  type RejectionCode,
  type RetrieveInput,
  type ScoreBreakdown,
  type TravelLeg,
  type ValidationResult,
  type WeightProfile,
} from "../../../contracts";
// The concrete modules, not the feature barrel: this covers unmet demand and the
// two calls that report it, and it should not break because an unrelated part of
// the feature's public surface is being edited.
import type { ContextSeed } from "../context";
import type { EnginePort, TravelMode } from "../engine";
import { applyOpsAndReplan, createSession, discover } from "../replanner";
import {
  assessDemand,
  createLedger,
  describeSignal,
  recordDemand,
  signalId,
  topSignals,
  type DemandLedger,
  type DemandSignal,
  type DiscoveryReport,
} from "../unmet";
import { WEIGHTS, exp, plan as planOf, replanResult } from "./fixtures";

// ---------------------------------------------------------------------------
// A catalogue that cannot serve the request
// ---------------------------------------------------------------------------

const FORT = { lat: 18.9355, lon: 72.8355 };

/** Indoor craft workshop: right price, right duration, wrong stairs. */
const WORKSHOP = exp({
  id: "fort-craft",
  name: "Block-printing studio",
  category: "craft_workshop",
  neighbourhood: "Fort",
  location: FORT,
  indoorOutdoor: "indoor",
  durationMin: 90,
  pricePerPerson: { minor: 80000, currency: "INR" },
  capacity: 8,
  accessibility: { stepFree: false, strollerOk: false, lowStairs: null, seatingAvailable: true, hearingLoop: null, restroomOnSite: true },
});

/** Cheap and indoor, but only seats two. */
const MARKET = exp({
  id: "fort-market",
  name: "Covered spice market",
  category: "market",
  neighbourhood: "Fort",
  location: { lat: 18.936, lon: 72.836 },
  indoorOutdoor: "covered",
  durationMin: 45,
  pricePerPerson: { minor: 30000, currency: "INR" },
  capacity: 2,
});

/** Step-free and child-friendly, but ₹1,500 against a ₹1,000 ceiling. */
const GALLERY = exp({
  id: "fort-gallery",
  name: "Step-free photography gallery",
  category: "gallery",
  neighbourhood: "Fort",
  location: { lat: 18.934, lon: 72.834 },
  indoorOutdoor: "indoor",
  durationMin: 60,
  pricePerPerson: { minor: 150000, currency: "INR" },
  capacity: 20,
  kidFriendly: true,
  accessibility: { stepFree: true, strollerOk: true, lowStairs: true, seatingAvailable: true, hearingLoop: null, restroomOnSite: true },
});

/** Everything a ₹3,000 ceiling and 45 minutes buys. The satisfiable case. */
const CAFE = exp({
  id: "fort-cafe",
  name: "Fort cafe",
  category: "cafe",
  neighbourhood: "Fort",
  location: { lat: 18.935, lon: 72.835 },
  indoorOutdoor: "indoor",
  durationMin: 30,
  pricePerPerson: { minor: 40000, currency: "INR" },
  capacity: 12,
  accessibility: { stepFree: true, strollerOk: true, lowStairs: true, seatingAvailable: true, hearingLoop: null, restroomOnSite: true },
});

const UNSERVABLE = [WORKSHOP, MARKET, GALLERY];

/** An affordable, short, roomy option — so only one constraint can be at fault. */
function easy(over: Parameters<typeof exp>[0]): Experience {
  return exp({
    category: "art_studio",
    neighbourhood: "Fort",
    location: FORT,
    indoorOutdoor: "indoor",
    durationMin: 30,
    pricePerPerson: { minor: 80000, currency: "INR" },
    capacity: 10,
    ...over,
  });
}

/** Three options, every one of them ₹500 over a ₹1,000 ceiling, and nothing else wrong. */
const OVER_BUDGET = [
  easy({ id: "a", name: "A", pricePerPerson: { minor: 150000, currency: "INR" } }),
  easy({ id: "b", name: "B", pricePerPerson: { minor: 190000, currency: "INR" } }),
  easy({ id: "c", name: "C", pricePerPerson: { minor: 240000, currency: "INR" } }),
];

/** Three options, all affordable and all with stairs. A structural gap. */
const ALL_STAIRS = [
  easy({ id: "s1", name: "S1", accessibility: { stepFree: false, strollerOk: false, lowStairs: false, seatingAvailable: true, hearingLoop: null, restroomOnSite: true } }),
  easy({ id: "s2", name: "S2", accessibility: { stepFree: false, strollerOk: false, lowStairs: null, seatingAvailable: true, hearingLoop: null, restroomOnSite: true } }),
  easy({ id: "s3", name: "S3", accessibility: { stepFree: null, strollerOk: false, lowStairs: null, seatingAvailable: true, hearingLoop: null, restroomOnSite: true } }),
];

/** One traveller who wants an art class, indoors is not asked for, no kids. */
const SOLO_ART: ContextSeed = {
  id: "ctx-art",
  origin: { label: "Fort", point: FORT },
  availableMin: 90,
  nowMin: 1020,
  budgetMinor: 100000,
  partySize: 1,
  interests: ["art class"],
  weather: { condition: "clear", tempC: 28, source: "live" },
};

// ---------------------------------------------------------------------------
// The reference gate — real hard constraints, real shortfalls
// ---------------------------------------------------------------------------

const rupees = (minor: number) => ({ minor, currency: "INR" as const });

function reject(item: Experience, code: RejectionCode, message: string, shortfall: number | null, unit: Rejection["unit"]): Rejection {
  return { experienceId: item.id, code, message, shortfall, unit, relaxable: code !== "capacity_exceeded" };
}

/**
 * One candidate, every hard constraint it fails. The first failure is the one a
 * traveller would be told about; the rest are counted by `rankBlockers`.
 */
function gateOf(ctx: DiscoveryContext, item: Experience): Rejection | null {
  const cost = item.pricePerPerson?.minor ?? 0;
  const ceiling = ctx.budgetPerPerson?.minor ?? ctx.budget?.minor ?? null;
  if (ceiling !== null && cost > ceiling) {
    return reject(item, "over_budget", `Costs ₹${Math.round(cost / 100)} each, over the ₹${Math.round(ceiling / 100)} you said.`, cost - ceiling, "minor_units");
  }
  if (item.capacity !== null && item.capacity < ctx.partySize) {
    return reject(item, "capacity_exceeded", `Seats ${item.capacity}; you are ${ctx.partySize}.`, ctx.partySize - item.capacity, "people");
  }
  if (item.durationMin > ctx.availableMin) {
    return reject(item, "duration_exceeds_budget", `Needs ${item.durationMin} min on site, you have ${ctx.availableMin}.`, item.durationMin - ctx.availableMin, "minutes");
  }
  if (ctx.accessNeeds.includes("wheelchair") && item.accessibility.stepFree !== true) {
    return reject(item, "not_step_free", "No step-free route in.", null, null);
  }
  if (ctx.accessNeeds.includes("stroller") && item.accessibility.strollerOk !== true) {
    return reject(item, "not_stroller_ok", "Not usable with a stroller.", null, null);
  }
  return null;
}

const okValidation: ValidationResult = { ok: true, violations: [], recomputedObjective: 0, claimedObjective: 0, objectiveDelta: 0 };

function travelBetween(from: { lat: number; lon: number }, to: { lat: number; lon: number }, _mode: TravelMode, _atMin: number): TravelLeg {
  return { fromId: `${from.lat},${from.lon}`, toId: `${to.lat},${to.lon}`, mode: "walk", minutes: 8, metres: 600, detail: null, estimated: true };
}

/**
 * A stand-in for `src/engine`, which belongs to another stream. It answers the
 * port with the gate's real decisions rather than with fixtures: `filterFeasible`
 * drops candidates and explains why, and `pack` re-derives the same rejections so
 * the plan carries them, which is what the real packer does.
 */
function gateEngine(catalogue: readonly Experience[]): EnginePort {
  const rejectAll = (ctx: DiscoveryContext): Rejection[] =>
    catalogue.map((item) => gateOf(ctx, item)).filter((row): row is Rejection => row !== null);

  return {
    retrieve(input: RetrieveInput): Experience[] {
      return input.catalogue.slice(0, input.limit);
    },
    filterFeasible(ctx: DiscoveryContext, items: Experience[]): FeasibleResult {
      const passed: string[] = [];
      const rejected: Rejection[] = [];
      for (const item of items) {
        const failure = gateOf(ctx, item);
        if (failure) rejected.push(failure);
        else passed.push(item.id);
      }
      return { passed, rejected };
    },
    score(_ctx: DiscoveryContext, items: Experience[], weights: WeightProfile): ScoreBreakdown[] {
      return items.map((item) => ({ experienceId: item.id, total: 0, components: [], profileVersion: weights.version, learnedComponents: [] }));
    },
    pack(ctx: DiscoveryContext, items: Experience[]): Plan {
      return planOf(
        ctx,
        items.map((item, index) => ({
          id: item.id,
          order: index,
          arriveMin: ctx.nowMin + index * 60,
          durationMin: item.durationMin,
          costMinor: item.pricePerPerson?.minor ?? 0,
        })),
        { rejected: rejectAll(ctx) },
      );
    },
    validate(): ValidationResult {
      return okValidation;
    },
    replan() {
      throw new Error("the gate does not replan; the replanner has its own tests");
    },
    computeFit(ctx: DiscoveryContext, item: Experience): Fit {
      return {
        experienceId: item.id,
        travelMin: 8,
        activityMin: item.durationMin,
        bufferMin: 5,
        totalMin: item.durationMin + 13,
        availableMin: ctx.availableMin,
        fitRatio: (item.durationMin + 13) / Math.max(1, ctx.availableMin),
        cost: item.pricePerPerson ?? rupees(0),
        budget: ctx.budget,
        checks: [],
        verdict: item.durationMin + 13 <= ctx.availableMin ? "fits" : "does_not_fit",
      };
    },
    stress() {
      return { score: 0, factors: [] };
    },
    travelBetween,
  };
}

// ---------------------------------------------------------------------------
// The request the product's own example describes
// ---------------------------------------------------------------------------

/** Indoor, family, ₹1,000, Fort, 90 minutes, a wheelchair and a stroller. */
const FAMILY_SEED: ContextSeed = {
  id: "ctx-family",
  origin: { label: "Fort", point: FORT },
  availableMin: 90,
  nowMin: 1020,
  budgetMinor: 100000,
  partySize: 4,
  childAges: [4, 7],
  accessNeeds: ["wheelchair", "stroller"],
  interests: ["craft workshop", "family", "toddler"],
  avoid: ["crowded"],
  prefs: { indoorOnly: true },
  weather: { condition: "light_rain", tempC: 27, source: "live" },
};

/**
 * A request this catalogue can serve, and one the travel-load gate also agrees
 * with: one traveller, no children, no access needs, a long window. A fixture
 * that strains a solo traveller for 30 minutes is a fixture that tests the load
 * model, not unmet demand.
 */
const SOLO_SEED: ContextSeed = {
  id: "ctx-solo",
  origin: { label: "Fort", point: FORT },
  availableMin: 240,
  nowMin: 1020,
  budgetMinor: 300000,
  partySize: 1,
  accessNeeds: [],
  interests: ["coffee"],
  weather: { condition: "clear", tempC: 28, source: "live" },
};

const AT = "2026-09-26T14:00:00.000Z";
const NEXT_DAY = "2026-09-27T14:00:00.000Z";

function run(
  seed: ContextSeed = FAMILY_SEED,
  catalogue: readonly Experience[] = UNSERVABLE,
  at = AT,
  travellerId = "trav-1",
) {
  const engine = gateEngine(catalogue);
  const session = createSession({ engine, seed, catalogue, weights: WEIGHTS });
  const outcome = discover(engine, session, { travellerId, at });
  return { engine, session, outcome };
}

/** The signal a run produced, or a thrown error so a failure is never silent. */
function signalOf(outcome: ReturnType<typeof discover>): DemandSignal {
  if (!outcome.ok) throw new Error(`discovery failed: ${outcome.reason}`);
  if (outcome.demand.status !== "unmet" || !outcome.demand.signal) {
    throw new Error(`expected unmet demand, got ${outcome.demand.status}`);
  }
  return outcome.demand.signal;
}

// ---------------------------------------------------------------------------

describe("unmet demand, from a real request with no feasible candidate", () => {
  it("reports unsatisfied demand instead of an empty plan", () => {
    const { outcome } = run();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The plan is real and valid, and it is empty. That is the whole case.
    expect(outcome.plan.stops).toHaveLength(0);
    expect(outcome.validation.ok).toBe(true);
    expect(outcome.demand.status).toBe("unmet");
  });

  it("writes a contract UnmetDemand row that parses", () => {
    const signal = signalOf(run().outcome);

    expect(UnmetDemand.safeParse(signal.demand).success).toBe(true);
    // The row id IS the aggregation key, so persisting is an upsert.
    expect(signal.demand.id).toBe(signalId(signal.fingerprint));
    // Zero results is what makes it unmet, and it is counted, not estimated.
    expect(signal.demand.shortfallCount).toBe(0);
    expect(signal.count).toBe(1);
  });

  it("records the constraints the traveller actually stated", () => {
    const { constraints } = signalOf(run().outcome).demand;

    expect(constraints.availableMin).toBe(90);
    expect(constraints.budgetMinor).toBe(100000);
    expect(constraints.partySize).toBe(4);
    expect(constraints.accessNeeds).toEqual(["stroller", "wheelchair"]);
    expect(constraints.interests).toEqual(["craft workshop", "family", "toddler"]);
    expect(constraints.weather).toBe("light_rain");
  });

  it("records the location, the category and the group characteristics", () => {
    const signal = signalOf(run().outcome);

    expect(signal.demand.point).toEqual(FORT);
    expect(signal.demand.neighbourhood).toBe("fort");
    // "craft workshop" is the traveller's own words, so the category is observed.
    expect(signal.asks.category).toBe("craft_workshop");
    expect(signal.asks.categoryTier).toBe("observed");
    expect(signal.asks.kidGroup).toBe(true);
    expect(signal.asks.childAges).toEqual([4, 7]);
    expect(signal.asks.indoorOnly).toBe(true);
    expect(signal.budget).toEqual({ min: 100000, max: 100000 });
    expect(signal.partySize).toEqual({ min: 4, max: 4 });
    // 19:30 IST, from a 14:00Z request.
    expect(signal.timeBucket).toBe("evening");
  });

  it("blames the constraint that actually eliminated the candidates", () => {
    const signal = signalOf(run().outcome);

    // Every candidate dies on exactly one hard constraint, so all three codes tie
    // at one and the tie-break is the code name — not the engine's emission order.
    expect(signal.blocking.all.map((row) => row.code)).toEqual([
      "capacity_exceeded",
      "not_step_free",
      "over_budget",
    ]);
    expect(signal.demand.topBlockingCode).toBe("capacity_exceeded");
    expect(signal.demand.topBlockingCount).toBe(1);
    // The engine's own sentence, reused rather than rewritten.
    expect(signal.blocking.message).toBe("Seats 2; you are 4.");
  });

  it("keeps the shortfall, because a provider can act on that and not on a code", () => {
    const signal = signalOf(run().outcome);
    const byCode = new Map(signal.blocking.all.map((row) => [row.code, row.shortfall]));

    expect(byCode.get("capacity_exceeded")).toEqual({ amount: 2, unit: "people" });
    expect(byCode.get("over_budget")).toEqual({ amount: 50000, unit: "minor_units" });
    // A structural constraint has no number to quote, and none is invented.
    expect(byCode.get("not_step_free")).toBeNull();
    expect(signal.blocking.shortfall).toEqual({ amount: 2, unit: "people" });
  });

  it("counts a dominant blocker correctly when one constraint did most of the killing", () => {
    const dearer = UNSERVABLE.map((item) =>
      item.id === "fort-market" ? { ...item, pricePerPerson: { minor: 150000, currency: "INR" as const } } : item,
    );
    const signal = signalOf(run(FAMILY_SEED, dearer).outcome);

    // Two candidates now die on price, one on capacity.
    expect(signal.demand.topBlockingCode).toBe("over_budget");
    expect(signal.demand.topBlockingCount).toBe(2);
    expect(signal.blocking.shortfall).toEqual({ amount: 50000, unit: "minor_units" });
  });

  it("does not double-count a rejection the engine reported twice", () => {
    const { outcome } = run();
    if (!outcome.ok) throw new Error("unreachable");

    // `discover` merges `FeasibleResult.rejected` with `Plan.rejected`, and this
    // gate reports every rejection in both places.
    const codes = outcome.demand.status === "unmet" ? outcome.demand.blocked.all.map((row) => row.count) : [];
    expect(codes).toEqual([1, 1, 1]);
  });
});

describe("a re-solve that empties the plan", () => {
  /** One stop, then a storm: the engine has nothing left to offer. */
  function rainRun() {
    const first = run(SOLO_SEED, [CAFE]);
    if (!first.outcome.ok) throw new Error("fixture did not build");

    const ctx = first.outcome.session.state.ctx;
    const storm: Rejection = {
      experienceId: "fort-cafe",
      code: "weather_unsafe",
      message: "A storm is over the city and this is not weather-safe.",
      shortfall: null,
      unit: null,
      relaxable: false,
    };
    const empty = Plan.parse({ ...planOf(ctx, []), rejected: [storm] });
    const engine: EnginePort = { ...gateEngine([CAFE]), replan: (_p, _c, change) => replanResult(empty, change) };

    return applyOpsAndReplan(
      engine,
      first.outcome.session,
      [{ kind: "set_weather", condition: "storm" }],
      { travellerId: "trav-1", at: NEXT_DAY },
    );
  }

  it("is unmet demand, because the traveller had something and now has nothing", () => {
    const outcome = rainRun();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.stops).toHaveLength(0);
    expect(outcome.demand.status).toBe("unmet");
    if (outcome.demand.status !== "unmet") return;
    expect(outcome.demand.blocked.code).toBe("weather_unsafe");
    expect(outcome.demand.signal?.demand.topBlockingCode).toBe("weather_unsafe");
  });

  it("writes a row for the storm, not for the plan that was there before", () => {
    const outcome = rainRun();
    if (!outcome.ok) throw new Error("unreachable");
    const signal = outcome.demand.status === "unmet" ? outcome.demand.signal : null;
    if (!signal) throw new Error("expected a signal");

    expect(signal.demand.constraints.weather).toBe("storm");
    expect(signal.demand.at).toBe(NEXT_DAY);
    expect(signal.observations).toEqual([{ travellerId: "trav-1", at: NEXT_DAY }]);
  });

  it("leaves a re-solve that still has stops out of the ledger", () => {
    const first = run(SOLO_SEED, [CAFE]);
    if (!first.outcome.ok) throw new Error("fixture did not build");
    const ctx = first.outcome.session.state.ctx;
    const still = planOf(ctx, [{ id: "fort-cafe", order: 0, arriveMin: ctx.nowMin, durationMin: 30 }]);
    const engine: EnginePort = { ...gateEngine([CAFE]), replan: (_p, _c, change) => replanResult(still, change) };

    const outcome = applyOpsAndReplan(
      engine,
      first.outcome.session,
      [{ kind: "set_weather", condition: "cloudy" }],
      { travellerId: "trav-1", at: NEXT_DAY },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.demand).toEqual({ status: "satisfied", stops: 1 });
  });
});

describe("aggregation", () => {
  it("folds an equivalent request into the same signal instead of a duplicate", () => {
    const first = signalOf(run(FAMILY_SEED, UNSERVABLE, AT).outcome);
    // A different traveller, a different stated budget inside the same band, and
    // a longer window inside the same duration band. Same gap, so same key.
    const second = signalOf(
      run({ ...FAMILY_SEED, budgetMinor: 95000, availableMin: 100 }, UNSERVABLE, "2026-09-27T14:00:00.000Z").outcome,
    );

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.demand.id).toBe(first.demand.id);

    let ledger: DemandLedger = createLedger();
    ledger = recordDemand(ledger, first);
    ledger = recordDemand(ledger, second);

    expect(ledger.signals).toHaveLength(1);
    const only = ledger.signals[0]!;
    expect(only.count).toBe(2);
    expect(only.observations).toHaveLength(2);
    expect(only.fingerprint).toBe(first.fingerprint);
    // The spread is observed, and the first occurrence's row is left alone except
    // for the two fields that must stay current.
    expect(only.budget).toEqual({ min: 95000, max: 100000 });
    expect(only.availableMin).toEqual({ min: 90, max: 100 });
    expect(only.demand.travellerId).toBe("trav-1");
    expect(only.demand.at).toBe("2026-09-27T14:00:00.000Z");
    expect(only.demand.topBlockingCount).toBe(2);
    expect(only.firstAt).toBe(AT);
    expect(only.lastAt).toBe("2026-09-27T14:00:00.000Z");
  });

  it("ignores the same request arriving twice", () => {
    const signal = signalOf(run().outcome);

    let ledger = createLedger();
    ledger = recordDemand(ledger, signal);
    // A double submit, a retry, a replayed event. One traveller asked once, so
    // one traveller appears on the provider's dashboard.
    const again = recordDemand(ledger, signal);
    const third = recordDemand(again, signal);

    expect(third.signals[0]?.count).toBe(1);
    expect(third.signals[0]?.observations).toHaveLength(1);
    // The ledger is not even rebuilt.
    expect(third).toBe(again);
  });

  it("counts the same traveller twice only when they asked twice", () => {
    const morning = signalOf(run(FAMILY_SEED, UNSERVABLE, AT, "trav-7").outcome);
    const night = signalOf(run(FAMILY_SEED, UNSERVABLE, NEXT_DAY, "trav-7").outcome);

    let ledger = createLedger();
    ledger = recordDemand(ledger, morning);
    ledger = recordDemand(ledger, night);

    expect(ledger.signals).toHaveLength(1);
    expect(ledger.signals[0]?.count).toBe(2);
    expect(ledger.signals[0]?.observations).toEqual([
      { travellerId: "trav-7", at: AT },
      { travellerId: "trav-7", at: NEXT_DAY },
    ]);
  });

  it("keeps a genuinely different gap as a second signal", () => {
    const base = signalOf(run().outcome);
    // Same everything except the budget band: ₹300 is a different price gap.
    const cheaper = signalOf(run({ ...FAMILY_SEED, budgetMinor: 30000 }).outcome);
    // And a different neighbourhood is a different supply market.
    const elsewhere = signalOf(run({ ...FAMILY_SEED, origin: { label: "Colaba", point: { lat: 18.9067, lon: 72.8147 } } }).outcome);

    expect(cheaper.fingerprint).not.toBe(base.fingerprint);
    expect(elsewhere.fingerprint).not.toBe(base.fingerprint);

    let ledger = createLedger();
    ledger = recordDemand(ledger, base);
    ledger = recordDemand(ledger, cheaper);
    ledger = recordDemand(ledger, elsewhere);

    expect(ledger.signals).toHaveLength(3);
    // Deterministic order: count desc, blocked candidates desc, fingerprint asc.
    // The ₹300 request is the one with two candidates on price, so it leads.
    expect(ledger.signals.map((row) => [row.count, row.demand.topBlockingCode])).toEqual([
      [1, "over_budget"],
      [1, "capacity_exceeded"],
      [1, "capacity_exceeded"],
    ]);
    const tail = ledger.signals.slice(1).map((row) => row.fingerprint);
    expect(tail).toEqual([...tail].sort());
    expect(topSignals(ledger, 2)).toHaveLength(2);
  });

  it("is deterministic: the same request always produces the same key and id", () => {
    const a = signalOf(run().outcome);
    const b = signalOf(run().outcome);

    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.demand.id).toBe(b.demand.id);
    expect(a.demand).toEqual(b.demand);
    // No clock, no randomness: the key depends on the request and nothing else.
    expect(a.fingerprint).not.toContain("trav-1");
  });

  it("starts empty and only grows from real signals", () => {
    expect(createLedger().signals).toEqual([]);
  });
});

describe("the sentence a provider reads", () => {
  it("names what was wanted, where, when, how often, and the one fixable number", () => {
    expect(describeSignal(signalOf(run().outcome))).toBe(
      "1 traveller wanted Craft workshop, indoors, with children in Fort at ₹500 to ₹1,000, this evening. " +
        "Every candidate was ruled out by Capacity exceeded, short by 2 people.",
    );
  });

  it("pluralises the count, because the count is the claim", () => {
    let ledger = createLedger();
    ledger = recordDemand(ledger, signalOf(run().outcome));
    ledger = recordDemand(
      ledger,
      signalOf(run({ ...FAMILY_SEED, budgetMinor: 95000 }, UNSERVABLE, NEXT_DAY, "trav-2").outcome),
    );

    expect(describeSignal(ledger.signals[0]!)).toContain("2 travellers wanted");
  });

  it("omits the budget when nobody stated one rather than claiming zero", () => {
    // Stairs, and no budget at all: the sentence must not invent a ceiling.
    const signal = signalOf(run({ ...SOLO_ART, budgetMinor: null, accessNeeds: ["wheelchair"] }, ALL_STAIRS).outcome);
    const sentence = describeSignal(signal);

    expect(signal.budget).toBeNull();
    expect(sentence).not.toContain("₹0");
    expect(sentence).not.toContain("no limit stated");
    expect(sentence).toBe(
      "1 traveller wanted Art studio in Fort, this evening. Every candidate was ruled out by Not step free.",
    );
  });

  it("drops the shortfall clause when the constraint is structural", () => {
    // Affordable, short, roomy — and all three have stairs. Nothing else to say.
    const signal = signalOf(run({ ...SOLO_ART, accessNeeds: ["wheelchair"] }, ALL_STAIRS).outcome);
    const sentence = describeSignal(signal);

    expect(signal.demand.topBlockingCode).toBe("not_step_free");
    expect(signal.demand.topBlockingCount).toBe(3);
    expect(signal.blocking.shortfall).toBeNull();
    expect(sentence).toContain("ruled out by Not step free.");
    expect(sentence).not.toContain("short by");
  });

  it("quotes money in rupees, because nobody acts on paise", () => {
    const signal = signalOf(run(SOLO_ART, OVER_BUDGET).outcome);

    expect(signal.demand.topBlockingCode).toBe("over_budget");
    expect(describeSignal(signal)).toContain("short by ₹500");
  });
});

describe("what is not unmet demand", () => {
  it("leaves a satisfiable request alone", () => {
    const { outcome } = run(SOLO_SEED, [CAFE]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.stops).toHaveLength(1);
    expect(outcome.demand).toEqual({ status: "satisfied", stops: 1 });
  });

  it("keeps a satisfiable request out of the ledger", () => {
    const { outcome } = run(SOLO_SEED, [CAFE]);
    let ledger = createLedger();
    if (outcome.ok && outcome.demand.status === "unmet" && outcome.demand.signal) {
      ledger = recordDemand(ledger, outcome.demand.signal);
    }

    expect(ledger.signals).toHaveLength(0);
  });

  it("calls an empty catalogue unserved, not unmet", () => {
    // Nothing was retrieved and nothing was rejected, so no constraint is to blame
    // and there is no row to write.
    const { outcome } = run(FAMILY_SEED, []);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.demand).toEqual({ status: "unserved", considered: 0 });
  });

  it("does not blame the market when the engine throws", () => {
    const engine = gateEngine(UNSERVABLE);
    const broken: EnginePort = { ...engine, retrieve: () => { throw new Error("index offline"); } };
    const session = createSession({ engine: broken, seed: FAMILY_SEED, catalogue: UNSERVABLE, weights: WEIGHTS });
    const outcome = discover(broken, session, { travellerId: "trav-1", at: AT });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("engine_error");
    expect("demand" in outcome).toBe(false);
  });

  it("does not blame the market when the plan is rejected by validation", () => {
    const engine: EnginePort = { ...gateEngine(UNSERVABLE), validate: () => ({ ok: false, violations: [{ code: "objective_drift", message: "Packer disagreed with itself.", at: null }], recomputedObjective: 1, claimedObjective: 2, objectiveDelta: 1 }) };
    const session = createSession({ engine, seed: FAMILY_SEED, catalogue: UNSERVABLE, weights: WEIGHTS });
    const outcome = discover(engine, session, { travellerId: "trav-1", at: AT });

    expect(outcome.ok).toBe(false);
    expect("demand" in outcome).toBe(false);
  });

  it("reports the unmet state but writes no row when the request cannot be attributed", () => {
    const unlocated = { ...FAMILY_SEED, origin: { label: "Fort" } };
    const { outcome } = run(unlocated);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The traveller still got nothing, and the blockers are still reported...
    expect(outcome.demand.status).toBe("unmet");
    if (outcome.demand.status !== "unmet") return;
    expect(outcome.demand.blocked.code).toBe("capacity_exceeded");
    expect(outcome.demand.asks.category).toBe("craft_workshop");
    // ...but the contract row needs a point, so none is invented.
    expect(outcome.demand.signal).toBeNull();
  });

  it("writes no row without a traveller and a time", () => {
    const engine = gateEngine(UNSERVABLE);
    const session = createSession({ engine, seed: FAMILY_SEED, catalogue: UNSERVABLE, weights: WEIGHTS });
    const outcome = discover(engine, session, { travellerId: "  ", at: "yesterday" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.demand.status).toBe("unmet");
    if (outcome.demand.status !== "unmet") return;
    expect(outcome.demand.signal).toBeNull();
  });
});

describe("assessDemand, on its own", () => {
  it("has no verdict without a plan", () => {
    const { outcome } = run();
    if (!outcome.ok) throw new Error("unreachable");
    const report: DiscoveryReport = {
      ctx: outcome.session.state.ctx,
      plan: null,
      rejected: outcome.plan.rejected,
      considered: 3,
    };

    expect(assessDemand(report, { travellerId: "trav-1", at: AT })).toEqual({ status: "error" });
  });

  it("reports a packer that returned nothing despite having candidates", () => {
    const { outcome } = run();
    if (!outcome.ok) throw new Error("unreachable");
    const report: DiscoveryReport = {
      ctx: outcome.session.state.ctx,
      plan: outcome.plan,
      rejected: [],
      considered: 3,
    };

    // No constraint is implicated, so there is nothing to write and nothing to
    // blame. `considered` is what separates this from an empty catalogue.
    expect(assessDemand(report, { travellerId: "trav-1", at: AT })).toEqual({ status: "unserved", considered: 3 });
  });
});
