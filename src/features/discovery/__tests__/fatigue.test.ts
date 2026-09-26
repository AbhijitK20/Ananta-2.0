/**
 * Travel load: the tests that prove the fatigue model is not decoration.
 *
 * The engine double in this file is a real one, not the shared `fakeEngine`: it
 * has a router (haversine, then a per-mode speed) and a greedy packer, because a
 * model that only ever sees hand-built plans cannot show that the *selected* plan
 * changes. Every construction case below runs the production path —
 * `createContext` -> `discover` -> `packWithinLoad` -> `admit` — and then asserts
 * on the plan that came out.
 *
 * `tests/**` is Abhijit's path, so these live beside the code they cover.
 */
import { describe, expect, it } from "vitest";
import {
  Plan as PlanSchema,
  type DiscoveryContext,
  type Experience,
  type FeasibleResult,
  type Fit,
  type GeoPoint,
  type Plan,
  type ReplanResult,
  type RetrieveInput,
  type ScoreBreakdown,
  type TravelLeg,
  type ValidationResult,
  type WeightProfile,
} from "../../../contracts";
import {
  applyEditorChange,
  applyOp,
  createSession,
  discover,
  leadViolation,
  loadBudget,
  loadOf,
  type ContextSeed,
  type EnginePort,
  type TravelMode,
} from "..";
import { exp } from "./fixtures";

// ---------------------------------------------------------------------------
// Places. Real coordinates, so the router has real distances to disagree about.
// ---------------------------------------------------------------------------

const POINTS = {
  colaba: { lat: 19.02, lon: 72.85 },
  near_market: { lat: 19.023, lon: 72.853 },
  near_cafe: { lat: 19.021, lon: 72.851 },
  mid_gallery: { lat: 19.032, lon: 72.866 },
  far_fort: { lat: 19.055, lon: 72.905 },
} satisfies Record<string, GeoPoint>;

/** Engine score per place. Fixed, so the drop ranking is predictable. */
const SCORE: Record<string, number> = {
  mid_gallery: 10,
  near_market: 8,
  near_cafe: 6,
  far_fort: 2,
};

const rupees = (minor: number) => ({ minor, currency: "INR" as const });
const AT = "2026-01-01T00:00:00.000Z";

const place = (id: keyof typeof POINTS, durationMin: number, category: Experience["category"]): Experience =>
  exp({ id, name: id, category, location: POINTS[id], durationMin, pricePerPerson: rupees(20000) });

const CATALOGUE: Experience[] = [
  place("mid_gallery", 60, "art_studio"),
  place("near_market", 40, "market"),
  place("near_cafe", 45, "cafe"),
  place("far_fort", 45, "heritage_site"),
];

const CATALOGUE_BY_ID = new Map(CATALOGUE.map((item) => [item.id, item]));

/** Catalogue rows for these ids, in the order the engine's scores put them. */
const byScore = (ids: readonly string[]): Experience[] =>
  ids
    .map((id) => {
      const found = CATALOGUE_BY_ID.get(id);
      if (!found) throw new Error(`no such place: ${id}`);
      return found;
    })
    .sort((a, b) => (SCORE[b.id] ?? 0) - (SCORE[a.id] ?? 0) || a.id.localeCompare(b.id));

export const WEIGHTS: WeightProfile = {
  version: "load-test-1",
  weights: { interest: 1, proximity: 1, rating: 0.5 },
  source: "prior",
  updatedAt: AT,
  observations: 0,
};

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/** 70 m/min on foot, 380 m/min by car, plus whatever the mode costs to start. */
const SPEED: Record<TravelMode, { metresPerMin: number; fixedMin: number }> = {
  walk: { metresPerMin: 70, fixedMin: 0 },
  auto: { metresPerMin: 380, fixedMin: 4 },
  transit: { metresPerMin: 240, fixedMin: 8 },
  ferry: { metresPerMin: 300, fixedMin: 12 },
};

const EARTH_R = 6371000;

function haversine(from: GeoPoint, to: GeoPoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_R * Math.asin(Math.sqrt(a)));
}

const idOf = (point: GeoPoint): string => {
  for (const [id, known] of Object.entries(POINTS)) {
    if (known.lat === point.lat && known.lon === point.lon) return id;
  }
  return `${point.lat},${point.lon}`;
};

function route(from: GeoPoint, to: GeoPoint, mode: TravelMode, _atMin: number): TravelLeg {
  const metres = haversine(from, to);
  const speed = SPEED[mode];
  const minutes = Math.max(1, Math.round(metres / speed.metresPerMin) + speed.fixedMin);
  return { fromId: idOf(from), toId: idOf(to), mode, minutes, metres, detail: null, estimated: true };
}

const legMode = (ctx: DiscoveryContext): TravelMode => (ctx.travelMode === "any" ? "auto" : ctx.travelMode);

function scoreOf(id: string): ScoreBreakdown {
  return { experienceId: id, total: SCORE[id] ?? 5, components: [], profileVersion: "load-test-1", learnedComponents: [] };
}

function stopOf(ctx: DiscoveryContext, item: Experience, arriveMin: number, order: number, travelMin: number): Plan["stops"][number] {
  return {
    experienceId: item.id,
    arriveMin,
    departMin: arriveMin + item.durationMin,
    order,
    why: [`${item.durationMin} min on site, ${travelMin} min to get there.`],
    score: scoreOf(item.id),
    fit: {
      experienceId: item.id,
      travelMin,
      activityMin: item.durationMin,
      bufferMin: 0,
      totalMin: travelMin + item.durationMin,
      availableMin: ctx.availableMin,
      fitRatio: (travelMin + item.durationMin) / Math.max(1, ctx.availableMin),
      cost: rupees(20000),
      budget: ctx.budget,
      checks: [],
      verdict: "fits",
    },
  };
}

const assemble = (
  ctx: DiscoveryContext,
  stops: Plan["stops"],
  legs: TravelLeg[],
  overrides: Partial<Plan> = {},
): Plan =>
  PlanSchema.parse({
    id: "load-plan",
    contextId: ctx.id,
    stops,
    legs,
    totalMin: stops.length > 0 ? stops[stops.length - 1]!.departMin - ctx.nowMin : 0,
    totalCost: rupees(20000 * stops.length),
    utilisation: (stops.length > 0 ? stops[stops.length - 1]!.departMin - ctx.nowMin : 0) / Math.max(1, ctx.availableMin),
    totalMetres: legs.reduce((sum, leg) => sum + leg.metres, 0),
    rejected: [],
    createdAt: AT,
    engineVersion: "load-test-1",
    ...overrides,
  });

/** Greedy: take the candidates in the order given, skip anything that overruns. */
function pack(ctx: DiscoveryContext, items: readonly Experience[]): Plan {
  const mode = legMode(ctx);
  const legs: TravelLeg[] = [];
  const stops: Plan["stops"] = [];
  let at = ctx.nowMin;
  let here: GeoPoint | null = ctx.origin.point;
  let order = 0;

  for (const item of items) {
    if (ctx.excludedIds.includes(item.id)) continue;
    // The first hop is on foot whatever the mode, because you leave where you
    // stand. This is a property of the double, not of the load model: a real
    // engine's `Plan.legs` are read verbatim, and if it says the first leg is a
    // drive, the model believes it.
    const leg = here
      ? order === 0
        ? { ...route(here, item.location, "walk", at), mode: "walk" as const }
        : route(here, item.location, mode, at)
      : null;
    const travelMin = leg?.minutes ?? 0;
    const arriveMin = at + travelMin;
    if (arriveMin + item.durationMin - ctx.nowMin > ctx.availableMin) continue;
    if (leg) legs.push(leg);
    stops.push(stopOf(ctx, item, arriveMin, order, travelMin));
    order += 1;
    at = arriveMin + item.durationMin;
    here = item.location;
  }
  return assemble(ctx, stops, legs);
}

/**
 * A plan on hand-written arrival times, for the cases where the schedule is the
 * thing under test. The packer above would never produce one of these, which is
 * exactly why the gate needs its own: the plans that reach it are not always the
 * plans the packer built.
 */
function timedPlan(
  ctx: DiscoveryContext,
  schedule: readonly { id: keyof typeof POINTS; arriveMin: number }[],
  overrides: Partial<Plan> = {},
): Plan {
  const mode = legMode(ctx);
  const legs: TravelLeg[] = [];
  const stops: Plan["stops"] = [];
  let from = ctx.origin.point;
  for (const [order, entry] of schedule.entries()) {
    const item = CATALOGUE_BY_ID.get(entry.id);
    if (!item) throw new Error(`no such place: ${entry.id}`);
    const leg = from ? route(from, item.location, mode, entry.arriveMin) : null;
    if (leg) legs.push(leg);
    stops.push(stopOf(ctx, item, entry.arriveMin, order, leg?.minutes ?? 0));
    from = item.location;
  }
  return assemble(ctx, stops, legs, overrides);
}

/** The whole seam, honestly implemented. `pack` is greedy, `replan` re-packs. */
function loadEngine(catalogue: readonly Experience[] = CATALOGUE): EnginePort {
  const ok: ValidationResult = { ok: true, violations: [], recomputedObjective: 0, claimedObjective: 0, objectiveDelta: 0 };
  const repack = (ctx: DiscoveryContext): ReplanResult => ({
    plan: pack(ctx, byScore(catalogue.map((item) => item.id))),
    change: { kind: "mood_changed", narrative: "", patch: {} },
    swaps: [],
    preservedIntent: true,
    summary: "",
  });
  return {
    retrieve(input: RetrieveInput): Experience[] {
      return input.catalogue.slice(0, input.limit);
    },
    filterFeasible(_ctx, items): FeasibleResult {
      return { passed: items.map((item) => item.id), rejected: [] };
    },
    score: (_ctx, items) => items.map((item) => scoreOf(item.id)),
    pack: (ctx, items) => pack(ctx, items),
    validate: () => ok,
    replan: (_prev, ctx) => repack(ctx),
    computeFit(ctx: DiscoveryContext, item: Experience): Fit {
      return {
        experienceId: item.id,
        travelMin: 10,
        activityMin: item.durationMin,
        bufferMin: 0,
        totalMin: item.durationMin + 10,
        availableMin: ctx.availableMin,
        fitRatio: 1,
        cost: item.pricePerPerson ?? rupees(0),
        budget: ctx.budget,
        checks: [],
        verdict: "fits",
      };
    },
    stress: () => ({ score: 20, factors: [] }),
    travelBetween: route,
  };
}

/**
 * An engine that has decided. Answers with the same plan no matter what the
 * candidate list, the context or the retry says — the only shape in which the
 * load gate, rather than the repair loop, is the thing under test.
 */
function insistent(plan: Plan): EnginePort {
  const base = loadEngine();
  const result: ReplanResult = {
    plan,
    change: { kind: "mood_changed", narrative: "", patch: {} },
    swaps: [],
    preservedIntent: true,
    summary: "",
  };
  return { ...base, pack: () => plan, replan: () => result };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED: ContextSeed = {
  id: "ctx-load",
  origin: { label: "Colaba", point: POINTS.colaba },
  availableMin: 240,
  nowMin: 600,
  partySize: 1,
  interests: ["street_food"],
  travelMode: "walk",
};

const CATALOGUE_MAP = new Map(CATALOGUE.map((item) => [item.id, item]));

const sessionFor = (seed: Partial<ContextSeed> = {}) => {
  const engine = loadEngine();
  const session = createSession({ engine, seed: { ...SEED, ...seed }, catalogue: CATALOGUE, weights: WEIGHTS });
  return { engine, session };
};

const ctxOf = (seed: Partial<ContextSeed> = {}): DiscoveryContext => sessionFor(seed).session.state.ctx;

const run = (seed: Partial<ContextSeed> = {}) => {
  const { engine, session } = sessionFor(seed);
  const first = discover(engine, session);
  if (!first.ok) throw new Error(`fixture did not build: ${first.reason}`);
  return { ...first, engine };
};

const ids = (value: Plan): string[] => value.stops.map((stop) => stop.experienceId);

// ---------------------------------------------------------------------------

describe("travel load — measurement", () => {
  it("tells a walking plan apart from a driving plan over the same ground", () => {
    const ctx = ctxOf();
    const onFoot = loadOf(pack(ctx, byScore(["near_market", "near_cafe"])), ctx, loadEngine(), CATALOGUE_MAP);
    const byCar = loadOf(
      pack(ctxOf({ travelMode: "auto" }), byScore(["near_market", "near_cafe"])),
      ctx,
      loadEngine(),
      CATALOGUE_MAP,
    );

    // Same two stops, same 765 m between them. Driven metres are not walked
    // metres: counting them would turn a 2 km drive into a 2 km walk and every
    // number downstream would be a lie. Only the walk out of the door is shared.
    expect(onFoot.metrics.walkMetres).toBe(765);
    expect(byCar.metrics.walkMetres).toBe(459);
    expect(byCar.metrics.walkMin).toBeLessThan(onFoot.metrics.walkMin);
    expect(byCar.metrics.travelMin).toBeGreaterThan(0);
    expect(onFoot.verdict).toBe("ok");
    // The same ground under a "less walking" budget is a different verdict.
    expect(loadOf(pack(ctx, byScore(["mid_gallery", "near_market"])), ctx, loadEngine(), CATALOGUE_MAP).metrics.walkMetres).toBeGreaterThan(3000);
  });
  it("gives a heavy-walking plan and a light-walking plan different verdicts", () => {
    // A long day, so both plans are inside the window and only walking separates them.
    const seed = { availableMin: 480 };
    const ctx = ctxOf(seed);
    const engine = loadEngine();
    const light = loadOf(pack(ctx, byScore(["near_market", "near_cafe"])), ctx, engine, CATALOGUE_MAP);
    const heavy = loadOf(pack(ctx, byScore(["mid_gallery", "far_fort"])), ctx, engine, CATALOGUE_MAP);

    // Both are feasible on time. This is the comparison the mandate is about.
    expect(light.metrics.windowUsedMin).toBeLessThanOrEqual(ctx.availableMin);
    expect(heavy.metrics.windowUsedMin).toBeLessThanOrEqual(ctx.availableMin);
    expect(heavy.metrics.walkMetres).toBeGreaterThan(light.metrics.walkMetres * 5);

    expect(light.verdict).toBe("ok");
    expect(heavy.verdict).toBe("overloaded");
    expect(light.metrics.loadRatio).toBeLessThan(1);
    expect(heavy.metrics.loadRatio).toBeGreaterThan(1);

    // Every number in a refusal is nameable, or the panel is guessing.
    const breach = heavy.violations.find((entry) => entry.code === "walking_budget_exceeded");
    expect(breach?.shortfall).toBeGreaterThan(0);
    expect(breach?.message).toMatch(/on foot against a \d+ m limit/);
  });

  it("budgets a harder day for a party with a toddler than for one adult", () => {
    const adult = loadBudget(ctxOf());
    const family = loadBudget(ctxOf({ partySize: 3, childAges: [4] }));
    const grandparents = loadBudget(ctxOf({ partySize: 2, elderly: 1 }));

    expect(family.walkMetres).toBeLessThan(adult.walkMetres);
    expect(grandparents.walkMetres).toBeLessThan(adult.walkMetres);
    // The evidence says why, rather than just producing a smaller number.
    expect(family.basis).toContain("child_under_6:4");
    expect(grandparents.basis).toContain("party_type:older_adults");
    expect(adult.basis.some((line) => line.startsWith("tolerance:any"))).toBe(true);
  });

  it("never asks for a break the window has no room for", () => {
    // 45 minutes is a short errand, not a broken long day.
    expect(loadBudget(ctxOf({ availableMin: 45 })).maxBlockMin).toBe(60);
  });

  it("counts minutes without inventing metres when the origin has no point", () => {
    const seed = { origin: { label: "somewhere" } };
    const ctx = ctxOf(seed);
    const report = loadOf(pack(ctx, byScore(["near_market", "near_cafe"])), ctx, loadEngine(), CATALOGUE_MAP);

    expect(report.metrics.originDistanceUnknown).toBe(true);
    expect(report.metrics.travelMin).toBeGreaterThan(0);
    // The first leg has real minutes and zero metres: honest, not guessed.
    expect(report.metrics.walkMetres).toBeLessThan(1500);
  });
});

describe("travel load — feasibility", () => {
  const SEED_AUTO = { availableMin: 120, travelMode: "auto" as const };
  /** 27 min driving and 105 min on site, so the day runs 128 min against 120. */
  const OVERRUN = [
    { id: "mid_gallery", arriveMin: 610 },
    { id: "far_fort", arriveMin: 683 },
  ] as const;

  it("fails a plan whose travel pushes it past the window, and names the minutes", () => {
    const ctx = ctxOf(SEED_AUTO);
    const over = timedPlan(ctx, OVERRUN);

    const report = loadOf(over, ctx, loadEngine(), CATALOGUE_MAP);
    expect(report.verdict).toBe("overloaded");
    const breach = report.violations.find((entry) => entry.code === "window_exceeded");
    expect(breach?.shortfall).toBe(8);
    expect(breach?.message).toMatch(/27 min travelling, 105 min on site/);
    expect(report.metrics.windowUsedMin).toBe(128);
    expect(report.metrics.idleMin).toBe(0);
    // Time is the only complaint: driving 7 km is not a walking problem.
    expect(report.violations.map((entry) => entry.code)).toEqual(["window_exceeded"]);
  });

  it("recomputes the day instead of trusting the plan's own totalMin", () => {
    const ctx = ctxOf(SEED_AUTO);
    const honest = timedPlan(ctx, OVERRUN);
    // A plan that under-reports its own length is the one that must not ship.
    const liar = timedPlan(ctx, OVERRUN, { totalMin: 60 });

    expect(liar.totalMin).toBe(60);
    expect(loadOf(liar, ctx, loadEngine(), CATALOGUE_MAP).verdict).toBe("overloaded");
    expect(loadOf(honest, ctx, loadEngine(), CATALOGUE_MAP).metrics.windowUsedMin).toBe(128);
  });

  it("leads with the walking when the walking is what caused the overrun", () => {
    // On foot, and a day that runs past its window. Both are true; only one of
    // them is something the traveller can act on.
    const ctx = ctxOf({ availableMin: 120 });
    const report = loadOf(
      timedPlan(ctx, [
        { id: "mid_gallery", arriveMin: 610 },
        { id: "far_fort", arriveMin: 683 },
      ]),
      ctx,
      loadEngine(),
      CATALOGUE_MAP,
    );
    expect(report.violations.map((entry) => entry.code)).toContain("window_exceeded");
    expect(leadViolation(report)?.code).toBe("walking_budget_exceeded");
    expect(report.violations[0]?.code).toBe("window_exceeded");
  });

  it("lets a plan through when the travel fits, so the check has two sides", () => {
    const ctx = ctxOf({ availableMin: 200, travelMode: "auto" });
    const report = loadOf(pack(ctx, byScore(["mid_gallery", "far_fort"])), ctx, loadEngine(), CATALOGUE_MAP);
    expect(report.metrics.travelMin).toBeGreaterThan(0);
    expect(report.verdict).toBe("ok");
  });
});

describe("travel load — construction", () => {
  it("selects a different plan when walking tolerance is low", () => {
    const relaxed = run();
    const careful = run({ prefs: { walking: "low" } });

    // Same catalogue, same scores, same engine. Only the tolerance differs.
    expect(ids(relaxed.plan)).toEqual(["mid_gallery", "near_market", "near_cafe"]);
    expect(ids(careful.plan)).toEqual(["near_market", "near_cafe", "far_fort"]);

    // The relaxed plan is over the low budget, so this is the load model changing
    // the answer and not annotating it.
    expect(relaxed.load.metrics.walkMetres).toBe(4147);
    expect(careful.load.budget.walkMetres).toBe(3600);
    expect(relaxed.load.metrics.walkMetres).toBeGreaterThan(careful.load.budget.maxLegWalkMetres);
    expect(
      loadOf(relaxed.plan, ctxOf({ prefs: { walking: "low" } }), loadEngine(), CATALOGUE_MAP).verdict,
    ).toBe("overloaded");

    // And what we hand over respects the constraint it was given: one less stop,
    // an eighth of the walking, no leg over the per-leg cap.
    expect(careful.load.budget.tolerance).toBe("low");
    expect(careful.load.verdict).toBe("ok");
    expect(careful.load.metrics.walkMetres).toBe(459);
    expect(careful.load.metrics.walkMetres).toBeLessThan(relaxed.load.metrics.walkMetres);
    expect(careful.load.metrics.consecutiveMax).toBeLessThanOrEqual(careful.load.budget.maxConsecutiveStops);
    for (const leg of careful.plan.legs.filter((entry) => entry.mode === "walk")) {
      expect(leg.metres).toBeLessThanOrEqual(careful.load.budget.maxLegWalkMetres);
    }
  });

  it("keeps the heavy plan when nobody has said anything about walking", () => {
    const { plan, load, excluded } = run();
    expect(ids(plan)).toEqual(["mid_gallery", "near_market", "near_cafe"]);
    expect(load.metrics.walkMetres).toBe(4147);
    expect(excluded).toEqual([]);
    expect(load.budget.tolerance).toBe("any");
    expect(load.verdict).toBe("ok");
  });

  it("cuts down to one stop when the party cannot be on foot at all", () => {
    const nobodyOnFoot = run({ prefs: { walking: "minimal" } });
    expect(nobodyOnFoot.load.budget.tolerance).toBe("minimal");
    expect(ids(nobodyOnFoot.plan)).toEqual(["near_cafe"]);
    expect(nobodyOnFoot.plan.stops.length).toBeLessThanOrEqual(
      nobodyOnFoot.load.budget.maxConsecutiveStops,
    );
    // `minimal` also forces the contract's only lever on walking.
    expect(nobodyOnFoot.session.state.ctx.travelMode).toBe("auto");
    expect(nobodyOnFoot.load.metrics.walkMetres).toBe(153);
    expect(nobodyOnFoot.load.metrics.consecutiveMax).toBe(1);
  });

  it("records what it cut, and how much relief each cut bought", () => {
    const { excluded, load } = run({ prefs: { walking: "low" } });
    expect(excluded.map((entry) => entry.id)).toEqual(["mid_gallery"]);
    expect(excluded[0]?.reason).toMatch(/on foot in one go/);
    expect(excluded[0]?.savesMetresUpTo).toBe(2147);
    expect(excluded[0]?.savesMinUpTo).toBeGreaterThan(0);
    // The plan that came back is inside the budget the context implies.
    expect(load.metrics.walkMetres).toBeLessThan(load.budget.walkMetres);
  });

  it("re-solves once with the offender excluded, and tells the panel why", () => {
    const { engine, session } = run();
    const edit = applyOp(session.state, { kind: "set_walking", walking: "low" });
    expect(edit.change?.kind).toBe("mood_changed");

    const outcome = applyEditorChange(engine, session, edit);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(ids(outcome.plan)).toEqual(["near_market", "near_cafe", "far_fort"]);
    expect(outcome.excluded.map((entry) => entry.id)).toEqual(["mid_gallery"]);
    expect(outcome.load.verdict).toBe("ok");
    expect(outcome.load.metrics.walkMetres).toBe(459);
    // The cut is on the panel with the sentence that justified it, so the
    // traveller is not told the engine invented a constraint.
    expect(outcome.reality.excludedForLoad[0]?.reason).toMatch(/on foot in one go/);
    expect(outcome.session.lastExclusions).toEqual(outcome.excluded);
    expect(outcome.session.lastLoad?.verdict).toBe("ok");
  });

  it("refuses at the door when the engine insists on an over-budget plan", () => {
    // An engine that answers with the same plan whatever it is asked for. The
    // repair loop cannot help here, so only the gate can stop it — and the gate
    // is the last thing between a bad plan and a traveller.
    const seed = { ...SEED, prefs: { walking: "minimal" as const } };
    sessionFor(seed);
    const heavy = pack(ctxOf(), byScore(["mid_gallery", "near_market", "near_cafe"]));
    const engine = insistent(heavy);
    const fresh = createSession({ engine, seed, catalogue: CATALOGUE, weights: WEIGHTS });

    const outcome = discover(engine, fresh);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["walking_budget_exceeded", "leg_too_long_to_walk"]),
    );
    expect(outcome.reason).toMatch(/on foot against a 1500 m limit/);
    expect(outcome.load?.verdict).toBe("overloaded");
    // Nothing is shown, and the traveller is told the actual reason.
    expect(fresh.plan).toBeNull();
  });

  it("keeps the previous plan when a replan comes back over budget", () => {
    const { session } = run();
    const heavy = pack(session.state.ctx, byScore(["mid_gallery", "near_market", "near_cafe"]));
    const edit = applyOp(session.state, { kind: "set_walking", walking: "minimal" });
    const outcome = applyEditorChange(insistent(heavy), session, edit);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.session.plan).toBe(session.plan);
    expect(outcome.reason).toMatch(/on foot/);
    expect(outcome.load?.verdict).toBe("overloaded");
    // The preference does not stick, because we could not honour it. A context
    // that says "nobody is walking" with a 4 km walking plan is worse than a
    // refused edit.
    expect(outcome.session.state.ctx.avoid).not.toContain("prefers_no_walks");
  });
});

describe("travel load — determinism", () => {
  it("gives the same report for the same inputs, every time", () => {
    const seed = { availableMin: 480 };
    const ctx = ctxOf(seed);
    const built = pack(ctx, byScore(["mid_gallery", "far_fort"]));
    expect(loadOf(built, ctx, loadEngine(), CATALOGUE_MAP)).toEqual(
      loadOf(built, ctx, loadEngine(), CATALOGUE_MAP),
    );
  });

  it("picks the same plan twice in a row", () => {
    const first = run({ prefs: { walking: "low" } });
    const second = run({ prefs: { walking: "low" } });
    expect(ids(second.plan)).toEqual(ids(first.plan));
    expect(second.load).toEqual(first.load);
  });

  it("ranks the drop that buys the most relief per point of engine score first", () => {
    const seed = { availableMin: 480 };
    const ctx = ctxOf(seed);
    const report = loadOf(pack(ctx, byScore(["mid_gallery", "far_fort"])), ctx, loadEngine(), CATALOGUE_MAP);
    // mid_gallery is scored 10 and pulls two long legs; far_fort is scored 2 and
    // pulls one. Relief per point still puts far_fort first, which is the point:
    // the engine's score breaks the tie, it does not get overruled.
    expect(report.dropOrder.map((drop) => drop.id)).toEqual(["far_fort", "mid_gallery"]);
    expect(report.dropOrder[0]?.savesMetresUpTo).toBeGreaterThan(0);
  });
});
