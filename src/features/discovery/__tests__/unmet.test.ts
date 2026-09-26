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
  UnmetDemand,
  type DiscoveryContext,
  type Experience,
  type FeasibleResult,
  type Fit,
  type Plan,
  type Rejection,
  type RejectionCode,
  type RetrieveInput,
  type ScoreBreakdown,
  type TravelLeg,
  type ValidationResult,
  type WeightProfile,
} from "../../../contracts";
import {
  assessDemand,
  createLedger,
  createSession,
  discover,
  recordDemand,
  signalId,
  topSignals,
  type ContextSeed,
  type DemandLedger,
  type DemandSignal,
  type DiscoveryReport,
} from "..";
import type { EnginePort, TravelMode } from "../engine";
import { WEIGHTS, exp, plan as planOf } from "./fixtures";

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

/** A request this catalogue can serve: money, time and stairs all relaxed. */
const SERVABLE_SEED: ContextSeed = { ...FAMILY_SEED, budgetMinor: 300000, availableMin: 45, accessNeeds: [] };

const AT = "2026-09-26T14:00:00.000Z";

function run(
  seed: ContextSeed = FAMILY_SEED,
  catalogue: readonly Experience[] = UNSERVABLE,
  at = AT,
) {
  const engine = gateEngine(catalogue);
  const session = createSession({ engine, seed, catalogue, weights: WEIGHTS });
  const outcome = discover(engine, session, { travellerId: "trav-1", at });
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
    expect(signal.blocking.all).toEqual([
      { code: "capacity_exceeded", count: 1 },
      { code: "not_step_free", count: 1 },
      { code: "over_budget", count: 1 },
    ]);
    expect(signal.demand.topBlockingCode).toBe("capacity_exceeded");
    expect(signal.demand.topBlockingCount).toBe(1);
    // The engine's own sentence, reused rather than rewritten.
    expect(signal.blocking.message).toBe("Seats 2; you are 4.");
  });

  it("counts a dominant blocker correctly when one constraint did most of the killing", () => {
    const cheap = UNSERVABLE.map((item) =>
      item.id === "fort-market" ? { ...item, pricePerPerson: { minor: 150000, currency: "INR" as const } } : item,
    );
    const signal = signalOf(run(FAMILY_SEED, cheap).outcome);

    // Two candidates now die on price, one on capacity.
    expect(signal.demand.topBlockingCode).toBe("over_budget");
    expect(signal.demand.topBlockingCount).toBe(2);
  });

  it("does not double-count a rejection the engine reported twice", () => {
    const { outcome } = run();
    if (!outcome.ok) throw new Error("unreachable");

    // `discover` merges `FeasibleResult.rejected` with `Plan.rejected`, and this
    // gate reports every rejection in both places.
    const codes = outcome.demand.status === "unmet" ? outcome.demand.blocked.all : [];
    expect(codes).toEqual([
      { code: "capacity_exceeded", count: 1 },
      { code: "not_step_free", count: 1 },
      { code: "over_budget", count: 1 },
    ]);
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

describe("what is not unmet demand", () => {
  it("leaves a satisfiable request alone", () => {
    const { outcome } = run(SERVABLE_SEED, [CAFE]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.stops).toHaveLength(1);
    expect(outcome.demand).toEqual({ status: "satisfied", stops: 1 });
  });

  it("keeps a satisfiable request out of the ledger", () => {
    const { outcome } = run(SERVABLE_SEED, [CAFE]);
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
