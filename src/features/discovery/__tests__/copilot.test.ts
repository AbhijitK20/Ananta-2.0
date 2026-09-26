/**
 * Unit tests for the copilot's half: what a sentence is understood to mean, and
 * what that does to `DiscoveryContext`. No planner here — these assert the
 * structured change, and `copilot.integration.test.ts` asserts that the change
 * re-solves a real plan.
 *
 * The floor is the point of most of them: every utterance below produces the
 * right context with NO model in the loop, which is the `LLM=off` behaviour
 * `docs/FEATURES.md` §7 and `docs/ARCHITECTURE.md` §10 require.
 */
import { describe, expect, it } from "vitest";
import { DiscoveryContext } from "../../../contracts";
import {
  CONFIDENCE_GATE,
  OWN_CONFIDENCE,
  createContext,
  planTurn,
  readTurn,
  summariseSwaps,
  turnReason,
  type ContextSeed,
  type EditorState,
} from "..";

const SEED: ContextSeed = {
  id: "ctx-copilot",
  origin: { label: "Colaba", point: { lat: 19.0, lon: 72.87 } },
  availableMin: 60,
  nowMin: 600,
};

const editor = (seed: Partial<ContextSeed> = {}): EditorState => createContext({ ...SEED, ...seed });

/** The opening sentence of the flagship scenario, in the traveller's own words. */
const OPENING = "I have 3 hours, ₹1500, and I'm with my parents.";

/** The eight keys `DialogueDecision.contextPatch` is allowed to carry. */
const PATCH_KEYS = [
  "accessNeeds",
  "availableMin",
  "avoid",
  "budgetMinor",
  "indoorOnly",
  "interests",
  "mood",
  "partySize",
];

describe("the copilot's own reading", () => {
  it("reads the axes the frozen DialogueDecision has no field for", () => {
    expect(readTurn("It started raining.").matched).toEqual(["weather.heavy_rain"]);
    expect(readTurn("Less walking.").matched).toEqual(["walking.minimal"]);
    expect(readTurn("A bit of walking is fine.").matched).toEqual(["walking.low"]);
    expect(readTurn("My parents are tired.").matched).toEqual(["walking.minimal"]);
    expect(readTurn("The rain has cleared.").matched).toEqual(["weather.clear"]);
    expect(readTurn("Give me something cultural.").matched).toEqual(["interest.culture"]);
  });

  it("reads nothing out of a sentence with no change in it", () => {
    expect(readTurn("what is the weather like").matched).toEqual([]);
    expect(readTurn("reorder my plan").matched).toEqual([]);
  });

  it("never contradicts itself: one op per axis, weather and walking both heard", () => {
    const ops = readTurn("Less walking, it started raining, something cultural.").ops;
    expect(ops.map((op) => op.kind)).toEqual(["set_weather", "set_walking", "add_interests"]);
  });
});

describe("one turn, no model in the loop", () => {
  it("turns the opening sentence into a context the planner can use", () => {
    const turn = planTurn(editor(), OPENING);
    const after = turn.state.ctx;

    expect(turnReason(turn)).toBe("ok");
    expect(turn.change?.kind).toBe("time_grew");
    expect(after.availableMin).toBe(180);
    expect(after.budget?.minor).toBe(150000);
    // "with my parents" is three people, party type and access defaults included.
    expect(after.partySize).toBe(3);
    expect(after.partyType).toBe("older_adults");
    expect(after.accessNeeds).toEqual(expect.arrayContaining(["lowStairs", "restroom"]));
    // The numbers in the reply are the traveller's own, echoed back.
    expect(turn.decision.reply).toContain("3 h");
    expect(turn.decision.reply).toContain("₹1,500");
    expect(turn.degraded).toBe(true);
    expect(DiscoveryContext.safeParse(after).success).toBe(true);
  });

  it("makes it cheaper against the budget the traveller already gave", () => {
    const first = planTurn(editor(), OPENING);
    const turn = planTurn(first.state, "Make it cheaper.");

    expect(turn.change?.kind).toBe("budget_cut");
    expect(turn.state.ctx.budget?.minor).toBe(105000);
    // Everything the first turn established survives the second.
    expect(turn.state.ctx.availableMin).toBe(180);
    expect(turn.state.ctx.partySize).toBe(3);
    expect(turn.state.ctx.accessNeeds).toEqual(expect.arrayContaining(["lowStairs", "restroom"]));
  });

  it("has nothing to scale when the traveller never said a budget", () => {
    const turn = planTurn(editor(), "Make it cheaper.");
    expect(turn.change).toBeNull();
    expect(turnReason(turn)).toBe("no_change");
  });

  it("lowers less walking into the tokens the engine reads, not just a mood", () => {
    const turn = planTurn(editor({ availableMin: 240, budgetMinor: 200000 }), "Less walking.");
    expect(turn.state.ctx.avoid).toContain("prefers_no_walks");
    // Fewer legs on foot is the contract's only lever on walking.
    expect(turn.state.ctx.travelMode).toBe("auto");
    expect(turn.change?.kind).toBe("mood_changed");
  });

  it("keeps a walk budget when the traveller only minds a bit of walking", () => {
    const turn = planTurn(editor(), "A bit of walking is fine.");
    expect(turn.state.ctx.avoid).toContain("prefers_short_walks");
    expect(turn.state.ctx.avoid).not.toContain("prefers_no_walks");
  });

  it("turns 'indoor only' into the indoor token the gate reads", () => {
    const turn = planTurn(editor(), "Indoor only.");
    expect(turn.state.ctx.avoid).toContain("indoors_only");
    expect(turn.change).not.toBeNull();
  });

  it("reads tired parents as an access need and a slower day", () => {
    const turn = planTurn(editor({ availableMin: 240 }), "My parents are tired.");
    expect(turn.state.ctx.accessNeeds).toContain("lowStairs");
    expect(turn.state.ctx.avoid).toContain("prefers_no_walks");
    expect(turn.state.ctx.partyType).toBe("older_adults");
  });

  it("moves the weather, which is a fact about the world rather than a preference", () => {
    const turn = planTurn(editor(), "It started raining.");
    // The gate reads `weather.condition`. Without this the sentence would only
    // have set a preference token and the weather gate would never fire.
    expect(turn.state.ctx.weather.condition).toBe("heavy_rain");
    expect(turn.state.ctx.avoid).toContain("indoors_only");
    expect(turn.change?.kind).toBe("weather_changed");
    expect(turn.change?.narrative).toBe("Rain started.");
  });

  it("can also say the rain stopped", () => {
    const raining = planTurn(editor(), "It started raining.");
    const turn = planTurn(raining.state, "The rain has cleared.");
    expect(turn.state.ctx.weather.condition).toBe("clear");
  });

  it("adds the culture facet in the engine's own vocabulary", () => {
    const turn = planTurn(editor(), "Give me something cultural.");
    expect(turn.state.ctx.interests).toEqual(expect.arrayContaining(["culture", "heritage"]));
    expect(turn.change?.kind).toBe("interest_added");
  });

  it("adds to what is already known and never replaces it", () => {
    const first = planTurn(editor({ interests: ["street_food"], avoid: ["crowds"] }), OPENING);
    const turn = planTurn(first.state, "Give me something cultural.");
    expect(turn.state.ctx.interests).toEqual(expect.arrayContaining(["street_food", "culture", "heritage"]));
    expect(turn.state.ctx.avoid).toContain("crowds");
  });
});

describe("multi-turn", () => {
  it("keeps the original intent forever, whatever is said afterwards", () => {
    const start = editor();
    const first = planTurn(start, OPENING);
    const second = planTurn(first.state, "Make it cheaper.");
    const third = planTurn(second.state, "Less walking.");

    for (const turn of [first, second, third]) {
      expect(turn.state.ctx.original).toEqual(start.ctx.original);
    }
    expect(third.state.ctx.original.availableMin).toBe(60);
    expect(third.state.ctx.original.budget).toBeNull();
    // The current context has moved on from it, which is the point of keeping both.
    expect(third.state.ctx.availableMin).toBe(180);
    expect(third.state.ctx.budget?.minor).toBe(105000);
  });

  it("accumulates four turns into one context", () => {
    const script = [OPENING, "Make it cheaper.", "It started raining.", "Less walking."];
    const final = script.reduce<EditorState>((state, text) => planTurn(state, text).state, editor());
    const ctx = final.ctx;

    expect(ctx.availableMin).toBe(180);
    expect(ctx.budget?.minor).toBe(105000);
    expect(ctx.weather.condition).toBe("heavy_rain");
    expect(ctx.avoid).toEqual(expect.arrayContaining(["indoors_only", "prefers_no_walks"]));
    expect(ctx.partySize).toBe(3);
    expect(ctx.partyType).toBe("older_adults");
  });

  it("reports no change when the same sentence is said twice", () => {
    const first = planTurn(editor(), "Indoor only.");
    const second = planTurn(first.state, "Indoor only.");
    expect(second.change).toBeNull();
    expect(second.state.ctx.avoid).toEqual(first.state.ctx.avoid);
  });
});

describe("failing safely", () => {
  it("changes nothing when there is nothing to change", () => {
    for (const text of ["asdfgh qwerty", "hello there", "reorder my plan", "what do you think?"]) {
      const before = editor();
      const turn = planTurn(before, text);
      expect(turn.change, text).toBeNull();
      expect(turn.state, text).toBe(before);
    }
  });

  it("does not read a party out of a question about a place", () => {
    // "somewhere good for parents" asks about a venue. It is not a fact about
    // who is travelling, so the party must not move.
    expect(readTurn("is anywhere good for parents?").matched).toEqual([]);
    const turn = planTurn(editor(), "is anywhere good for parents?");
    expect(turn.state.ctx.partySize).toBe(1);
    expect(turn.state.ctx.partyType).toBe("solo");
  });

  it("treats a question as a question", () => {
    // "cheap" with no budget to scale is advice, not a constraint.
    expect(planTurn(editor(), "is there anything cheap nearby?").change).toBeNull();
  });

  it("clamps a hostile figure instead of writing it into the context", () => {
    const turn = planTurn(editor(), "I have 900 hours");
    expect(turn.state.ctx.availableMin).toBeLessThanOrEqual(1440);
    expect(DiscoveryContext.safeParse(turn.state.ctx).success).toBe(true);
  });

  it("gates the model and never gates its own rule set", () => {
    const floor = planTurn(editor(), "It started raining.");
    expect(floor.decision.confidence).toBeGreaterThanOrEqual(OWN_CONFIDENCE);
    expect(CONFIDENCE_GATE).toBe(0.5);

    const unsure = planTurn(editor(), "It started raining.", {
      contextPatch: { budgetMinor: 1 },
      reply: "Not sure.",
      confidence: 0.2,
      suggestions: [],
    });
    // Below the gate the model contributes nothing, and the floor still acts.
    expect(unsure.state.ctx.budget).toBeNull();
    expect(unsure.state.ctx.weather.condition).toBe("heavy_rain");
    expect(unsure.degraded).toBe(true);

    const sure = planTurn(editor({ budgetMinor: 200000 }), "Something cheaper", {
      contextPatch: { budgetMinor: 90000 },
      reply: "Trimmed the budget.",
      confidence: 0.9,
      suggestions: [],
    });
    // Above the gate the model wins on the field it names, and the floor fills the rest.
    expect(sure.state.ctx.budget?.minor).toBe(90000);
    expect(sure.degraded).toBe(false);
  });
});

describe("what the traveller is told", () => {
  it("names the stops the engine actually dropped and added", () => {
    expect(summariseSwaps({ removed: [{ id: "a", name: "The market" }], added: [{ id: "b", name: "The gallery" }] })).toBe(
      "Dropped The market. Added The gallery.",
    );
  });

  it("says so plainly when the plan did not move", () => {
    expect(summariseSwaps({ removed: [], added: [] })).toBe("Your plan is unchanged.");
  });

  it("caps a long list rather than reading out a paragraph", () => {
    const many = (prefix: string) => [1, 2, 3, 4].map((n) => ({ id: `${prefix}${n}`, name: `Place ${n}` }));
    expect(summariseSwaps({ removed: many("r"), added: many("a") })).toBe(
      "Dropped Place 1 and Place 2 and 2 more. Added Place 1 and Place 2 and 2 more.",
    );
  });
});

describe("the contract is never widened", () => {
  it("has no way to name a place, reorder a stop, or touch a plan", () => {
    const decision = planTurn(editor(), OPENING).decision as unknown as Record<string, unknown>;
    expect(Object.keys(decision).sort()).toEqual(["confidence", "contextPatch", "reply", "suggestions"]);
    // The patch is the whole blast radius, and every key in it is a contract field.
    for (const key of Object.keys(decision.contextPatch as object)) {
      expect(PATCH_KEYS).toContain(key);
    }
  });
});
