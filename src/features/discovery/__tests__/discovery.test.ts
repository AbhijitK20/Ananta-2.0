/**
 * The discovery feature's own tests. One file, because one fake engine and one
 * seed context cover every case, and splitting them would only hide that.
 *
 * What is under test is this feature's logic: a context edit producing the right
 * `ContextChange`, the deterministic diff, the guard that refuses an
 * unvalidated plan, and the panel's four buckets. The engine's arithmetic is
 * Abhijit's to test, so the fake answers with plans rather than deciding
 * anything.
 *
 * `tests/**` is Abhijit's path (TASKS.md ownership table), so these live beside
 * the code they cover and `vitest run` picks them up from the default glob.
 */
import { describe, expect, it } from "vitest";
import { DiscoveryContext, type ContextChange, type GeoPoint } from "../../../contracts";
import {
  ACTION_BY_ID,
  CONFIDENCE_GATE,
  REALITY_TRIGGERS,
  SUGGESTIONS,
  applyAction,
  applyOp,
  applyPatch,
  classifyChange,
  createContext,
  createSession,
  diffPlans,
  discover,
  handleChat,
  mockIntentParser,
  replan,
  runAction,
  type ContextSeed,
  type EditorOp,
  type EditorState,
} from "..";
import { WEIGHTS, exp, fakeEngine, plan, rejection, replanResult, type StopSpec } from "./fixtures";

const SEED: ContextSeed = {
  id: "ctx-1",
  origin: { label: "Colaba" },
  availableMin: 120,
  nowMin: 600,
  budgetMinor: 150000,
  partySize: 2,
  interests: ["street_food", "local"],
  avoid: ["crowded"],
};

const CATALOGUE = [
  exp({ id: "market", name: "Outdoor market", category: "market", indoorOutdoor: "outdoor", weatherSensitive: "any" }),
  exp({ id: "craft", name: "Indoor craft workshop", category: "craft_workshop", indoorOutdoor: "indoor", location: { lat: 19.01, lon: 72.88 }, pricePerPerson: { minor: 50000, currency: "INR" } }),
  exp({ id: "cafe", name: "Cafe with a courtyard", category: "cafe", indoorOutdoor: "covered", location: { lat: 19.02, lon: 72.86 } }),
];

const editor = (): EditorState => createContext(SEED);
const catalogueMap = new Map(CATALOGUE.map((item) => [item.id, item]));
const change = (overrides: Partial<ContextChange> = {}): ContextChange => ({
  kind: "weather_changed",
  narrative: "Rain started.",
  patch: { weather: { condition: "heavy_rain" } },
  ...overrides,
});

/** A session whose plan is `stops`, admitted the way the app would admit it. */
function started(stops: StopSpec[] = [
  { id: "market", order: 0, arriveMin: 610, durationMin: 40, costMinor: 20000 },
  { id: "cafe", order: 1, arriveMin: 670, durationMin: 40, costMinor: 25000 },
]) {
  const engine = fakeEngine({ initial: plan(editor().ctx, stops), catalogue: CATALOGUE });
  const session = createSession({ engine, seed: SEED, catalogue: CATALOGUE, weights: WEIGHTS });
  const first = discover(engine, session);
  if (!first.ok) throw new Error(`fixture did not build: ${first.reason}`);
  return { engine, session: first.session, initial: first.plan };
}

const actionInput = (session: ReturnType<typeof started>["session"]) => ({
  state: session.state,
  plan: session.plan,
  nameOf: (id: string) => session.catalogue.get(id)?.name ?? "That place",
});

describe("context editor", () => {
  it("starts valid, and leaves the original request alone forever", () => {
    const before = editor();
    expect(DiscoveryContext.safeParse(before.ctx).success).toBe(true);
    const result = applyOp(before, { kind: "set_time", availableMin: 45 });

    expect(result.change?.kind).toBe("time_shrank");
    expect(result.state.ctx.availableMin).toBe(45);
    // Principle 3: the original ask survives every later edit.
    expect(result.state.ctx.original).toEqual(before.ctx.original);
    expect(result.state.ctx.original.availableMin).toBe(120);
  });

  it("changes every axis a traveller can change", () => {
    const base = editor();
    const ops: EditorOp[] = [
      { kind: "set_time", availableMin: 90 },
      { kind: "set_budget", budgetMinor: 60000 },
      { kind: "set_origin", label: "Bandra West", point: { lat: 19.06, lon: 72.83 } },
      { kind: "set_party", partySize: 4, childAges: [6] },
      { kind: "set_access_needs", needs: ["wheelchair"] },
      { kind: "add_interests", interests: ["music_live"] },
      { kind: "exclude", experienceIds: ["market"] },
      { kind: "set_indoor", indoorOnly: true },
      { kind: "set_walking", walking: "minimal" },
      { kind: "set_weather", condition: "light_rain" },
      { kind: "set_weather_sensitivity", sensitivity: "high" },
      { kind: "set_mood", mood: "low energy" },
    ];

    for (const op of ops) {
      const result = applyOp(base, op);
      expect(result.change, op.kind).not.toBeNull();
      // The classifier is the only thing that decides a kind, so these must agree.
      expect(classifyChange(base.ctx, result.state.ctx)).toBe(result.change?.kind);
    }
  });

  it("does not silently drop an access need the traveller just removed", () => {
    // `grew()` can only see an ADDED need, so a removal has to be caught by the
    // preference key. Without it, `classifyChange` returned null, the editor threw
    // the edit away, and the plan stayed filtered by a constraint that was gone.
    const base = applyOp(editor(), { kind: "set_access_needs", needs: ["wheelchair"] });
    expect(base.change).not.toBeNull();
    const cleared = applyOp(base.state, { kind: "set_access_needs", needs: [] });
    expect(cleared.state.ctx.accessNeeds).toEqual([]);
    expect(cleared.change).not.toBeNull();
    expect(classifyChange(base.state.ctx, cleared.state.ctx)).toBe(cleared.change?.kind);
  });

  it("derives party type, and adds the access needs an older adult implies", () => {
    const base = editor();
    const withChild = applyOp(base, { kind: "set_party", partySize: 4, childAges: [6] });
    expect(withChild.state.ctx.partyType).toBe("family_with_children");
    expect(withChild.change?.kind).toBe("party_grew");

    const withElder = applyOp(base, { kind: "set_party", partySize: 2, elderly: 1 });
    expect(withElder.state.ctx.partyType).toBe("older_adults");
    expect(withElder.state.ctx.accessNeeds).toEqual(expect.arrayContaining(["lowStairs", "restroom"]));
  });

  it("lowers preference axes into the contract and walks them back", () => {
    const base = editor();
    const indoor = applyOp(base, { kind: "set_indoor", indoorOnly: true });
    expect(indoor.state.ctx.avoid).toContain("indoors_only");
    expect(indoor.state.ctx.avoid).toContain("crowded");

    const walking = applyOp(base, { kind: "set_walking", walking: "minimal" });
    expect(walking.state.ctx.avoid).toContain("prefers_no_walks");
    expect(walking.state.ctx.travelMode).toBe("auto");

    const mood = applyOp(base, { kind: "set_mood", mood: "Low  Energy!" });
    expect(mood.state.ctx.avoid).toContain("mood_low_energy");

    // Resetting removes the token it added and nothing else.
    const off = applyOp(indoor.state, { kind: "set_indoor", indoorOnly: false });
    expect(off.state.ctx.avoid).toEqual(["crowded"]);
  });

  it("reports no change when the edit changes nothing", () => {
    const base = editor();
    expect(applyOp(base, { kind: "set_time", availableMin: 120 }).change).toBeNull();
    expect(applyOp(base, { kind: "add_interests", interests: ["street_food"] }).change).toBeNull();
  });

  it("does not drop a child age or a temperature on the floor", () => {
    const base = editor();
    // Same party size, new fact about the party. The frozen enum has no
    // "children changed" kind, so this lands on the preference fallback — what
    // matters is that it is a change and the plan gets re-solved. A stale plan
    // here books two adults into a thing with no high chairs.
    expect(applyOp(base, { kind: "set_party", partySize: 2, childAges: [4] }).change?.kind).toBe("mood_changed");
    // Same condition, different temperature. Weather gate, different answer.
    expect(applyOp(base, { kind: "set_weather", condition: "clear", tempC: 41 }).change?.kind).toBe("mood_changed");
  });

  it("never lets the window fall below the floor", () => {
    const result = applyOp(editor(), { kind: "set_time", availableMin: 2 });
    expect(result.state.ctx.availableMin).toBe(15);
    expect(DiscoveryContext.safeParse(result.state.ctx).success).toBe(true);
  });
});

describe("plan diff", () => {
  it("splits stops into removed, added and unchanged, with the engine's own reason", () => {
    const before = plan(editor().ctx, [
      { id: "market", order: 0, arriveMin: 610, durationMin: 40 },
      { id: "cafe", order: 1, arriveMin: 670, durationMin: 40 },
    ]);
    const after = plan(
      editor().ctx,
      [
        { id: "cafe", order: 0, arriveMin: 620, durationMin: 40 },
        { id: "craft", order: 1, arriveMin: 680, durationMin: 40 },
      ],
      { rejected: [rejection("market", "weather_unsafe", "Heavy rain, and this one has no cover.")] },
    );
    const diff = diffPlans(fakeEngine({ initial: before, catalogue: CATALOGUE }), before, after, {
      catalogue: catalogueMap,
      change: change(),
      travelMode: "any",
      origin: null,
    });

    expect(diff.removed.map((entry) => entry.id)).toEqual(["market"]);
    expect(diff.added.map((entry) => entry.id)).toEqual(["craft"]);
    expect(diff.unchanged.map((entry) => entry.id)).toEqual(["cafe"]);
    expect(diff.removed[0]?.name).toBe("Outdoor market");
    expect(diff.removed[0]?.reason).toBe("Heavy rain, and this one has no cover.");
    // `market` is the FIRST stop and this seed's origin has no point, so there is
    // no inbound leg to price. The panel says nothing rather than guessing.
    expect(diff.removed[0]?.travelSavedMin).toBeNull();
    expect(diff.unchanged[0]?.reordered).toBe(true);
    expect(diff.swapCount).toBe(1);
    expect(diff.changed).toBe(true);
  });

  it("charges a middle removal for BOTH of its legs, not just the outbound one", () => {
    const before = plan(editor().ctx, [
      { id: "market", order: 0, arriveMin: 610, durationMin: 40 },
      { id: "craft", order: 1, arriveMin: 670, durationMin: 40 },
      { id: "cafe", order: 2, arriveMin: 730, durationMin: 40 },
    ]);
    const after = plan(editor().ctx, [
      { id: "market", order: 0, arriveMin: 610, durationMin: 40 },
      { id: "cafe", order: 1, arriveMin: 670, durationMin: 40 },
    ]);
    const engine = fakeEngine({ initial: before, catalogue: CATALOGUE });
    const at = (id: string) => catalogueMap.get(id)!.location;
    const minutes = (from: string, to: string) => engine.travelBetween(at(from), at(to), "auto", 650).minutes;
    // Removing `craft` turns market->craft->cafe into one market->cafe leg.
    const expected = minutes("market", "craft") + minutes("craft", "cafe") - minutes("market", "cafe");

    const diff = diffPlans(engine, before, after, {
      catalogue: catalogueMap,
      change: change(),
      travelMode: "any",
      origin: null,
    });
    expect(diff.removed[0]?.id).toBe("craft");
    expect(diff.removed[0]?.travelSavedMin).toBe(expected);
  });

  it("prices a first-stop removal against the day's origin", () => {
    const seed: ContextSeed = { ...SEED, origin: { label: "Colaba", point: { lat: 19.0, lon: 72.9 } } };
    const state = createContext(seed);
    const before = plan(state.ctx, [
      { id: "market", order: 0, arriveMin: 610, durationMin: 40 },
      { id: "cafe", order: 1, arriveMin: 670, durationMin: 40 },
    ]);
    const after = plan(state.ctx, [{ id: "cafe", order: 0, arriveMin: 620, durationMin: 40 }]);
    const engine = fakeEngine({ initial: before, catalogue: CATALOGUE });
    const origin = state.ctx.origin.point!;
    const at = (id: string) => catalogueMap.get(id)!.location;
    const minutes = (from: GeoPoint, to: GeoPoint) => engine.travelBetween(from, to, "auto", 650).minutes;
    const expected =
      minutes(origin, at("market")) + minutes(at("market"), at("cafe")) - minutes(origin, at("cafe"));

    const diff = diffPlans(engine, before, after, {
      catalogue: catalogueMap,
      change: change(),
      travelMode: "any",
      origin,
    });
    expect(diff.removed[0]?.id).toBe("market");
    expect(diff.removed[0]?.travelSavedMin).toBe(expected);
  });

  it("is deterministic: the same two plans always give the same diff", () => {
    const before = plan(editor().ctx, [{ id: "market", order: 0, arriveMin: 610 }]);
    const after = plan(editor().ctx, [{ id: "craft", order: 0, arriveMin: 620 }]);
    const engine = fakeEngine({ initial: before, catalogue: CATALOGUE });
    const input = { catalogue: catalogueMap, change: change(), travelMode: "any" as const, origin: null };
    expect(diffPlans(engine, before, after, input)).toEqual(diffPlans(engine, before, after, input));
  });

  it("reports an unchanged plan as unchanged", () => {
    const one = plan(editor().ctx, [{ id: "cafe", order: 0, arriveMin: 610, durationMin: 40 }]);
    const diff = diffPlans(fakeEngine({ initial: one, catalogue: CATALOGUE }), one, one, {
      catalogue: catalogueMap,
      change: change(),
      travelMode: "any",
      origin: null,
    });
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.swapCount).toBe(0);
    expect(diff.changed).toBe(false);
  });
});

describe("replanner", () => {
  it("goes old plan -> change -> re-solve -> validation -> new plan -> diff", () => {
    const { session, initial } = started();
    const next = plan(
      session.state.ctx,
      [
        { id: "craft", order: 0, arriveMin: 615, durationMin: 40, why: ["Indoors, and the rain cannot reach it."] },
        { id: "cafe", order: 1, arriveMin: 675, durationMin: 40 },
      ],
      { rejected: [rejection("market", "weather_unsafe", "Heavy rain, and this one has no cover.")] },
    );
    const engine = fakeEngine({ initial, replans: [replanResult(next, change())], catalogue: CATALOGUE });

    const outcome = replan(engine, session, change());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan).toEqual(next);
    expect(outcome.session.plan).toBe(outcome.plan);
    expect(outcome.diff.removed.map((entry) => entry.id)).toEqual(["market"]);
    expect(outcome.diff.added.map((entry) => entry.id)).toEqual(["craft"]);
    expect(outcome.diff.unchanged.map((entry) => entry.id)).toEqual(["cafe"]);
    expect(outcome.reality.reason).toBe("Rain started. Heavy rain, and this one has no cover.");
    expect(outcome.reality.intent).toContain("street_food, local");
    expect(outcome.reality.intentPreserved).toBe(true);
    expect(outcome.reality.warnings).toEqual([]);
  });

  it("keeps the previous plan when the re-solve throws", () => {
    const { session, initial } = started();
    const engine = fakeEngine({ initial, replanThrows: new Error("solver diverged"), catalogue: CATALOGUE });
    const outcome = replan(engine, session, change());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.session.plan).toBe(session.plan);
    expect(outcome.violations[0]?.code).toBe("engine_error");
    expect(outcome.reason).toContain("unchanged");
  });

  it("refuses a plan the validator rejects", () => {
    const { session, initial } = started();
    const engine = fakeEngine({
      initial,
      replans: [replanResult(plan(editor().ctx, [{ id: "craft", order: 0, arriveMin: 610 }]), change())],
      validate: {
        ok: false,
        violations: [{ code: "objective_drift", message: "Recomputed objective does not match.", at: null }],
        recomputedObjective: 12,
        claimedObjective: 30,
        objectiveDelta: -18,
      },
      catalogue: CATALOGUE,
    });
    const outcome = replan(engine, session, change());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.session.plan).toBe(session.plan);
    expect(outcome.violations[0]?.code).toBe("objective_drift");
  });

  it("refuses a partial plan that does not satisfy the contract", () => {
    const { session, initial } = started();
    const broken = plan(editor().ctx, [{ id: "craft", order: 0, arriveMin: 610 }]);
    const first = broken.stops[0];
    if (first) delete (first as { fit?: unknown }).fit;

    const engine = fakeEngine({
      initial,
      replans: [{ plan: broken, change: change(), swaps: [], preservedIntent: true, summary: "" }],
      catalogue: CATALOGUE,
    });
    const outcome = replan(engine, session, change());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("contract_violation");
    expect(outcome.session.plan).toBe(session.plan);
  });

  it("refuses a stop the UI could not render", () => {
    const { session, initial } = started();
    const stray = plan(editor().ctx, [{ id: "ghost", order: 0, arriveMin: 610 }]);
    const engine = fakeEngine({ initial, replans: [replanResult(stray, change())], catalogue: CATALOGUE });
    const outcome = replan(engine, session, change());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("stop_not_in_catalogue");
    expect(outcome.session.plan).toBe(session.plan);
  });

  it("refuses a plan built for a different context", () => {
    const { session, initial } = started();
    const drifted = { ...plan(editor().ctx, [{ id: "craft", order: 0, arriveMin: 610 }]), contextId: "someone-else" };
    const engine = fakeEngine({
      initial,
      replans: [{ plan: drifted, change: change(), swaps: [], preservedIntent: true, summary: "" }],
      catalogue: CATALOGUE,
    });
    const outcome = replan(engine, session, change());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("context_drift");
  });

  it("has nothing to adapt before the first build", () => {
    const engine = fakeEngine({ initial: plan(editor().ctx, []), catalogue: CATALOGUE });
    const session = createSession({ engine, seed: SEED, catalogue: CATALOGUE, weights: WEIGHTS });
    const outcome = replan(engine, session, change());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.session.plan).toBeNull();
  });

  it("flags a swap set over budget instead of shipping it quietly", () => {
    const { session, initial } = started([
      { id: "market", order: 0, arriveMin: 610, durationMin: 30 },
      { id: "cafe", order: 1, arriveMin: 650, durationMin: 30 },
      { id: "craft", order: 2, arriveMin: 690, durationMin: 30 },
    ]);
    const emptied = plan(session.state.ctx, [], {
      rejected: [
        rejection("market", "duration_exceeds_budget", "Needs 40 min more than you have left."),
        rejection("cafe", "duration_exceeds_budget", "Needs 40 min more than you have left."),
        rejection("craft", "duration_exceeds_budget", "Needs 40 min more than you have left."),
      ],
    });
    const engine = fakeEngine({ initial, replans: [replanResult(emptied, change())], catalogue: CATALOGUE });

    const outcome = replan(engine, session, change());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reality.swapCount).toBe(3);
    expect(outcome.reality.warnings.join(" ")).toContain("3 swaps");
    // Nothing was invented to fill the gap, which is the point of the check.
    expect(outcome.reality.after.stops).toBe(0);
  });

  it("carries the stress rescue move into the panel", () => {
    const { session, initial } = started();
    const next = plan(session.state.ctx, [{ id: "craft", order: 0, arriveMin: 615 }], {
      stressScore: 61,
      stressFactors: [{ dimension: "transfers", weight: 0.3, value: 0.8, rescue: "Move both stops into one cluster." }],
    });
    const engine = fakeEngine({ initial, replans: [replanResult(next, change())], catalogue: CATALOGUE });
    const outcome = replan(engine, session, change());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reality.rescue).toBe("Move both stops into one cluster.");
    expect(outcome.reality.after.stressScore).toBe(61);
  });

  it("scores the old plan against the new window, so a pointless churn is visible", () => {
    const { session, initial } = started();
    const next = plan(session.state.ctx, [
      { id: "craft", order: 0, arriveMin: 615 },
      { id: "cafe", order: 1, arriveMin: 675 },
    ], { rejected: [rejection("market", "weather_unsafe", "Heavy rain, and this one has no cover.")] });
    const engine = fakeEngine({ initial, replans: [replanResult(next, change())], catalogue: CATALOGUE });
    const outcome = replan(engine, session, change());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The fake answers 40 for any plan under any context, which is the point:
    // the number is re-derived against the new window, not copied off the plan.
    expect(outcome.reality.stressBefore).toBe(40);
  });
});

describe("reality triggers and suggestions", () => {
  it("maps every trigger to a real patch with a sentence a human wrote", () => {
    const { session } = started();
    for (const trigger of REALITY_TRIGGERS) {
      const edit = runAction(trigger, actionInput(session));
      expect(edit, trigger.id).not.toBeNull();
      if (!edit?.change) continue;
      expect(Object.keys(edit.change.patch).length, trigger.id).toBeGreaterThan(0);
      expect(edit.change.narrative, trigger.id).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it("reduces the window when time is lost", () => {
    const { session } = started();
    const edit = runAction(ACTION_BY_ID.get("time_lost")!, actionInput(session));
    expect(edit?.change?.kind).toBe("time_shrank");
    expect(edit?.state.ctx.availableMin).toBe(30);
  });

  it("cuts the budget against what the plan actually cost", () => {
    const { session } = started();
    const edit = runAction(ACTION_BY_ID.get("cheaper")!, actionInput(session));
    expect(edit?.change?.kind).toBe("budget_cut");
    // 45000 paise of plan, 70% of it, rounded to a rupee the traveller said.
    expect(edit?.state.ctx.budget?.minor).toBe(31500);
  });

  it("does not offer a budget cut with no plan to measure against", () => {
    const { session } = started();
    expect(runAction(ACTION_BY_ID.get("cheaper")!, { ...actionInput(session), plan: null })).toBeNull();
    expect(runAction(ACTION_BY_ID.get("sold_out")!, { ...actionInput(session), plan: null })).toBeNull();
  });

  it("adds an accessibility need as a patch, not as a flag", () => {
    const { session } = started();
    const edit = runAction(ACTION_BY_ID.get("restroom")!, actionInput(session));
    expect(edit?.change?.kind).toBe("access_need_added");
    expect(edit?.state.ctx.accessNeeds).toContain("restroom");
  });

  it("never lets one sentence delete a need the traveller already stated", () => {
    const { session } = started();
    const withWheelchair = applyOp(session.state, { kind: "add_access_needs", needs: ["wheelchair"] });
    const edit = runAction(ACTION_BY_ID.get("restroom")!, { ...actionInput(session), state: withWheelchair.state });
    expect(edit?.state.ctx.accessNeeds).toEqual(expect.arrayContaining(["wheelchair", "restroom"]));
  });

  it("maps weather, walking tolerance and indoor only", () => {
    const { session } = started();
    const input = actionInput(session);
    expect(runAction(ACTION_BY_ID.get("rain")!, input)?.change?.kind).toBe("weather_changed");
    expect(runAction(ACTION_BY_ID.get("exhausted")!, input)?.state.ctx.avoid).toContain("prefers_no_walks");
    expect(runAction(ACTION_BY_ID.get("less_walking")!, input)?.state.ctx.avoid).toContain("prefers_short_walks");
    expect(runAction(ACTION_BY_ID.get("indoor_only")!, input)?.state.ctx.avoid).toContain("indoors_only");
    expect(runAction(ACTION_BY_ID.get("less_time")!, input)?.state.ctx.availableMin).toBe(60);
  });

  it("sells the first stop when it is sold out", () => {
    const { session } = started();
    const edit = runAction(ACTION_BY_ID.get("sold_out")!, actionInput(session));
    expect(edit?.state.ctx.excludedIds).toEqual(["market"]);
    expect(edit?.change?.kind).toBe("became_unavailable");
    expect(edit?.change?.narrative).toBe("Outdoor market is sold out.");
  });

  it("exposes the eight suggestions, and every one applies", () => {
    expect(SUGGESTIONS.map((action) => action.id)).toEqual([
      "cheaper",
      "less_walking",
      "more_local",
      "indoor_only",
      "less_time",
      "family_friendly",
      "more_food",
      "more_culture",
    ]);
    const { session } = started();
    for (const action of SUGGESTIONS) {
      expect(runAction(action, actionInput(session))?.change, action.id).not.toBeNull();
    }
  });

  it("rolls the context back when the replan is refused", () => {
    const { session, initial } = started();
    const engine = fakeEngine({ initial, replanThrows: new Error("nope"), catalogue: CATALOGUE });
    const outcome = applyAction(engine, session, ACTION_BY_ID.get("rain")!);
    expect(outcome.ok).toBe(false);
    // An "indoors only" toggle that could not be honoured must not stick.
    expect(outcome.session.state.ctx.weather.condition).toBe("clear");
    expect(outcome.session.plan).toBe(session.plan);
  });

  it("adopts the new plan when the replan holds up", () => {
    const { session, initial } = started();
    const next = plan(session.state.ctx, [
      { id: "craft", order: 0, arriveMin: 615, durationMin: 40 },
      { id: "cafe", order: 1, arriveMin: 675, durationMin: 40 },
    ], { rejected: [rejection("market", "weather_unsafe", "Heavy rain, and this one has no cover.")] });
    const engine = fakeEngine({ initial, replans: [replanResult(next, change())], catalogue: CATALOGUE });

    const outcome = applyAction(engine, session, ACTION_BY_ID.get("rain")!);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.session.state.ctx.weather.condition).toBe("heavy_rain");
    expect(outcome.session.lastReality?.reason).toContain("Rain started.");
    expect(outcome.reality.removed.map((entry) => entry.id)).toEqual(["market"]);
  });
});

describe("chat sidecar", () => {
  it("turns an utterance into a patch and then into a plan", async () => {
    const { session, initial } = started();
    const next = plan(session.state.ctx, [{ id: "craft", order: 0, arriveMin: 615 }], {
      rejected: [rejection("market", "weather_unsafe", "Heavy rain, and this one has no cover.")],
    });
    const engine = fakeEngine({ initial, replans: [replanResult(next, change())], catalogue: CATALOGUE });
    const parser = mockIntentParser({
      rain: { contextPatch: { mood: "low energy" }, reply: "Rain started, so I moved you indoors.", confidence: 0.9 },
    });

    const outcome = await handleChat(engine, parser, session, "it started raining");
    expect(outcome.acted).toBe(true);
    expect(outcome.needsClarification).toBe(false);
    expect(outcome.state.ctx.avoid).toContain("mood_low_energy");
    expect(outcome.replan?.ok).toBe(true);
  });

  it("asks instead of acting below the confidence gate", async () => {
    const { engine, session } = started();
    const parser = mockIntentParser({
      stairs: { contextPatch: { accessNeeds: ["wheelchair"] }, reply: "Stairs, or a step-free route?", confidence: 0.2 },
    });
    const outcome = await handleChat(engine, parser, session, "my aunt cannot do stairs");
    expect(CONFIDENCE_GATE).toBe(0.5);
    expect(outcome.acted).toBe(false);
    expect(outcome.needsClarification).toBe(true);
    expect(outcome.replan).toBeNull();
    expect(outcome.state.ctx.accessNeeds).toEqual([]);
  });

  it("treats a question as a question", async () => {
    const { engine, session } = started();
    const parser = mockIntentParser({ far: { contextPatch: {}, reply: "It is 1.2 km away.", confidence: 0.9 } });
    const outcome = await handleChat(engine, parser, session, "is it far?");
    expect(outcome.reply).toBe("It is 1.2 km away.");
    expect(outcome.acted).toBe(false);
    expect(outcome.replan).toBeNull();
    expect(outcome.state).toBe(session.state);
  });

  it("refuses a decision that reaches outside the patch", async () => {
    const { engine, session } = started();
    const leaky = {
      async parseIntent() {
        return { reply: "here you go", confidence: 1, suggestions: [], contextPatch: {}, reordering: ["market"] };
      },
    };
    const outcome = await handleChat(engine, leaky, session, "reorder my plan");
    expect(outcome.acted).toBe(false);
    expect(outcome.replan).toBeNull();
    expect(session.state.ctx.partySize).toBe(2);
  });

  it("keeps the plan when the model is unreachable", async () => {
    const { engine, session } = started();
    const broken = {
      async parseIntent(): Promise<never> {
        throw new Error("rate limited");
      },
    };
    const outcome = await handleChat(engine, broken, session, "make it cheaper");
    expect(outcome.acted).toBe(false);
    expect(outcome.replan).toBeNull();
    expect(outcome.reply).toContain("nothing changed");
    expect(outcome.state.ctx.budget?.minor).toBe(150000);
  });

  it("maps every patch field the contract allows onto the editor", () => {
    const result = applyPatch(editor(), {
      availableMin: 90,
      budgetMinor: 60000,
      partySize: 4,
      accessNeeds: ["restroom"],
      interests: ["heritage"],
      avoid: ["crowded"],
      indoorOnly: true,
      mood: "low energy",
    });
    expect(result.change?.kind).toBe("time_shrank");
    expect(result.state.ctx.availableMin).toBe(90);
    expect(result.state.ctx.budget?.minor).toBe(60000);
    expect(result.state.ctx.partySize).toBe(4);
    // Lists union, scalars replace. `FEATURES.md` §4 writes them as `+=`.
    expect(result.state.ctx.accessNeeds).toEqual(["restroom"]);
    expect(result.state.ctx.interests).toEqual(["street_food", "local", "heritage"]);
    expect(result.state.ctx.avoid).toEqual(
      expect.arrayContaining(["crowded", "indoors_only", "mood_low_energy"]),
    );
    // The model can only move the context, and the result is still a valid one.
    expect(DiscoveryContext.safeParse(result.state.ctx).success).toBe(true);
  });

  it("leaves the plan alone when the patch is empty", async () => {
    const { engine, session } = started();
    const outcome = await handleChat(engine, mockIntentParser(), session, "hello there");
    expect(outcome.acted).toBe(false);
    expect(outcome.state).toBe(session.state);
    expect(outcome.suggestions.length).toBeGreaterThan(0);
  });
});
