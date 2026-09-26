/**
 * End-to-end pipeline tests.
 *
 * These are the first tests that run the stages IN SEQUENCE. Until this file
 * existed, retrieve, feasibility, packer, validate and stress were each unit
 * tested in isolation and `pack()` was never called by any test at all — so two
 * whole classes of bug were invisible: a stage whose output did not satisfy the
 * next stage's input, and a Plan whose own totals did not add up.
 *
 * The load-bearing assertion is `validation.ok`. A pipeline that returns a Plan
 * and quietly gets the arithmetic wrong is worse than one that throws, because
 * the UI renders a confident feasibility meter over an itinerary that does not
 * add up. The Definition of Done asks for "100% constraint satisfaction on the
 * eval set, by construction" — that starts here.
 */
import { describe, expect, it } from "vitest";
import { DiscoveryContext, Experience } from "@/contracts";
import { fromMinor } from "@/lib/money";
import { planItinerary, type PlanResult } from "@/engine/plan";

/** A valid Experience built through zod, so defaults are the contract's. */
function exp(over: Partial<Experience> & Pick<Experience, "id" | "name">): Experience {
  return Experience.parse({
    category: "cafe",
    location: { lat: 19.0596, lon: 72.8296 },
    durationMin: 45,
    pricePerPerson: null,
    capacity: null,
    hours: { raw: null, status: "absent", lastVerified: null },
    indoorOutdoor: "indoor",
    accessibility: {
      stepFree: null,
      strollerOk: null,
      lowStairs: null,
      seatingAvailable: null,
      hearingLoop: null,
      restroomOnSite: null,
    },
    kidFriendly: null,
    minAge: null,
    diets: [],
    cuisines: [],
    rating: { value: 4.2, count: 120, rawMean: 4.2 },
    blurb: null,
    description: null,
    keywords: [],
    perception: { landscape: [], activities: [], atmosphere: [] },
    bestTimeOfDay: [],
    requiresJourney: false,
    booking: { required: false, leadTimeMin: 0, walkIn: true },
    bestMonths: [],
    weatherSensitive: "none",
    provenance: {},
    providerId: null,
    neighbourhood: "Colaba",
    city: "Mumbai",
    ...over,
  });
}

/** A small catalogue near the origin, all open and affordable. */
function catalogue(): Experience[] {
  return [
    exp({ id: "a", name: "Cafe A", keywords: ["coffee", "cafe"], durationMin: 40 }),
    exp({ id: "b", name: "Gallery B", category: "gallery", keywords: ["art", "gallery"], durationMin: 60 }),
    exp({ id: "c", name: "Market C", category: "market", keywords: ["market", "food"], durationMin: 50 }),
    exp({ id: "d", name: "Museum D", category: "museum", keywords: ["museum", "art"], durationMin: 90 }),
  ];
}

function ctx(over: Partial<DiscoveryContext> = {}): DiscoveryContext {
  const availableMin = over.availableMin ?? 240;
  return {
    id: "ctx-e2e",
    origin: { label: "Colaba", point: { lat: 19.0495, lon: 72.8320 } },
    availableMin,
    nowMin: 600,
    budget: fromMinor(200000),
    budgetPerPerson: null,
    partySize: 2,
    partyType: "couple",
    childAges: [],
    accessNeeds: [],
    diets: [],
    interests: ["art", "coffee"],
    avoid: [],
    weather: { condition: "clear", tempC: 28, source: "live" },
    travelMode: "walk",
    requests: [],
    excludedIds: [],
    pinnedIds: [],
    original: { availableMin, budget: fromMinor(200000), partySize: 2, accessNeeds: [] },
    ...over,
  } as DiscoveryContext;
}

describe("planItinerary (end to end)", () => {
  it("returns a Plan that passes its own validator", () => {
    // The load-bearing assertion. If the packer and the assembler ever disagree
    // about the arithmetic, this is where it shows.
    const r = planItinerary(ctx(), catalogue());
    expect(
      r.validation.ok,
      `pipeline produced an invalid plan: ${JSON.stringify(r.validation.violations, null, 2)}`,
    ).toBe(true);
  });

  it("actually packs stops", () => {
    // Proves pack() ran at all. Before the orchestrator, nothing called it.
    const r = planItinerary(ctx(), catalogue());
    expect(r.plan.stops.length).toBeGreaterThan(0);
    expect(r.counts.stops).toBe(r.plan.stops.length);
  });

  it("stays inside the traveller's window", () => {
    const r = planItinerary(ctx({ availableMin: 120 }), catalogue());
    expect(r.plan.totalMin).toBeLessThanOrEqual(120);
  });

  it("fills a generous window with more than one stop", () => {
    const r = planItinerary(ctx({ availableMin: 600 }), catalogue());
    expect(r.plan.stops.length).toBeGreaterThan(1);
  });

  it("reports utilisation as a real fraction of the window", () => {
    const r = planItinerary(ctx({ availableMin: 240 }), catalogue());
    const expected = r.plan.totalMin / 240;
    expect(r.plan.utilisation).toBeCloseTo(expected, 6);
  });

  it("orders stops 0..n-1 with no gaps", () => {
    const r = planItinerary(ctx(), catalogue());
    const orders = r.plan.stops.map((s) => s.order).sort((a, b) => a - b);
    expect(orders).toEqual(orders.map((_, i) => i));
  });

  it("fills in stressScore and stressFactors, which the assembler starts empty", () => {
    const r = planItinerary(ctx(), catalogue());
    expect(r.plan.stressScore).toBeGreaterThanOrEqual(0);
    expect(r.plan.stressScore).toBeLessThanOrEqual(100);
    expect(r.plan.stressFactors.length).toBe(7);
  });

  it("returns a valid EMPTY plan when the catalogue is empty", () => {
    // "Nothing fits what you asked for" is a product answer, not an error, and
    // it is the case the unmet-demand feed exists to capture.
    const r = planItinerary(ctx(), []);
    expect(r.plan.stops).toEqual([]);
    expect(r.validation.ok).toBe(true);
    expect(r.counts.retrieved).toBe(0);
  });

  it("is deterministic under a fixed seed", () => {
    const a = planItinerary(ctx(), catalogue(), { seed: 7 });
    const b = planItinerary(ctx(), catalogue(), { seed: 7 });
    expect(a.plan.stops.map((s) => s.experienceId)).toEqual(
      b.plan.stops.map((s) => s.experienceId),
    );
  });

  it("never mutates the caller's context or catalogue", () => {
    const c = ctx();
    const cat = catalogue();
    const ctxSnapshot = JSON.parse(JSON.stringify(c));
    const catSnapshot = JSON.parse(JSON.stringify(cat));
    planItinerary(c, cat);
    expect(c).toEqual(ctxSnapshot);
    expect(cat).toEqual(catSnapshot);
  });

  it("does not treat unsurveyed hours as closed", () => {
    // REGRESSION. `hours.raw: null` means nobody ever surveyed this place, which
    // is the normal state for an OSM long tail. `isOpenDuring` correctly reports
    // `{ open: false, unknown: true }` for that. `computeFit` used to fold it into
    // a hard `Open: pass=false`, and since `!checks.every(pass)` is what produces
    // `does_not_fit`, the packer silently dropped EVERY experience whose hours
    // nobody had checked. On a real catalogue that is most of it, and the failure
    // was invisible because the plan was simply empty.
    //
    // The file's own hoursDetail() comment already said collapsing "confidently
    // shut" and "we cannot tell" is "how a platform ends up telling a traveller
    // somewhere is closed when nobody ever knew its hours". This asserts it.
    const r = planItinerary(ctx(), catalogue());
    expect(r.plan.stops.length).toBeGreaterThan(0);
    // And the caveat is still surfaced rather than hidden.
    const open = r.plan.stops[0]?.fit.checks.find((c) => c.label === "Open");
    expect(open?.detail).toMatch(/unverified|could not/i);
  });

  it("still treats confidently-closed hours as a hard fail", () => {
    // The fix must not swing the other way and admit genuinely closed places.
    const shut = [
      exp({
        id: "closed",
        name: "Closed Place",
        hours: { raw: "Mo-Su 10:00-11:00", status: "ok", lastVerified: null },
        durationMin: 60,
      }),
    ];
    const r = planItinerary(ctx({ availableMin: 300, nowMin: 780 }), shut);
    // Either it is dropped (and the reason is a closed_now rejection) or it is
    // kept with an honest "closed" detail. What must never happen is it being
    // kept as if open.
    if (r.plan.stops.length > 0) {
      const open = r.plan.stops[0]?.fit.checks.find((c) => c.label === "Open");
      expect(open?.detail).toMatch(/closed|only/i);
    } else {
      expect(r.rejected.some((x) => x.code === "closed_during_window" || x.code === "closed_now")).toBe(true);
    }
  });

  it("surfaces gate rejections rather than swallowing them", () => {
    // Every hard-constraint drop must be visible to the "why not that" panel.
    const impossible = ctx({
      accessNeeds: ["wheelchair"],
      interests: ["art"],
    });
    const r = planItinerary(impossible, catalogue());
    // Either something survives, or what died is explained. Both are honest; a
    // silent drop is not.
    if (r.plan.stops.length === 0) {
      expect(r.rejected.length).toBeGreaterThan(0);
      for (const rej of r.rejected) {
        expect(rej.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("respects an exclusion list", () => {
    const r = planItinerary(ctx({ excludedIds: ["a"] }), catalogue());
    expect(r.plan.stops.some((s) => s.experienceId === "a")).toBe(false);
  });

  it("does not duplicate a stop", () => {
    const r = planItinerary(ctx(), catalogue());
    const ids = r.plan.stops.map((s) => s.experienceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects the whole plan when every candidate is excluded", () => {
    const r = planItinerary(ctx({ excludedIds: ["a", "b", "c", "d"] }), catalogue());
    expect(r.plan.stops).toEqual([]);
    expect(r.validation.ok).toBe(true);
  });

  it("produces a Plan whose engineVersion and createdAt are set", () => {
    const r = planItinerary(ctx(), catalogue());
    expect(r.plan.engineVersion).toMatch(/packer\//);
    // createdAt must be a real ISO datetime, not the epoch sentinel leaking out.
    expect(r.plan.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is not affected by the time of day it is run", () => {
    // The engine is date-agnostic by contract. A fixed nowMin must give a fixed
    // result, or the eval numbers are meaningless.
    const morning = planItinerary(ctx({ nowMin: 480 }), catalogue(), { seed: 3 });
    const evening = planItinerary(ctx({ nowMin: 1080 }), catalogue(), { seed: 3 });
    expect(morning.plan.stops.map((s) => s.experienceId)).toEqual(
      evening.plan.stops.map((s) => s.experienceId),
    );
  });
});

/** Re-exported so the eval harness can name the shape without importing internals. */
export type { PlanResult };
