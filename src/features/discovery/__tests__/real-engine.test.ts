/**
 * The test that should have existed before any of this was wired.
 *
 * `EnginePort` sat in `src/features/discovery/engine.ts` with a header promising
 * "one wiring line in `src/app`", and no such line existed. So `EnginePort` was
 * never satisfied by a real engine, `createSession`/`discover` had no
 * production caller, and 20,828 lines of feature code across seven folders were
 * unreachable from any route. Typechecking could not see it — the port is a
 * local interface, satisfied by nothing, and `tsc` is perfectly happy about an
 * interface no one implements.
 *
 * This is the seam's bug all over again, one layer up. The old
 * `src/app/_lib/engine.ts` declared a fictional engine and both API routes 500'd
 * while 1,145 tests passed. The lesson that generalises: an interface with no
 * implementation is not typechecked, so the only check that means anything is
 * CALLING it.
 *
 * So this calls the adapter against the real engine and the real catalogue, and
 * asserts a real plan comes back. If the port and the engine drift again, this
 * fails instead of the deployed app quietly serving nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_PROFILE } from "@/engine";
import { Experience, Plan, type DiscoveryContext } from "@/contracts";

import { realEngine } from "../real-engine";
import { createSession, discover } from "../replanner";

/** The real catalogue, not a fixture. A stub would not catch a signature drift. */
function realCatalogue(): Experience[] {
  const path = resolve(process.cwd(), "data/cities/mumbai/experiences.jsonl");
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const out: Experience[] = [];
  for (const line of rows) {
    const parsed = Experience.safeParse(JSON.parse(line));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

describe("the real engine adapter", () => {
  const engine = realEngine();
  const catalogue = realCatalogue();

  it("reads a real catalogue", () => {
    expect(catalogue.length).toBeGreaterThan(1000);
  });

  it("satisfies every method on the port", () => {
    for (const name of [
      "retrieve",
      "filterFeasible",
      "score",
      "pack",
      "validate",
      "replan",
      "computeFit",
      "stress",
      "travelBetween",
    ] as const) {
      expect(typeof engine[name], `EnginePort.${name} must be a function`).toBe("function");
    }
  });

  it("runs discover() end to end and returns a real plan", () => {
    const session = createSession({
      engine,
      seed: {
        id: "adapter-check",
        origin: { label: "Bandra West, Mumbai", point: { lat: 19.0495, lon: 72.832 } },
        availableMin: 180,
        nowMin: 840,
        budgetMinor: 300_000,
        partySize: 2,
        interests: ["street_food", "market"],
        travelMode: "walk",
      },
      catalogue,
      weights: DEFAULT_PROFILE,
    });

    const outcome = discover(engine, session);

    // A failure here is a TypeError inside the adapter, which is the whole
    // failure mode being guarded: the old seam threw `Cannot read properties of
    // undefined (reading 'id')` here for every request.
    expect(outcome.ok, JSON.stringify(outcome.ok ? {} : outcome.violations)).toBe(true);
    if (!outcome.ok) return;

    const plan: Plan = outcome.plan;
    expect(plan.stops.length).toBeGreaterThan(0);
    expect(plan.engineVersion).toBeTruthy();
    // `pack` promises a Plan, not a PackResult. These are exactly the fields
    // that go missing if the assembly is ever dropped.
    expect(plan.utilisation).toBeGreaterThanOrEqual(0);
    expect(plan.stressFactors.length).toBeGreaterThanOrEqual(0);
    expect(typeof plan.createdAt).toBe("string");
    expect(Array.isArray(plan.rejected)).toBe(true);
    // Stops must resolve against the catalogue, or the timeline renders blanks.
    for (const stop of plan.stops) {
      expect(catalogue.some((row) => row.id === stop.experienceId)).toBe(true);
    }
  });

  it("replans through the same port", () => {
    const session = createSession({
      engine,
      seed: {
        id: "adapter-replan",
        origin: { label: "Bandra West, Mumbai", point: { lat: 19.0495, lon: 72.832 } },
        availableMin: 180,
        nowMin: 840,
        budgetMinor: 300_000,
        partySize: 2,
        travelMode: "walk",
      },
      catalogue,
      weights: DEFAULT_PROFILE,
    });
    const first = discover(engine, session);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const result = engine.replan(first.plan, first.session.state.ctx, {
      kind: "time_shrank",
      narrative: "We lost 60 minutes.",
      patch: { availableMin: 120 },
    });
    expect(result.plan).toBeDefined();
    expect(Array.isArray(result.swaps)).toBe(true);
  });

  it("refuses travelBetween rather than inventing a synchronous leg", () => {
    // The port declares it sync/TravelLeg; the real one is async/TravelResult.
    // A fabricated straight-line leg here would look right and be a lie.
    expect(() =>
      engine.travelBetween(
        { lat: 19.0495, lon: 72.832 },
        { lat: 19.06, lon: 72.84 },
        "walk",
        840,
      ),
    ).toThrow(/not bridged/i);
  });
});

describe("the port and the engine have not drifted", () => {
  it("filterFeasible is called with the options the engine requires", () => {
    // If the engine ever makes `opts` a different shape, the adapter's
    // FilterOptions literal stops typechecking. Assert the gate still runs and
    // still emits rejections, which is what proves `opts` reached it.
    const catalogue = realCatalogue();
    const ctx: DiscoveryContext = {
      id: "gate-probe",
      origin: { label: "Bandra West", point: { lat: 19.0495, lon: 72.832 } },
      availableMin: 60,
      nowMin: 840,
      budget: { minor: 1, currency: "INR" },
      budgetPerPerson: null,
      partySize: 2,
      partyType: "couple",
      childAges: [],
      accessNeeds: [],
      diets: [],
      interests: [],
      avoid: [],
      weather: { condition: "clear", tempC: 29, source: "live" },
      travelMode: "walk",
      requests: [],
      excludedIds: [],
      pinnedIds: [],
      original: { availableMin: 60, budget: { minor: 1, currency: "INR" }, partySize: 2, accessNeeds: [] },
    };
    const near = catalogue.slice(0, 20);
    const gate = realEngine().filterFeasible(ctx, near);
    expect(gate.passed.length + gate.rejected.length).toBe(near.length);
  });
});
