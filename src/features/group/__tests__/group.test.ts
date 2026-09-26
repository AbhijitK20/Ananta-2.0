/**
 * Group preferences, proved against the real planner.
 *
 * `src/engine/**` is another stream's path (TASKS.md Rule 2) and is not in the
 * tree, so the engine is stood in for by the discovery feature's own reference
 * implementation: a deterministic planner that runs hard checks, emits a real
 * `Rejection` per failure, scores against the `WeightProfile`, and packs
 * greedily inside the window and the budget. `planForGroup` then hands the
 * group's aggregated context to the real `discover()` pipeline, so every
 * assertion here is about a plan that was actually solved, not about a string.
 *
 * The geometry below is the test design. One degree of longitude at 19N is
 * about 105,152 m, so the offsets are metres on the ground, and the four
 * travellers' places sit at 500, 1400 and 300 m from where the group starts. The
 * engine applies a short-walk limit to each place's distance from the origin and
 * a walking budget to the sum of the legs, so those three numbers decide which
 * stops survive — and which of the two mechanisms bites first is a fact about
 * the engine, not something these tests assume.
 */
import { describe, expect, it } from "vitest";
import type { Experience, Plan } from "../../../contracts";
import { WEIGHTS, exp } from "../../discovery/__tests__/fixtures";
import { referenceEngine } from "../../discovery/__tests__/referenceEngine";
import { INDOOR_TOKEN, WALK_TOKENS, createContext } from "../../discovery/context";
import type { EnginePort } from "../../discovery/engine";
import { aggregateGroup, planForGroup, type GroupAxis, type GroupMember, type GroupRequest } from "..";

// ---------------------------------------------------------------------------
// A catalogue on one street
// ---------------------------------------------------------------------------

const AT = { lat: 19.0, lon: 72.87 };
const east = (metres: number): { lat: number; lon: number } => ({ lat: AT.lat, lon: AT.lon + metres / 105_152 });

/** 720 m out, cheap, matches nothing anybody asked for. */
const BAZAAR = exp({
  id: "bazaar-cafe",
  name: "Bazaar cafe",
  category: "cafe",
  location: east(720),
  indoorOutdoor: "indoor",
  durationMin: 30,
  pricePerPerson: { minor: 20000, currency: "INR" },
  rating: { value: 4.4, count: 310, rawMean: 4.5 },
});

/** 1280 m out, and the one thing that matches "entertainment". */
const NOCTURNE = exp({
  id: "nocturne-theatre",
  name: "Nocturne theatre",
  category: "theatre",
  location: east(1280),
  indoorOutdoor: "indoor",
  durationMin: 30,
  pricePerPerson: { minor: 15000, currency: "INR" },
  perception: { landscape: [], activities: ["entertainment"], atmosphere: ["lively"] },
  rating: { value: 4.6, count: 900, rawMean: 4.7 },
});

/** 500 m out and outdoors, and the one thing that matches "adventure". */
const SEABOARD = exp({
  id: "seaboard-kayak",
  name: "Seaboard kayak club",
  category: "adventure",
  location: east(500),
  indoorOutdoor: "outdoor",
  durationMin: 60,
  pricePerPerson: { minor: 35000, currency: "INR" },
  rating: { value: 4.7, count: 240, rawMean: 4.8 },
});

/** ₹1,200 a head. Out of reach for this group, and the reason has a name. */
const VINEYARD = exp({
  id: "vineyard-table",
  name: "Vineyard long table",
  category: "restaurant",
  location: east(700),
  indoorOutdoor: "indoor",
  durationMin: 20,
  pricePerPerson: { minor: 120000, currency: "INR" },
  rating: { value: 4.8, count: 120, rawMean: 4.9 },
});

/** Step-free is false, which is the whole point of it. */
const STEPS = exp({
  id: "steps-gallery",
  name: "Steps photography gallery",
  category: "gallery",
  location: east(1200),
  indoorOutdoor: "indoor",
  durationMin: 20,
  pricePerPerson: { minor: 50000, currency: "INR" },
  accessibility: {
    stepFree: false,
    strollerOk: false,
    lowStairs: false,
    seatingAvailable: true,
    hearingLoop: null,
    restroomOnSite: true,
  },
});

/** Both of these are well past the short-walk limit from the origin. */
const RIDGE = exp({
  id: "ridge-lookout",
  name: "Ridge lookout",
  category: "hidden_place",
  location: east(3000),
  indoorOutdoor: "outdoor",
  durationMin: 30,
  pricePerPerson: { minor: 10000, currency: "INR" },
});

const CREST = exp({
  id: "crest-waterfall",
  name: "Crest waterfall",
  category: "nature",
  location: east(4000),
  indoorOutdoor: "outdoor",
  durationMin: 45,
  pricePerPerson: { minor: 20000, currency: "INR" },
});

const CATALOGUE: readonly Experience[] = [SEABOARD, NOCTURNE, BAZAAR, VINEYARD, STEPS];

// ---------------------------------------------------------------------------
// The group the brief describes
// ---------------------------------------------------------------------------

const REQUEST: GroupRequest = {
  id: "ctx-group",
  origin: { label: "Colaba", point: AT },
  availableMin: 240,
  nowMin: 600,
  weather: { condition: "clear", tempC: 30, source: "live" },
};

/** A parent who cannot do a long walk. */
const PARENT: GroupMember = { id: "a", label: "Parent", role: "adult", hard: { walking: "low" } };
/** A friend who wants adventure. */
const FRIEND: GroupMember = { id: "b", label: "Friend", role: "adult", strong: { interests: ["adventure"] } };
/** A child who wants entertainment. */
const CHILD: GroupMember = {
  id: "c",
  label: "Child",
  role: "child",
  age: 4,
  strong: { interests: ["entertainment"] },
};
/** And a friend for whom money is the constraint. */
const FRUGAL: GroupMember = { id: "d", label: "Frugal friend", role: "adult", hard: { budgetMinor: 80_000 } };

const THE_GROUP = [PARENT, FRIEND, CHILD, FRUGAL];

function run(members: readonly GroupMember[], catalogue: readonly Experience[] = CATALOGUE) {
  const engine = referenceEngine(catalogue, WEIGHTS);
  return planForGroup({ engine, request: REQUEST, members, catalogue, weights: WEIGHTS });
}

function served(group: ReturnType<typeof planForGroup>): string[] {
  if (!group.ok) throw new Error(group.reason);
  return group.outcome.plan.stops.map((stop: Plan["stops"][number]) => stop.experienceId);
}

function decisionFor(group: ReturnType<typeof aggregateGroup>, axis: GroupAxis) {
  const found = group.decisions.find((decision) => decision.axis === axis);
  if (!found) throw new Error(`no decision for ${axis}`);
  return found;
}

const without = (members: readonly GroupMember[], id: string): GroupMember[] =>
  members.map((member) => (member.id === id ? { ...member, hard: undefined } : member));

// ---------------------------------------------------------------------------
// Aggregation: the rules, on their own
// ---------------------------------------------------------------------------

describe("what a group commits to", () => {
  it("takes the strictest walking limit anybody stated, and names who asked", () => {
    const group = aggregateGroup(REQUEST, [
      { id: "a", label: "Parent", hard: { walking: "minimal" } },
      { id: "b", label: "Friend", strong: { walking: "low" } },
    ]);
    const decision = decisionFor(group, "walking");

    expect(decision.value).toBe("minimal");
    // The stricter limit satisfies the looser one, so Friend gave nothing up and
    // is not credited with the decision.
    expect(decision.by).toEqual(["Parent"]);
    expect(decision.strength).toBe("hard");
  });

  it("falls back to a strong statement when nobody stated a hard one", () => {
    const group = aggregateGroup(REQUEST, [
      { id: "a", label: "Parent", strong: { walking: "low" } },
      { id: "b", label: "Friend", soft: { interests: ["adventure"] } },
    ]);

    expect(decisionFor(group, "walking").value).toBe("low");
    expect(decisionFor(group, "walking").strength).toBe("strong");
  });

  it("says so when nobody said anything about walking", () => {
    const group = aggregateGroup(REQUEST, [{ id: "a", label: "Parent", soft: { interests: ["quiet"] } }]);
    const walking = decisionFor(group, "walking");

    expect(walking.value).toBe("any");
    expect(walking.strength).toBe("soft");
    expect(walking.by).toEqual([]);
    expect(walking.reason).toContain("Nobody in the group said anything about walking");
  });

  it("takes the lowest ceiling, multiplied by the headcount", () => {
    const group = aggregateGroup(REQUEST, [
      { id: "a", label: "Frugal friend", hard: { budgetMinor: 80_000 } },
      { id: "b", label: "Friend", strong: { budgetMinor: 200_000 } },
      { id: "c", label: "Child", role: "child", age: 9 },
    ]);

    expect(group.seed.budgetPerPersonMinor).toBe(80_000);
    expect(group.seed.budgetMinor).toBe(240_000);
    expect(decisionFor(group, "budget").by).toEqual(["Frugal friend"]);
  });

  it("keeps the group's own ceiling when it is lower than anyone's", () => {
    const group = aggregateGroup({ ...REQUEST, budgetMinor: 90_000 }, [
      { id: "a", label: "Frugal friend", hard: { budgetMinor: 200_000 } },
      { id: "b", label: "Friend" },
    ]);

    expect(group.seed.budgetPerPersonMinor).toBe(200_000);
    // The group's own ₹900 wins, because a lower ceiling is always satisfied.
    expect(group.seed.budgetMinor).toBe(90_000);
    expect(decisionFor(group, "budget").reason).toContain("the group's own ceiling of ₹900 is what binds");
  });

  it("unions access needs and adds an older adult's, naming each holder", () => {
    const group = aggregateGroup(REQUEST, [
      { id: "a", label: "Parent", hard: { accessNeeds: ["wheelchair"] } },
      { id: "b", label: "Grandparent", role: "elder" },
    ]);

    expect(group.seed.accessNeeds).toEqual(["lowStairs", "restroom", "wheelchair"]);
    expect(group.access.by.get("wheelchair")).toEqual(["Parent"]);
    // The elder's stairs and toilet needs are the defaults `createContext` would
    // have applied, attributed to the person they are about.
    expect(group.access.by.get("lowStairs")).toEqual(["Grandparent"]);
    expect(group.seed.elderly).toBe(1);
  });

  it("ranks interests by how many people asked, fills the rest, and says what it dropped", () => {
    const group = aggregateGroup(REQUEST, [
      { id: "a", label: "Parent", strong: { interests: ["adventure"] }, soft: { interests: ["quiet"] } },
      { id: "b", label: "Friend", strong: { interests: ["adventure", "street food"] } },
      { id: "c", label: "Child", strong: { interests: ["entertainment"] } },
      { id: "d", label: "Frugal friend", soft: { interests: ["shopping"] } },
    ]);
    const decision = decisionFor(group, "interests");

    // adventure (2), then the two single votes in name order, take the three
    // slots; the two soft wishes are reported rather than dropped quietly.
    expect(group.seed.interests).toEqual(["adventure", "entertainment", "street_food"]);
    expect(group.interests.dropped.map((row) => row.name)).toEqual(["quiet", "shopping"]);
    expect(decision.reason).toContain("adventure (2 of you)");
    expect(decision.reason).toContain("2 interests (quiet, shopping) fitted no slot");
  });

  it("carries the composition through to the party type the load model reads", () => {
    const seed = aggregateGroup(REQUEST, [PARENT, CHILD, { id: "e", label: "Grandparent", role: "elder" }]).seed;
    const state = createContext(seed);

    expect(seed.partySize).toBe(3);
    expect(seed.childAges).toEqual([4]);
    expect(seed.elderly).toBe(1);
    // `createContext` derives the party type and the access defaults from exactly
    // these three numbers. Nothing in the group layer re-implements either.
    expect(state.ctx.partyType).toBe("family_with_children");
    expect(state.ctx.accessNeeds).toEqual(["lowStairs", "restroom"]);
  });

  it("is deterministic: the order people were added in cannot change the answer", () => {
    const forwards = aggregateGroup(REQUEST, THE_GROUP);
    const backwards = aggregateGroup(REQUEST, [...THE_GROUP].reverse());

    expect(backwards.seed).toEqual(forwards.seed);
    expect(backwards.decisions).toEqual(forwards.decisions);
    expect(backwards.members.map((member) => member.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("refuses a group it cannot trust, by name", () => {
    expect(() => aggregateGroup(REQUEST, [])).toThrow(/at least one member/);
    expect(() => aggregateGroup(REQUEST, [PARENT, { ...PARENT }])).toThrow(/both "a"/);
    expect(() => aggregateGroup(REQUEST, [{ id: "a", label: "Child", role: "child" }])).toThrow(
      /a is a child, so they need an age/,
    );
    expect(() => aggregateGroup(REQUEST, [{ id: "a", label: "Frugal", hard: { budgetMinor: -1 } }])).toThrow(
      /whole minor units/,
    );
  });
});

// ---------------------------------------------------------------------------
// The mandatory test: a real group, a real plan
// ---------------------------------------------------------------------------

describe("a group of four people who want four different things", () => {
  it("turns four statements into one context the planner is handed", () => {
    const group = run(THE_GROUP);
    if (!group.ok) throw new Error(group.reason);
    const ctx = group.session.state.ctx;

    // The parent's walking limit, the child's age and the frugal friend's ceiling
    // are all in the context the engine was given, in the engine's own tokens.
    expect(ctx.partySize).toBe(4);
    expect(ctx.childAges).toEqual([4]);
    expect(ctx.interests).toEqual(["adventure", "entertainment"]);
    expect(ctx.avoid).toContain(WALK_TOKENS.low);
    expect(ctx.budgetPerPerson?.minor).toBe(80_000);
    expect(ctx.budget?.minor).toBe(320_000);
    // Nobody said no walking outright, so the car is not imposed on them either.
    expect(ctx.avoid).not.toContain(WALK_TOKENS.minimal);
  });

  it("plans inside the walking budget the group itself implies", () => {
    const group = run(THE_GROUP);
    if (!group.ok) throw new Error(group.reason);

    // 6 km of walking in a day, cut to 60% by "short walks", times the factor for a
    // four-person party with a four-year-old in it. All of it is the load model's
    // arithmetic over our tokens, not ours.
    expect(group.outcome.load.verdict).toBe("ok");
    expect(group.outcome.load.budget.tolerance).toBe("low");
    expect(group.outcome.load.budget.groupFactor).toBe(0.36);
    expect(group.outcome.load.budget.walkMetres).toBe(1296);
    expect(group.outcome.load.metrics.walkMetres).toBeLessThanOrEqual(1296);
  });

  it("loses the friend's adventure stop to the parent's walking, and says why", () => {
    const group = run(THE_GROUP);
    if (!group.ok) throw new Error(group.reason);

    expect(served(group)).toEqual(["nocturne-theatre", "bazaar-cafe"]);

    // The cut is the load model's, and its reason carries the group's own limit.
    const cut = group.outcome.excluded.find((drop) => drop.id === "seaboard-kayak");
    expect(cut).toBeDefined();
    expect(cut?.reason).toContain("limit for this group");

    // The tension is reported, with the numbers that produced it, naming both
    // sides: the parent held the ceiling, the friend paid.
    const tension = group.conflicts.find((conflict) => conflict.axis === "walking");
    expect(tension?.severity).toBe("strained");
    expect(tension?.heldBy).toEqual(["Parent"]);
    expect(tension?.costing).toContain("Friend");
    const evidence = tension?.evidence.join("\n") ?? "";
    expect(evidence).toContain("tolerance:low(prefers_short_walks)");
    // The four-year-old is in the arithmetic, not just the party count.
    expect(evidence).toContain("child_under_6:4");
  });

  it("reports the adventure want as unanswered, and what would have answered it", () => {
    const group = run(THE_GROUP);
    if (!group.ok) throw new Error(group.reason);

    const unserved = group.conflicts.find((conflict) => conflict.reason.includes("adventure"));
    expect(unserved?.severity).toBe("strained");
    expect(unserved?.costing).toEqual(["Friend"]);
    // The child got their entertainment, so nothing is said about it.
    expect(group.conflicts.some((conflict) => conflict.reason.includes("entertainment"))).toBe(false);
    expect(unserved?.evidence.join("\n")).toContain("Seaboard kayak club");
  });

  it("rules the ₹1,200 table out with the rupee gap, because of one person", () => {
    const group = run(THE_GROUP);
    if (!group.ok) throw new Error(group.reason);

    expect(served(group)).not.toContain("vineyard-table");

    // The engine's own rejection, with the real shortfall: four heads at ₹1,200
    // is ₹4,800 against the ₹3,200 ceiling this group agreed to.
    const gate = referenceEngine(CATALOGUE, WEIGHTS).filterFeasible(group.session.state.ctx, [
      ...CATALOGUE,
    ]);
    const blocked = gate.rejected.find((row) => row.experienceId === "vineyard-table");
    expect(blocked?.code).toBe("over_budget");
    expect(blocked?.shortfall).toBe(160_000);
    expect(blocked?.message).toBe("Over budget by ₹1600.");
    expect(decisionFor(group.aggregate, "budget").by).toEqual(["Frugal friend"]);
  });

  it("changes the plan when the walking statement is withdrawn, and only then", () => {
    const capped = run(THE_GROUP);
    const uncapped = run(without(THE_GROUP, "a"));
    if (!capped.ok || !uncapped.ok) throw new Error("both groups should be servable");

    // Same four people, same five places, same window, same budget, same engine.
    // The only difference is whether the parent capped the walking.
    expect(uncapped.aggregate.partySize).toBe(capped.aggregate.partySize);
    expect(uncapped.session.state.ctx.budget?.minor).toBe(capped.session.state.ctx.budget?.minor);
    expect(uncapped.session.state.ctx.avoid).not.toContain(WALK_TOKENS.low);
    expect(served(uncapped)).toEqual(["seaboard-kayak", "nocturne-theatre", "bazaar-cafe"]);
    expect(served(capped)).toEqual(["nocturne-theatre", "bazaar-cafe"]);
    // And the mechanism is the load budget, not a coincidence: 1,296 m capped
    // against 2,160 m uncapped, with a 2,000 m day in between.
    expect(capped.outcome.load.budget.walkMetres).toBe(1296);
    expect(uncapped.outcome.load.budget.walkMetres).toBe(2160);
    expect(uncapped.outcome.excluded).toEqual([]);
  });

  it("changes the plan when the budget statement is withdrawn", () => {
    const two: GroupMember[] = [
      { id: "a", label: "Frugal friend", hard: { budgetMinor: 80_000 } },
      { id: "b", label: "Friend", strong: { interests: ["entertainment"] } },
    ];
    const withCeiling = run(two);
    const withoutCeiling = run(without(two, "a"));
    if (!withCeiling.ok || !withoutCeiling.ok) throw new Error("both should be servable");

    expect(withCeiling.session.state.ctx.budget?.minor).toBe(160_000);
    expect(withoutCeiling.session.state.ctx.budget).toBeNull();
    // ₹1,200 a head for two is ₹2,400 against a ₹1,600 ceiling: out while the
    // frugal friend's statement stands, in the moment it is withdrawn.
    expect(served(withCeiling)).not.toContain("vineyard-table");
    expect(served(withoutCeiling)).toContain("vineyard-table");
  });

  it("is deterministic: the same group gets the same plan, byte for byte", () => {
    const first = run(THE_GROUP);
    const second = run([...THE_GROUP].reverse());
    if (!first.ok || !second.ok) throw new Error("both should be servable");

    expect(second.outcome.plan).toEqual(first.outcome.plan);
    expect(second.conflicts).toEqual(first.conflicts);
    expect(second.ask).toEqual(first.ask);
  });
});

// ---------------------------------------------------------------------------
// The impossible group
// ---------------------------------------------------------------------------

describe("a group that cannot be served", () => {
  /** Two adults, one of whom will spend ₹100 a head. Nothing here costs that. */
  const IMPOSSIBLE: GroupMember[] = [
    { id: "a", label: "Feroza", hard: { budgetMinor: 10_000 } },
    { id: "b", label: "Bilal" },
  ];
  const WHAT_IS_THERE = [NOCTURNE, BAZAAR, SEABOARD, VINEYARD];

  it("produces no itinerary at all", () => {
    const group = run(IMPOSSIBLE, WHAT_IS_THERE);

    expect(group.ok).toBe(false);
    if (group.ok) return;
    expect(group.reason).toBe("Nothing within reach works for all of you at once.");
    // No plan is handed back in any form: not an empty one, not a partial one.
    expect("plan" in group).toBe(false);
    expect(group.conflicts[0]?.severity).toBe("blocking");
    expect(group.conflicts[0]?.evidence.join("\n")).toContain("budget:");
  });

  it("asks for the smallest change that would have worked, with the rupee in it", () => {
    const group = run(IMPOSSIBLE, WHAT_IS_THERE);
    if (group.ok) throw new Error("this group cannot be served");

    const ask = group.ask.find((entry) => entry.op.kind === "set_budget");
    // The theatre is the cheapest thing here at ₹150 a head, and ₹100 is the
    // ceiling, so the smallest ask that would have worked is ₹150.
    expect(ask?.sentence).toContain("₹150");
    expect(ask?.by).toEqual(["Feroza"]);
    expect(ask?.evidence[0]).toBe("Now ₹200 for the whole plan.");
    expect(ask?.evidence.join("\n")).toContain("Over budget");
  });

  it("gets a plan once the group answers the question", () => {
    const first = run(IMPOSSIBLE, WHAT_IS_THERE);
    if (first.ok) throw new Error("this group cannot be served");

    // The op the group was shown is the op the planner is given.
    const answered = planForGroup({
      engine: referenceEngine(WHAT_IS_THERE, WEIGHTS),
      request: REQUEST,
      members: IMPOSSIBLE,
      catalogue: WHAT_IS_THERE,
      weights: WEIGHTS,
      adjust: first.ask,
    });

    expect(answered.ok).toBe(true);
    if (!answered.ok) throw new Error(answered.reason);
    // The cheapest thing here is the theatre at ₹150 a head, and the agreed
    // ceiling admits exactly that and nothing dearer.
    expect(served(answered)).toEqual(["nocturne-theatre"]);
    expect(answered.session.state.ctx.budgetPerPerson?.minor).toBe(15_000);
    // The intent is still the group as first stated, so the change is a diff and
    // not a new trip.
    expect(answered.session.intent.budgetPerPerson?.minor).toBe(10_000);
    expect(answered.conflicts.filter((conflict) => conflict.severity === "blocking")).toEqual([]);
  });

  it("asks about walking when nothing is close enough, with the router's own distance", () => {
    const member: GroupMember[] = [{ id: "a", label: "Feroza", hard: { walking: "low" } }];
    const far = [RIDGE, CREST];
    const group = run(member, far);
    if (group.ok) throw new Error("nothing here is within a short walk");

    const ask = group.ask.find((entry) => entry.op.kind === "set_walking");
    expect(ask?.op).toEqual({ kind: "set_walking", walking: "any", note: "Walking is uncapped." });
    expect(ask?.by).toEqual(["Feroza"]);
    // 3 km, measured by `engine.travelBetween`, not by a haversine of our own.
    expect(ask?.evidence.join("\n")).toContain("Nearest on foot: 3 km");

    const answered = planForGroup({
      engine: referenceEngine(far, WEIGHTS),
      request: REQUEST,
      members: member,
      catalogue: far,
      weights: WEIGHTS,
      adjust: ask === undefined ? [] : [ask],
    });
    expect(answered.ok).toBe(true);
    expect(served(answered)).toContain("ridge-lookout");
  });

  it("asks about access without assuming anybody can give theirs up", () => {
    const group = run([{ id: "a", label: "Feroza", hard: { accessNeeds: ["wheelchair"] } }], [STEPS]);
    if (group.ok) throw new Error("the gallery has stairs");

    const ask = group.ask.find((entry) => entry.op.kind === "set_access_needs");
    expect(ask?.sentence).toContain("Drop the wheelchair requirement");
    expect(ask?.sentence).toContain("Feroza");
    // Asking is not doing: the context handed back still has the requirement.
    expect(group.session.state.ctx.accessNeeds).toEqual(["wheelchair"]);
  });

  it("has no question to ask when there was nothing to plan from", () => {
    const group = run(IMPOSSIBLE, []);

    expect(group.ok).toBe(false);
    if (group.ok) return;
    expect(group.reason).toBe("There is nothing to plan from where you are.");
    expect(group.ask).toEqual([]);
    expect(group.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The group layer is not a softer pipeline
// ---------------------------------------------------------------------------

describe("an engine that ignores what the group said", () => {
  /** A gate that passes everything, including places the group cannot use. */
  const gullible = (): EnginePort => {
    const honest = referenceEngine(CATALOGUE, WEIGHTS);
    return {
      ...honest,
      filterFeasible: (_ctx, items) => ({ passed: items.map((item) => item.id), rejected: [] }),
    };
  };

  it("is refused, not believed", () => {
    const group = planForGroup({
      engine: gullible(),
      request: REQUEST,
      members: [{ id: "a", label: "Feroza", hard: { accessNeeds: ["wheelchair"] } }],
      catalogue: CATALOGUE,
      weights: WEIGHTS,
    });

    // The engine did pack the stairs, and the group layer still returns no plan.
    expect(group.outcome.ok).toBe(true);
    if (!group.outcome.ok) throw new Error("unreachable");
    expect(group.outcome.plan.stops.map((stop) => stop.experienceId)).toContain("steps-gallery");
    expect(group.ok).toBe(false);
    if (group.ok) return;
    expect(group.conflicts.map((conflict) => conflict.axis)).toContain("access");
    expect(group.conflicts[0]?.severity).toBe("blocking");
    expect(group.conflicts[0]?.reason).toContain("cannot take wheelchair");
    expect(group.conflicts[0]?.evidence).toContain("Steps photography gallery");
    // And it does not answer a broken pipeline by asking somebody to drop a
    // mobility requirement. There is no ask here on purpose.
    expect(group.ask).toEqual([]);
  });

  it("refuses an outdoor stop for a group that must stay in", () => {
    const group = planForGroup({
      engine: gullible(),
      request: REQUEST,
      members: [{ id: "a", label: "Feroza", hard: { indoorOnly: true } }],
      catalogue: CATALOGUE,
      weights: WEIGHTS,
    });

    expect(group.ok).toBe(false);
    if (group.ok) return;
    expect(group.session.state.ctx.avoid).toContain(INDOOR_TOKEN);
    expect(group.conflicts.map((conflict) => conflict.axis)).toContain("indoor");
  });

  it("blames the engine, not the group, when the engine is down", () => {
    // The one place this file is allowed to swallow an error: asking the gate for
    // evidence when the run already failed. It must not turn a broken engine into
    // a question for the travellers.
    const honest = referenceEngine(CATALOGUE, WEIGHTS);
    const broken: EnginePort = {
      ...honest,
      retrieve: () => {
        throw new Error("index offline");
      },
      filterFeasible: () => {
        throw new Error("index offline");
      },
    };
    const group = planForGroup({
      engine: broken,
      request: REQUEST,
      members: THE_GROUP,
      catalogue: CATALOGUE,
      weights: WEIGHTS,
    });

    expect(group.ok).toBe(false);
    if (group.ok) return;
    expect(group.reason).toBe("We could not build a plan for this window.");
    expect(group.conflicts[0]?.evidence.join("\n")).toContain("index offline");
    expect(group.ask).toEqual([]);
  });
});
