/**
 * Opportunity generation, provider matching, and the honesty rules.
 *
 * The tests that matter here are the negative ones: a rejection that is not a
 * provider's fault to fix, a provider who already offers the thing, a provider
 * who is too far away, and a cell too thin to act on. A feature that only proves
 * it can produce opportunities is not tested.
 */
import { describe, expect, it } from "vitest";
import type { Experience, Provider, RejectionCode, UnmetDemand } from "../../contracts";
import {
  MIN_SAMPLE,
  buildCells,
  distanceKm,
} from "./aggregate";
import { AS_OF, createDemoSource } from "./demo-data";
import {
  MAX_SUGGESTIONS,
  MIN_CELL_FOR_OPPORTUNITY,
  NEVER_AN_OPPORTUNITY,
  buildOpportunities,
  buildProviderSuggestions,
  fixFor,
  opportunitiesFor,
} from "./opportunities";
import { parseAnalyticsSource } from "./adapter";
import type { AnalyticsSource } from "./types";

const FORT = { lat: 18.9355, lon: 72.8355 };
const COLABA = { lat: 18.9067, lon: 72.8147 };

function demand(over: Partial<UnmetDemand> = {}): UnmetDemand {
  return {
    id: "ud-test",
    travellerId: "t01",
    point: FORT,
    neighbourhood: "Fort",
    at: "2026-09-20T12:00:00.000Z",
    constraints: {
      availableMin: 120,
      budgetMinor: 50000,
      partySize: 2,
      accessNeeds: [],
      interests: ["craft_workshop"],
      weather: "clear",
    },
    shortfallCount: 0,
    topBlockingCode: "not_step_free",
    topBlockingCount: 4,
    ...over,
  };
}

function repeat(n: number, over: Partial<UnmetDemand> = {}): UnmetDemand[] {
  return Array.from({ length: n }, (_, i) => demand({ id: `ud-${i}`, ...over }));
}

function provider(over: Partial<Provider> = {}): Provider {
  return {
    id: "prov-test",
    name: "Test Studio",
    kind: "craft studio",
    bio: null,
    neighbourhood: "Fort",
    city: "Mumbai",
    contact: { email: null, phone: null },
    reliability: 0.5,
    verified: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function experience(over: Partial<Experience> = {}): Experience {
  const base = createDemoSource().listings[0]!;
  return {
    ...base,
    id: "exp-test",
    name: "Test workshop",
    providerId: "prov-test",
    neighbourhood: "Fort",
    location: FORT,
    ...over,
  };
}

function cellsFor(rows: UnmetDemand[]) {
  return buildCells(rows, { asOf: AS_OF });
}

describe("fixFor", () => {
  it("points a supply-gap code at a field on the listing", () => {
    expect(fixFor("not_step_free")?.field).toBe("accessibility.stepFree");
    expect(fixFor("over_budget")?.field).toBe("pricePerPerson");
    expect(fixFor("weather_unsafe")?.field).toBe("indoorOutdoor");
  });

  it("has no fix for a code that is not a supply gap", () => {
    for (const code of NEVER_AN_OPPORTUNITY) expect(fixFor(code)).toBeNull();
    expect(NEVER_AN_OPPORTUNITY.has("too_far")).toBe(true);
    expect(NEVER_AN_OPPORTUNITY.has("excluded_by_traveller")).toBe(true);
  });

  it("treats a null accessibility field as unknown, not as false", () => {
    const fix = fixFor("not_step_free")!;
    expect(fix.state(experience({ accessibility: { ...experience().accessibility, stepFree: null } }), cellsFor(repeat(6))[0]!)).toBe("unknown");
    expect(fix.state(experience({ accessibility: { ...experience().accessibility, stepFree: false } }), cellsFor(repeat(6))[0]!)).toBe("absent");
    expect(fix.state(experience({ accessibility: { ...experience().accessibility, stepFree: true } }), cellsFor(repeat(6))[0]!)).toBe("offered");
  });
});

describe("buildOpportunities", () => {
  it("turns a demand cell into an opportunity with the contract payload attached", () => {
    const source = createDemoSource();
    const opportunities = buildOpportunities(
      cellsFor(source.unmetDemand),
      source.listings,
      source.providers,
      { datasetLabel: source.dataset.label },
    );
    const opp = opportunitiesFor(opportunities, "prov-nila").find((o) => o.missingSupply.field === "accessibility.stepFree")!;
    expect(opp.contract.providerId).toBe("prov-nila");
    expect(opp.contract.estimatedImpact).toBeNull();
    expect(opp.contract.evidence.length).toBeGreaterThan(4);
    expect(opp.sampleSize).toBeGreaterThanOrEqual(MIN_SAMPLE);
    expect(opp.contract.headline).toContain("Fort");
    expect(opp.contract.headline).toMatch(/\d+ searches/);
    expect(opp.cta.length).toBeGreaterThan(10);
  });

  it("gives every evidence line a value, because a claim without a count is copy", () => {
    const source = createDemoSource();
    for (const opp of buildOpportunities(cellsFor(source.unmetDemand), source.listings, source.providers)) {
      for (const e of opp.evidence) expect(e.value.length).toBeGreaterThan(0);
      expect(opp.evidence).toEqual(opp.contract.evidence);
    }
  });

  it("never suggests something the provider already offers", () => {
    const rows = repeat(MIN_SAMPLE, { topBlockingCode: "not_step_free" });
    const cells = cellsFor(rows);
    const offered = experience({
      accessibility: { ...experience().accessibility, stepFree: true },
    });
    const missing = buildOpportunities(cells, [offered], [provider()]);
    expect(missing).toHaveLength(0);
  });

  it("does not offer a listing that is already indoors for an indoor demand gap", () => {
    const rows = repeat(MIN_SAMPLE, { topBlockingCode: "weather_unsafe" });
    const cells = cellsFor(rows);
    const indoor = experience({ indoorOutdoor: "indoor" });
    expect(buildOpportunities(cells, [indoor], [provider()])).toHaveLength(0);
    const outdoor = experience({ indoorOutdoor: "outdoor" });
    expect(buildOpportunities(cells, [outdoor], [provider()])).toHaveLength(1);
  });

  it("refuses to match a provider outside the radius", () => {
    const rows = repeat(MIN_SAMPLE);
    const cells = cellsFor(rows);
    const far = experience({ location: COLABA, neighbourhood: "Colaba" });
    expect(buildOpportunities(cells, [far], [provider()])).toHaveLength(0);
    expect(distanceKm(FORT, COLABA)).toBeGreaterThan(2);
  });

  it("refuses to match a provider in the wrong trade", () => {
    const rows = repeat(MIN_SAMPLE);
    const wrongTrade = experience({ category: "nightlife" });
    expect(buildOpportunities(cellsFor(rows), [wrongTrade], [provider()])).toHaveLength(0);
  });

  it("turns nothing into an opportunity when the code is not fixable", () => {
    for (const code of NEVER_AN_OPPORTUNITY) {
      const rows = repeat(MIN_SAMPLE + 2, { topBlockingCode: code });
      expect(buildOpportunities(cellsFor(rows), [experience()], [provider()])).toHaveLength(0);
    }
  });

  it("shows a thin cell but badges it inferred, and hides it below the floor", () => {
    const thin = repeat(MIN_SAMPLE - 1);
    const [opp] = buildOpportunities(cellsFor(thin), [experience()], [provider()]);
    expect(opp!.tier).toBe("inferred");
    expect(opp!.sampleSize).toBe(MIN_SAMPLE - 1);

    const noise = repeat(MIN_CELL_FOR_OPPORTUNITY - 1);
    expect(buildOpportunities(cellsFor(noise), [experience()], [provider()])).toHaveLength(0);
  });

  it("orders by sample size, then id, and is stable under input reversal", () => {
    const source = createDemoSource();
    const cells = cellsFor(source.unmetDemand);
    const forward = buildOpportunities(cells, source.listings, source.providers);
    const backward = buildOpportunities([...cells].reverse(), [...source.listings].reverse(), source.providers);
    expect(forward.map((o) => o.id)).toEqual(backward.map((o) => o.id));
    const sizes = forward.map((o) => o.sampleSize);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it("returns nothing at all for no demand", () => {
    expect(buildOpportunities([], [experience()], [provider()])).toEqual([]);
  });

  it("counts the competition, so \"you are the only one here\" is checkable", () => {
    const source = createDemoSource();
    const opportunities = buildOpportunities(cellsFor(source.unmetDemand), source.listings, source.providers);
    const solo = opportunities.find((o) => o.missingSupply.field === "accessibility.stepFree")!;
    expect(solo.nearbyMatches).toBe(0);
    expect(solo.evidence.some((e) => e.label.includes("listings within") && e.value === "none other than yours")).toBe(true);
  });
});

describe("buildProviderSuggestions", () => {
  it("gives at least three actionable suggestions for every demo provider", () => {
    const source = createDemoSource();
    for (const p of source.providers) {
      const suggestions = buildProviderSuggestions(p, source.listings, cellsFor(source.unmetDemand), {
        datasetLabel: source.dataset.label,
      });
      expect(suggestions.length, `${p.id} needs three suggestions`).toBeGreaterThanOrEqual(3);
      expect(suggestions.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    }
  });

  it("covers the kinds a provider can act on", () => {
    const source = createDemoSource();
    const kinds = new Set(
      source.providers.flatMap((p) =>
        buildProviderSuggestions(p, source.listings, cellsFor(source.unmetDemand)).map((s) => s.kind),
      ),
    );
    for (const expected of [
      "accessibility_metadata",
      "accessibility_attribute",
      "availability_window",
      "family_package",
      "price_band",
      "indoor_option",
      "shorter_duration",
      "capacity",
    ]) {
      expect(kinds.has(expected as never), `expected a ${expected} suggestion`).toBe(true);
    }
  });

  it("backs every suggestion with a count and a field to edit", () => {
    const source = createDemoSource();
    for (const p of source.providers) {
      for (const s of buildProviderSuggestions(p, source.listings, cellsFor(source.unmetDemand))) {
        expect(s.sampleSize).toBeGreaterThanOrEqual(MIN_SAMPLE);
        expect(s.blockedCandidates).toBeGreaterThan(0);
        expect(s.targetField.length).toBeGreaterThan(0);
        expect(s.action).toMatch(/[.!]$/);
        expect(s.evidence.every((e) => e.value.length > 0)).toBe(true);
      }
    }
  });

  it("distinguishes \"never confirmed\" from \"confirmed absent\"", () => {
    const source = createDemoSource();
    const nila = source.providers.find((p) => p.id === "prov-nila")!;
    const suggestions = buildProviderSuggestions(nila, source.listings, cellsFor(source.unmetDemand));
    const unknown = suggestions.find((s) => s.kind === "accessibility_metadata")!;
    expect(unknown.action).toContain("Confirm");
    expect(unknown.cta).toContain("Confirm step-free access at");

    const mehfil = source.providers.find((p) => p.id === "prov-mehfil")!;
    const absent = buildProviderSuggestions(mehfil, source.listings, cellsFor(source.unmetDemand)).find(
      (s) => s.kind === "accessibility_attribute",
    )!;
    expect(absent.action).toContain("Add");
    expect(absent.cta).toContain("Add");
  });

  it("stays silent when a cell is too thin to justify a change", () => {
    const thin = repeat(MIN_SAMPLE - 1, { topBlockingCode: "not_step_free" });
    const suggestions = buildProviderSuggestions(provider(), [experience()], cellsFor(thin));
    expect(suggestions).toEqual([]);
  });

  it("stays silent when the provider already offers everything asked for", () => {
    const source = createDemoSource();
    const nila = source.providers.find((p) => p.id === "prov-nila")!;
    const fixed = source.listings.map((l) =>
      l.providerId === nila.id
        ? {
            ...l,
            accessibility: { stepFree: true, strollerOk: true, lowStairs: true, seatingAvailable: true, hearingLoop: true, restroomOnSite: true },
            kidFriendly: true,
            capacity: null,
            durationMin: 30,
            pricePerPerson: { minor: 30000, currency: "INR" as const },
            bestTimeOfDay: ["early_morning", "morning", "afternoon", "evening", "night"] as Experience["bestTimeOfDay"],
            indoorOutdoor: "mixed" as const,
          }
        : l,
    );
    const suggestions = buildProviderSuggestions(nila, fixed, cellsFor(source.unmetDemand));
    expect(suggestions).toEqual([]);
  });

  it("returns nothing for a provider with no listings", () => {
    const source = createDemoSource();
    expect(buildProviderSuggestions(provider({ id: "prov-ghost" }), source.listings, cellsFor(source.unmetDemand))).toEqual([]);
  });

  it("orders by sample size then id, and is stable under input reversal", () => {
    const source = createDemoSource();
    const p = source.providers[0]!;
    const forward = buildProviderSuggestions(p, source.listings, cellsFor(source.unmetDemand));
    const backward = buildProviderSuggestions(p, [...source.listings].reverse(), [...cellsFor(source.unmetDemand)].reverse());
    expect(forward.map((s) => s.id)).toEqual(backward.map((s) => s.id));
  });
});

describe("demo data integrity", () => {
  const source: AnalyticsSource = createDemoSource();

  it("parses against the contracts", () => {
    expect(parseAnalyticsSource(source)).toBeTruthy();
  });

  it("rejects a malformed source rather than rendering NaN percentages", () => {
    const broken = { ...source, providers: [{ id: "p", name: "x" }] };
    expect(() => parseAnalyticsSource(broken)).toThrow();
  });

  it("only blocks on codes the contract defines", () => {
    const codes = new Set<RejectionCode>(source.unmetDemand.map((d) => d.topBlockingCode));
    for (const code of codes) expect(fixFor(code) !== null || NEVER_AN_OPPORTUNITY.has(code)).toBe(true);
  });
});
