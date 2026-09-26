/**
 * Integration tests: natural language -> structured context change -> a plan the
 * real planner re-solved. These are the tests that would fail if the copilot were
 * a sentence generator bolted in front of a canned plan, because every assertion
 * is on `DiscoveryContext` AND on the `Plan` the engine returned, and on the
 * engine's own call counters.
 *
 * The planner is `referenceEngine.ts`, a small but real implementation of the
 * published `EnginePort` (retrieve -> gate -> score -> pack -> validate -> replan).
 * `src/engine/**` is another stream's directory and is not in the tree; TASKS.md
 * Rule 2 says to build against the contract and stub it, so that is what this is.
 * It reads every constraint the copilot can move — window, budget, party size,
 * `weather.condition`, `accessNeeds`, and the `indoors_only` /
 * `prefers_*_walks` tokens — which is what makes these assertions mean something.
 */
import { describe, expect, it } from "vitest";
import { DiscoveryContext, type Plan } from "../../../contracts";
import { parseIntent } from "../../../llm";
import {
  type ContextSeed,
  type DiscoverySession,
  createSession,
  discover,
  handleChat,
  mockIntentParser,
} from "..";
import { WEIGHTS, exp } from "./fixtures";
import { referenceEngine, type ReferenceEngine } from "./referenceEngine";

// ---------------------------------------------------------------------------
// A catalogue with somewhere to walk to and something to hide from the rain
// ---------------------------------------------------------------------------

const rupees = (major: number) => ({ minor: major * 100, currency: "INR" as const });

const CATALOGUE = [
  exp({
    id: "market",
    name: "Colaba Market",
    category: "market",
    indoorOutdoor: "outdoor",
    weatherSensitive: "any",
    durationMin: 45,
    pricePerPerson: rupees(400),
    keywords: ["street food", "chaat", "market", "local"],
    location: { lat: 19.0045, lon: 72.8655 },
    accessibility: { stepFree: true, strollerOk: null, lowStairs: false, seatingAvailable: null, hearingLoop: null, restroomOnSite: false },
    rating: { value: 4.5, count: 312, rawMean: 4.6 },
  }),
  exp({
    id: "cafe",
    name: "Tea Stall 22",
    category: "cafe",
    indoorOutdoor: "covered",
    weatherSensitive: "none",
    durationMin: 30,
    pricePerPerson: rupees(350),
    keywords: ["cafe", "tea", "breakfast"],
    location: { lat: 19.002, lon: 72.872 },
    accessibility: { stepFree: true, strollerOk: true, lowStairs: true, seatingAvailable: true, hearingLoop: null, restroomOnSite: true },
    rating: { value: 4.3, count: 88, rawMean: 4.4 },
  }),
  exp({
    id: "gallery",
    name: "The Courtyard Gallery",
    category: "gallery",
    indoorOutdoor: "indoor",
    weatherSensitive: "none",
    durationMin: 60,
    pricePerPerson: rupees(500),
    keywords: ["art", "gallery", "cultural", "heritage", "exhibition"],
    location: { lat: 19.006, lon: 72.874 },
    accessibility: { stepFree: true, strollerOk: true, lowStairs: true, seatingAvailable: true, hearingLoop: null, restroomOnSite: true },
    rating: { value: 4.7, count: 140, rawMean: 4.8 },
  }),
  exp({
    id: "temple",
    name: "The Fort Temple",
    category: "temple",
    indoorOutdoor: "outdoor",
    weatherSensitive: "any",
    durationMin: 40,
    pricePerPerson: rupees(150),
    keywords: ["temple", "heritage", "cultural", "monument", "architecture"],
    location: { lat: 19.0075, lon: 72.866 },
    accessibility: { stepFree: false, strollerOk: null, lowStairs: true, seatingAvailable: true, hearingLoop: null, restroomOnSite: true },
    rating: { value: 4.6, count: 501, rawMean: 4.6 },
  }),
  exp({
    id: "craft",
    name: "Warli Craft Studio",
    category: "craft_workshop",
    indoorOutdoor: "indoor",
    weatherSensitive: "none",
    durationMin: 75,
    pricePerPerson: rupees(600),
    keywords: ["craft", "workshop", "hands on", "art"],
    location: { lat: 19.009, lon: 72.879 },
    accessibility: { stepFree: true, strollerOk: true, lowStairs: true, seatingAvailable: true, hearingLoop: null, restroomOnSite: true },
    rating: { value: 4.8, count: 64, rawMean: 4.9 },
  }),
  exp({
    id: "seaside",
    name: "Marine Steps",
    category: "nature",
    indoorOutdoor: "outdoor",
    weatherSensitive: "any",
    durationMin: 50,
    pricePerPerson: rupees(250),
    keywords: ["beach", "waterfront", "sunset", "marine"],
    location: { lat: 19.001, lon: 72.856 },
    accessibility: { stepFree: true, strollerOk: null, lowStairs: true, seatingAvailable: false, hearingLoop: null, restroomOnSite: false },
    rating: { value: 4.4, count: 260, rawMean: 4.4 },
  }),
];

const byId = new Map(CATALOGUE.map((item) => [item.id, item]));
const ids = (plan: Plan): string[] => plan.stops.map((stop) => stop.experienceId);
const named = (id: string): string => byId.get(id)?.name ?? id;

const SEED: ContextSeed = {
  id: "ctx-live",
  origin: { label: "Colaba", point: { lat: 19.0, lon: 72.87 } },
  availableMin: 60,
  nowMin: 600,
};

/** A session with a plan the real pipeline built, exactly as the app builds one. */
function live(seed: Partial<ContextSeed> = {}): {
  engine: ReferenceEngine;
  session: DiscoverySession;
  plan: Plan;
} {
  const engine = referenceEngine(CATALOGUE, WEIGHTS);
  const created = createSession({ engine, seed: { ...SEED, ...seed }, catalogue: CATALOGUE, weights: WEIGHTS });
  const first = discover(engine, created);
  if (!first.ok) throw new Error(`fixture did not build a plan: ${first.reason}`);
  return { engine, session: first.session, plan: first.plan };
}

/** The scripted `LLM=off` parser: no model, no network, the copilot's own reading. */
const offline = () => mockIntentParser();

describe("mandatory: 3 hours, Rs 1500, with my parents, then make it cheaper", () => {
  it("changes the context AND the plan, through the engine", async () => {
    const { engine, session, plan: before } = live();

    const opened = await handleChat(engine, offline(), session, "I have 3 hours, ₹1500, and I'm with my parents.");
    expect(opened.acted).toBe(true);
    const ctx = opened.state.ctx;
    expect(ctx.availableMin).toBe(180);
    expect(ctx.budget?.minor).toBe(150000);
    expect(ctx.partySize).toBe(3);
    expect(ctx.accessNeeds).toEqual(expect.arrayContaining(["lowStairs", "restroom"]));

    // The opening sentence alone re-solved the plan for three older adults.
    const afterOpening = (opened.replan as { plan: Plan }).plan;
    expect(afterOpening).not.toBe(before);
    expect(afterOpening.stops.length).toBeGreaterThan(0);

    const cheaper = await handleChat(engine, offline(), sessionAfter(opened), "Make it cheaper.");
    expect(cheaper.acted).toBe(true);
    expect(cheaper.state.ctx.budget?.minor).toBe(105000);
    // Everything from the first turn survived the second.
    expect(cheaper.state.ctx.availableMin).toBe(180);
    expect(cheaper.state.ctx.partySize).toBe(3);
    expect(cheaper.state.ctx.accessNeeds).toEqual(expect.arrayContaining(["lowStairs", "restroom"]));
    // The plan itself moved, and it moved because a stop no longer fits the money.
    const replanned = (cheaper.replan as { plan: Plan }).plan;
    expect(replanned).not.toBe(afterOpening);
    expect(replanned.totalCost.minor).toBeLessThan(afterOpening.totalCost.minor);
    const dropped = ids(afterOpening).filter((id) => !ids(replanned).includes(id));
    expect(dropped.length).toBeGreaterThan(0);
    expect(replanned.rejected.some((entry) => entry.experienceId === dropped[0] && entry.code === "over_budget")).toBe(true);
    // And the engine really ran: one re-solve per acting turn, no more.
    expect(engine.calls.replan).toBe(2);
  });
});

/** The session the sidecar would be holding after a turn, plan included. */
function sessionAfter(outcome: { replan: unknown; state: DiscoverySession["state"] }): DiscoverySession {
  const replan = outcome.replan as { ok: true; session: DiscoverySession } | { ok: false; session: DiscoverySession };
  return replan.session;
}

describe("mandatory: a plan with outdoor stops, then it started raining", () => {
  it("re-solves the plan and takes the outdoor stops out", async () => {
    const { engine, session, plan: before } = live({ availableMin: 240, budgetMinor: 200000 });
    const outdoorBefore = ids(before).filter((id) => byId.get(id)?.indoorOutdoor === "outdoor");
    expect(outdoorBefore.length).toBeGreaterThan(0);
    expect(before.stops.length).toBeGreaterThan(2);

    const outcome = await handleChat(engine, offline(), session, "It started raining.");
    expect(outcome.acted).toBe(true);
    expect(outcome.state.ctx.weather.condition).toBe("heavy_rain");

    // Not a different sentence about the same plan: a different plan.
    const after = (outcome.replan as { plan: Plan }).plan;
    expect(after).not.toBe(before);
    expect(ids(after)).not.toEqual(ids(before));
    expect(after.engineVersion).toBe(before.engineVersion);
    for (const id of outdoorBefore) expect(ids(after)).not.toContain(id);
    for (const stop of after.stops) expect(byId.get(stop.experienceId)?.indoorOutdoor).not.toBe("outdoor");
    expect(after.rejected.some((entry) => outdoorBefore.includes(entry.experienceId) && entry.code === "weather_unsafe")).toBe(true);

    // The diff, the swap reasons and the reply all come from the engine's own output.
    const replanned = outcome.replan as {
      ok: true;
      diff: { removed: { id: string; name: string }[]; added: { id: string; name: string }[] };
      plan: Plan;
    };
    expect(replanned.diff.removed.map((entry) => entry.id)).toEqual(outdoorBefore);
    expect(outcome.reply).toContain(named(outdoorBefore[0] as string));
    expect(outcome.reply).toContain(replanned.diff.added[0]?.name as string);
    expect(engine.calls.replan).toBe(1);
  });
});

describe("the other sentences in the brief", () => {
  it("less walking drops the stops that need a walk", async () => {
    const { engine, session, plan: before } = live({ availableMin: 240, budgetMinor: 200000 });
    const outcome = await handleChat(engine, offline(), session, "Less walking.");

    expect(outcome.acted).toBe(true);
    expect(outcome.state.ctx.avoid).toContain("prefers_no_walks");
    expect(outcome.state.ctx.travelMode).toBe("auto");

    const after = (outcome.replan as { plan: Plan }).plan;
    expect(after).not.toBe(before);
    expect(after.totalMetres).toBeLessThan(before.totalMetres);
    for (const leg of after.legs) expect(leg.mode).toBe("auto");
    expect(after.rejected.some((entry) => entry.code === "too_far")).toBe(true);
    expect(ids(after).length).toBeLessThan(ids(before).length);
  });

  it("indoor only leaves nothing that needs you to be outside", async () => {
    const { engine, session } = live({ availableMin: 240, budgetMinor: 200000 });
    const outcome = await handleChat(engine, offline(), session, "Indoor only.");

    expect(outcome.acted).toBe(true);
    const after = (outcome.replan as { plan: Plan }).plan;
    expect(after.stops.length).toBeGreaterThan(0);
    for (const stop of after.stops) {
      expect(byId.get(stop.experienceId)?.indoorOutdoor).not.toBe("outdoor");
    }
  });

  it("something cultural leads with the heritage place", async () => {
    const { engine, session, plan: before } = live({ availableMin: 180, budgetMinor: 200000 });
    const outcome = await handleChat(engine, offline(), session, "Give me something cultural.");

    expect(outcome.acted).toBe(true);
    expect(outcome.state.ctx.interests).toEqual(expect.arrayContaining(["culture", "heritage"]));
    const after = (outcome.replan as { plan: Plan }).plan;
    expect(after).not.toBe(before);
    // A place the traveller named heritage is now first, where before the first
    // stop was chosen on proximity alone and matched nothing they had said.
    expect(["temple", "gallery"]).toContain(ids(after)[0]);
    expect(ids(before)[0]).not.toBe(ids(after)[0]);
    expect(before.stops[0]?.score.components[0]?.reason).toBe("nothing you named");
    expect(after.stops[0]?.score.components[0]?.reason).toContain("heritage");
  });

  it("tired parents re-solve for stairs, toilets and short walks together", async () => {
    const { engine, session, plan: before } = live({ availableMin: 240, budgetMinor: 200000 });
    const outcome = await handleChat(engine, offline(), session, "My parents are tired.");

    expect(outcome.acted).toBe(true);
    const ctx = outcome.state.ctx;
    expect(ctx.partyType).toBe("older_adults");
    expect(ctx.accessNeeds).toContain("lowStairs");
    expect(ctx.avoid).toContain("prefers_no_walks");

    const after = (outcome.replan as { plan: Plan }).plan;
    expect(after).not.toBe(before);
    for (const stop of after.stops) {
      expect(byId.get(stop.experienceId)?.accessibility.lowStairs).toBe(true);
      expect(byId.get(stop.experienceId)?.accessibility.restroomOnSite).toBe(true);
    }
  });
});

describe("a whole conversation in one session", () => {
  it("accumulates, re-solves every time, and never loses the original ask", async () => {
    const { engine, session, plan: first } = live();
    const original = session.intent;
    let current = session;
    let previous = first;
    const script = [
      "I have 3 hours, ₹1500, and I'm with my parents.",
      "Make it cheaper.",
      "It started raining.",
      "Less walking.",
    ];

    for (const [index, text] of script.entries()) {
      const outcome = await handleChat(engine, offline(), current, text);
      expect(outcome.acted, text).toBe(true);
      const plan = (outcome.replan as { plan: Plan }).plan;
      expect(plan, text).not.toBe(previous);
      expect(outcome.state.ctx.original, text).toEqual(original.original);
      current = sessionAfter(outcome);
      previous = plan;
      expect(engine.calls.replan).toBe(index + 1);
    }

    const final = current.state.ctx;
    expect(final.availableMin).toBe(180);
    expect(final.budget?.minor).toBe(105000);
    expect(final.weather.condition).toBe("heavy_rain");
    expect(final.partySize).toBe(3);
    expect(final.avoid).toEqual(expect.arrayContaining(["indoors_only", "prefers_no_walks"]));
    // The creation-time context is still the one the traveller started with.
    expect(current.intent.availableMin).toBe(60);
    expect(current.intent.budget).toBeNull();
    // And the plan on screen is consistent with the context it was solved for.
    expect(previous.contextId).toBe(final.id);
  });
});

describe("wired the way the app wires it", () => {
  it("goes through the real `src/llm` NLU with the model switched off", async () => {
    // This is the app's whole integration: `handleChat(engine, { parseIntent }, ...)`.
    // `LLM_OFF=1` makes `src/llm`'s client short-circuit before it builds a
    // provider, so this is the documented `LLM=off` path with no network, and the
    // decision under test is the one the product really uses in that mode.
    const previous = process.env.LLM_OFF;
    process.env.LLM_OFF = "1";
    try {
      const { engine, session, plan: before } = live({ availableMin: 240, budgetMinor: 200000 });
      expect(before.stops.some((stop) => byId.get(stop.experienceId)?.indoorOutdoor === "outdoor")).toBe(true);

      const outcome = await handleChat(engine, { parseIntent }, session, "It started raining.");

      expect(outcome.acted).toBe(true);
      expect(outcome.state.ctx.weather.condition).toBe("heavy_rain");
      const after = (outcome.replan as { plan: Plan }).plan;
      expect(after).not.toBe(before);
      for (const stop of after.stops) {
        expect(byId.get(stop.experienceId)?.indoorOutdoor).not.toBe("outdoor");
      }
      expect(engine.calls.replan).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.LLM_OFF;
      else process.env.LLM_OFF = previous;
    }
  });
});

describe("the loop's guards", () => {  it("still acts when the model is unreachable, because the floor reads the sentence", async () => {
    const { engine, session } = live({ availableMin: 240, budgetMinor: 200000 });
    const unreachable = {
      parseIntent: async (): Promise<never> => {
        throw new Error("rate limited");
      },
    };
    const outcome = await handleChat(engine, unreachable, session, "Make it cheaper.");

    expect(outcome.acted).toBe(true);
    expect(outcome.degraded).toBe(true);
    expect(outcome.state.ctx.budget?.minor).toBeLessThan(200000);
    expect(engine.calls.replan).toBe(1);
  });

  it("still acts when the model returns something the contract does not allow", async () => {
    const { engine, session } = live({ availableMin: 240, budgetMinor: 200000 });
    const leaky = {
      parseIntent: async () => ({
        contextPatch: {},
        reply: "Here you go.",
        confidence: 1,
        suggestions: [],
        reordering: ["market"],
      }),
    };
    const outcome = await handleChat(engine, leaky, session, "Make it cheaper.");

    expect(outcome.acted).toBe(true);
    expect(outcome.degraded).toBe(true);
    expect(outcome.state.ctx.budget?.minor).toBeLessThan(200000);
  });

  it("asks instead of acting when neither reader found a change", async () => {
    const { engine, session, plan: before } = live({ availableMin: 240, budgetMinor: 200000 });
    const unsure = mockIntentParser({ stairs: { contextPatch: { accessNeeds: ["wheelchair"] }, reply: "Stairs, or a step-free route?", confidence: 0.2 } });
    const outcome = await handleChat(engine, unsure, session, "the lift thing again");

    expect(outcome.acted).toBe(false);
    expect(outcome.needsClarification).toBe(true);
    expect(outcome.replan).toBeNull();
    expect(outcome.state.ctx.accessNeeds).toEqual([]);
    expect(session.plan).toBe(before);
    expect(engine.calls.replan).toBe(0);
  });

  it("rolls the context back when the planner cannot honour the change", async () => {
    const { engine, session, plan: before } = live({ availableMin: 240, budgetMinor: 200000 });
    const broken: ReferenceEngine = { ...engine, replan: () => { throw new Error("solver diverged"); } };
    const outcome = await handleChat(broken, offline(), session, "It started raining.");

    expect(outcome.acted).toBe(false);
    expect(outcome.reply).toContain("unchanged");
    expect(outcome.state.ctx.weather.condition).toBe("clear");
    expect(outcome.state.ctx.avoid).not.toContain("indoors_only");
    expect(session.plan).toBe(before);
  });

  it("never lets a plan past the validator", async () => {
    const { engine, session } = live({ availableMin: 240, budgetMinor: 200000 });
    const lying: ReferenceEngine = {
      ...engine,
      replan: (prev, ctx, change) => {
        const honest = engine.replan(prev, ctx, change);
        // A packer that claims a cost the stops do not add up to.
        return { ...honest, plan: { ...honest.plan, totalCost: { minor: 1, currency: "INR" } } };
      },
    };
    const outcome = await handleChat(lying, offline(), session, "It started raining.");

    expect(outcome.acted).toBe(false);
    expect(outcome.state.ctx.weather.condition).toBe("clear");
    expect(session.plan).not.toBeNull();
  });
});

describe("the context a turn produces is always a real one", () => {
  it("survives every sentence in the brief", async () => {
    const { engine, session } = live({ availableMin: 240, budgetMinor: 200000 });
    const script = [
      "I have 3 hours, ₹1500, and I'm with my parents.",
      "Make it cheaper.",
      "Less walking.",
      "Indoor only.",
      "My parents are tired.",
      "It started raining.",
      "Give me something cultural.",
    ];
    let current: DiscoverySession = session;
    for (const text of script) {
      const outcome = await handleChat(engine, offline(), current, text);
      expect(DiscoveryContext.safeParse(outcome.state.ctx).success, text).toBe(true);
      current = sessionAfter(outcome);
    }
  });
});
