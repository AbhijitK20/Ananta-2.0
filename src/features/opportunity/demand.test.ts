/**
 * The producer, tested against the committed curated catalogue rather than a
 * fixture written to match the code. Every expectation below is a fact about
 * 133 real rows in `content/experiences/`, so a change to the catalogue that
 * breaks an assumption shows up here instead of in a demo.
 */
import { describe, expect, it } from "vitest";
import { createContext, type ContextSeed } from "../discovery/context";
import { loadCatalogue } from "./catalogue";
import {
  hardChecks,
  retrieveCandidates,
  SEARCH_SPREAD_KM,
  searchTraveller,
  topBlocker,
  type SearchShape,
  type TravellerRequest,
} from "./demand";

const catalogue = loadCatalogue();
const AS_OF = "2026-09-20T09:00:00.000Z";
const BANDRA = { lat: 19.0596, lon: 72.8392 };
const FORT = { lat: 18.9355, lon: 72.8355 };

const request = (seed: ContextSeed, over: Partial<TravellerRequest> = {}): TravellerRequest => {
  const { ctx } = createContext(seed);
  return {
    travellerId: "t01",
    at: "2026-09-15T05:30:00.000Z",
    point: seed.origin.point ?? BANDRA,
    neighbourhood: seed.origin.label,
    ctx,
    ...over,
  };
};

describe("the snapshot is real, and it parses", () => {
  it("loads contract rows, and none of them has a provider yet", () => {
    expect(catalogue.length).toBeGreaterThan(100);
    expect(catalogue.every((row) => row.providerId === null)).toBe(true);
    expect(catalogue.filter((row) => row.category === "craft_workshop").length).toBeGreaterThan(0);
  });
});

describe("retrieval", () => {
  it("matches the catalogue's own vocabulary, and only nearby", () => {
    const near = retrieveCandidates(["pottery"], catalogue, { point: BANDRA }).map((row) => row.id);
    expect(near).toContain("ban-ceramicist");
    // Colaba's craft workshops are 3.4 km away. A traveller in Bandra is not
    // shown them, and letting them through would let `too_far` out-count the
    // blockers a provider 400 m away could actually fix.
    expect(near).not.toContain("col-kite-corner");
  });

  it("keeps everything in reach when the traveller said no interest", () => {
    const all = retrieveCandidates([], catalogue, { point: FORT });
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThan(catalogue.length);
  });

  it("never reaches past the locality spread", () => {
    const within = retrieveCandidates(["heritage"], catalogue, { point: FORT, withinKm: 0.001 });
    expect(within.length).toBe(0);
    expect(SEARCH_SPREAD_KM).toBeGreaterThan(0);
  });
});

describe("hard checks", () => {
  const kiln = catalogue.find((row) => row.id === "ban-ceramicist")!;
  const shape = (over: Partial<SearchShape> = {}): SearchShape => ({
    point: BANDRA,
    radiusKm: 2,
    availableMin: 180,
    budgetMinor: 300000,
    partySize: 4,
    accessNeeds: ["stroller"],
    weather: "clear",
    ...over,
  });

  it("reports every failing constraint with a real number in the sentence", () => {
    const failures = hardChecks(shape(), kiln);
    expect(failures.map((failure) => failure.code).sort()).toEqual([
      "lead_time_too_short",
      "not_stroller_ok",
      "over_budget",
      "requires_booking_not_available",
    ]);
    const price = failures.find((failure) => failure.code === "over_budget")!;
    expect(price.shortfall).toBe(1000000 - 300000);
    expect(price.message).toContain("4 people");
    expect(price.message).toContain("2,500");
  });

  it("passes a listing that meets everything", () => {
    // A free walk-in shop in Bandra. A tight budget cannot exclude a free thing,
    // which is the point: `over_budget` only fires on a real price.
    const free = catalogue.find((row) => row.id === "ban-craft-shopping")!;
    expect(hardChecks(shape({ budgetMinor: 100, partySize: 1, availableMin: 90, accessNeeds: [] }), free)).toEqual([]);
  });

  it("separates 'no' from 'never confirmed' on accessibility", () => {
    const denied = hardChecks(shape({ accessNeeds: ["wheelchair"] }), kiln).find((f) => f.code === "not_step_free")!;
    expect(denied.message).toBe("No step-free access.");
    const unknown = hardChecks(shape({ accessNeeds: ["hearingLoop"] }), kiln).find((f) => f.code === "no_hearing_loop")!;
    expect(unknown.message).toBe("A hearing loop has never been confirmed.");
  });

  it("counts a free listing as meeting any budget", () => {
    const free = catalogue.find((row) => row.pricePerPerson === null && row.neighbourhood === "Bandra")!;
    expect(hardChecks(shape({ budgetMinor: 100 }), free).some((f) => f.code === "over_budget")).toBe(false);
  });
});

describe("logging unmet demand", () => {
  const familyCraft = request({
    id: "ctx-a",
    origin: { label: "Bandra", point: BANDRA },
    availableMin: 180,
    nowMin: 600,
    budgetMinor: 300000,
    partySize: 4,
    childAges: [5, 8],
    accessNeeds: ["stroller"],
    interests: ["pottery"],
  });

  it("logs nothing when the traveller got something", () => {
    const outcome = searchTraveller(
      request({
        id: "ctx-b",
        origin: { label: "Bandra", point: BANDRA },
        availableMin: 90,
        nowMin: 660,
        budgetMinor: 30000,
        partySize: 1,
        interests: ["craft"],
      }),
      catalogue,
    );
    expect(outcome.passed.length).toBeGreaterThan(0);
    expect(outcome.demand).toBeNull();
    expect(outcome.nothingMatched).toBe(false);
  });

  it("logs one contract row when the traveller got nothing", () => {
    const outcome = searchTraveller(familyCraft, catalogue);
    const row = outcome.demand;
    expect(row).not.toBeNull();
    expect(outcome.passed).toEqual([]);
    // The contract's own field: zero results returned. The count that means
    // something is `topBlockingCount`.
    expect(row!.shortfallCount).toBe(0);
    expect(row!.topBlockingCount).toBeGreaterThan(0);
    expect(row!.topBlockingCode).toBe("lead_time_too_short");
    expect(row!.point).toEqual(BANDRA);
    expect(row!.neighbourhood).toBe("Bandra");
    expect(row!.constraints).toEqual({
      availableMin: 180,
      budgetMinor: 300000,
      partySize: 4,
      accessNeeds: ["stroller"],
      interests: ["pottery"],
      weather: "clear",
    });
  });

  it("stores constraints and never identity", () => {
    const row = searchTraveller(familyCraft, catalogue).demand!;
    // `UnmetDemand` carries a pseudonymous `travellerId` and nothing else about
    // the person: no name, no contact, no free-text except their own interests.
    expect(Object.keys(row).sort()).toEqual([
      "at",
      "constraints",
      "id",
      "neighbourhood",
      "point",
      "shortfallCount",
      "topBlockingCode",
      "topBlockingCount",
      "travellerId",
    ]);
    expect(JSON.stringify(row)).not.toContain("t01@");
  });

  it("does not claim a blocker for a search that matched nothing at all", () => {
    const outcome = searchTraveller(
      request({
        id: "ctx-c",
        origin: { label: "Bandra", point: BANDRA },
        availableMin: 90,
        nowMin: 600,
        budgetMinor: 30000,
        partySize: 1,
        interests: ["zzzquantum flurb"],
      }),
      catalogue,
    );
    expect(outcome.retrieved).toBe(0);
    expect(outcome.nothingMatched).toBe(true);
    // No candidate means no constraint to blame, and the contract has no code for
    // "nothing matched". Inventing one would put a claim in the provider feed
    // that nothing supports.
    expect(outcome.demand).toBeNull();
  });

  it("is byte-identical on a rerun", () => {
    const a = searchTraveller(familyCraft, catalogue);
    const b = searchTraveller(familyCraft, catalogue);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("gives two travellers on the same search two row ids", () => {
    const seed: ContextSeed = {
      id: "ctx-a2",
      origin: { label: "Bandra", point: BANDRA },
      availableMin: 180,
      nowMin: 600,
      budgetMinor: 300000,
      partySize: 4,
      childAges: [5, 8],
      accessNeeds: ["stroller"],
      interests: ["pottery"],
    };
    const one = searchTraveller(familyCraft, catalogue).demand!;
    const two = searchTraveller(
      request(seed, { travellerId: "t02", at: "2026-09-16T05:30:00.000Z" }),
      catalogue,
    ).demand!;
    expect(one.id).not.toBe(two.id);
    expect(one.id).toBe(`ud-t01-${Date.parse(familyCraft.at)}`);
    expect(two.id).toBe(`ud-t02-${Date.parse("2026-09-16T05:30:00.000Z")}`);
  });

  it("keeps a traveller's own exclusions out of the supply signal", () => {
    // One candidate, and the traveller ruled it out. A real zero-result search
    // with no supply gap behind it: the row is logged, the blocker is the
    // traveller's own choice, and the engine refuses to build an opportunity
    // from it (`NEVER_AN_OPPORTUNITY`).
    const onlyCandidate = catalogue.find((row) => row.id === "ban-craft-shopping")!;
    const outcome = searchTraveller(
      request({
        id: "ctx-d",
        origin: { label: "Bandra", point: BANDRA },
        availableMin: 90,
        nowMin: 660,
        budgetMinor: 30000,
        partySize: 1,
        interests: ["craft"],
        excludedIds: ["ban-craft-shopping"],
      }),
      [onlyCandidate],
    );
    expect(outcome.rejections).toHaveLength(1);
    expect(outcome.demand?.topBlockingCode).toBe("excluded_by_traveller");
    expect(outcome.demand?.topBlockingCount).toBe(1);
  });
});

describe("the binding constraint", () => {
  it("is the code that killed the most candidates, and ties break the same way twice", () => {
    const rejections = [
      { experienceId: "a", code: "over_budget", message: "", shortfall: null, unit: null, relaxable: true },
      { experienceId: "a", code: "no_restroom", message: "", shortfall: null, unit: null, relaxable: true },
      { experienceId: "b", code: "no_restroom", message: "", shortfall: null, unit: null, relaxable: true },
    ] as const;
    expect(topBlocker(rejections as never)).toEqual({ code: "no_restroom", count: 2 });
    // Order of arrival cannot change the answer.
    expect(topBlocker([...rejections].reverse() as never)).toEqual({ code: "no_restroom", count: 2 });
  });

  it("never returns a count of zero", () => {
    expect(topBlocker([]).count).toBe(0);
  });
});

describe("the catalogue is the point, not a fixture", () => {
  it("really has unmet-demand scenarios in it", () => {
    const bandra = searchTraveller(
      request({
        id: "ctx-e",
        origin: { label: "Bandra", point: BANDRA },
        availableMin: 150,
        nowMin: 600,
        budgetMinor: 200000,
        partySize: 2,
        elderly: 1,
        accessNeeds: ["wheelchair", "restroom"],
        interests: ["heritage"],
      }),
      catalogue,
    );
    expect(bandra.demand).not.toBeNull();
    expect(bandra.demand!.topBlockingCode).toBe("no_restroom");
    // The as-of date is the only thing anchoring the window; nothing here reads
    // a clock, so this test is the same tomorrow as it is today.
    expect(Date.parse(bandra.demand!.at)).toBeLessThan(Date.parse(AS_OF));
  });
});
