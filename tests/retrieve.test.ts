/**
 * Retrieval tests.
 *
 * The two properties that matter most here are RECALL and DETERMINISM, and both
 * are easy to lose silently:
 *
 *   - Recall: a stage that drops a good row costs the whole pipeline, because
 *     nothing downstream can add it back. So most of these tests assert what
 *     retrieve KEEPS, not what it removes.
 *   - Determinism: the plan is diffed against `original` on every replan. If
 *     two runs over equal-scoring rows disagree, a replan reports changes that
 *     are not changes, and the "minimal swap" promise becomes noise.
 */
import { describe, expect, it } from "vitest";
import { DiscoveryContext, Experience, RetrieveInput } from "@/contracts";
import { travelBetween } from "../src/engine/travel";
import {
  DEFAULT_LIMIT,
  buildCandidates,
  negativeTerms,
  positiveTerms,
  reachMetres,
  retrieve,
  tokenise,
} from "../src/engine/retrieve";

/** A valid `Experience` with everything defaultable defaulted, via zod. */
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
    blurb: null,
    description: null,
    rating: { value: 4, count: 20, rawMean: 4.2 },
    neighbourhood: "Bandra West",
    ...over,
  });
}

function ctx(over: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return DiscoveryContext.parse({
    id: "session-1",
    origin: { label: "Bandra West", point: { lat: 19.0596, lon: 72.8296 } },
    availableMin: 180,
    nowMin: 660,
    original: { availableMin: 180, budget: null, partySize: 1, accessNeeds: [] },
    ...over,
  });
}

function run(context: DiscoveryContext, catalogue: Experience[], limit?: number): Experience[] {
  const input = RetrieveInput.parse(
    limit === undefined ? { context, catalogue } : { context, catalogue, limit },
  );
  return retrieve(input);
}

// ---------------------------------------------------------------------------

describe("tokenise", () => {
  it("drops stopwords and single characters", () => {
    expect(tokenise("I want to find a good cafe near the beach")).toEqual(["cafe", "beach"]);
  });

  it("keeps transliterated and non-Latin names instead of erasing them", () => {
    expect(tokenise("Irani chai at Kyani & Co")).toEqual(["irani", "chai", "kyani", "co"]);
    expect(tokenise("सिद्धिविनायक")).toEqual(["सिद्धिविनायक"]);
  });

  it("splits hyphens and underscores so 'street_food' matches 'street food'", () => {
    expect(tokenise("street_food")).toEqual(["street", "food"]);
  });
});

describe("query terms", () => {
  it("collects positives from interests and the pos half of requests", () => {
    const terms = positiveTerms(
      ctx({
        interests: ["pottery"],
        requests: [{ pos: "quiet gallery", neg: "crowded malls", mustsee: false, type: "location" }],
      }),
    );
    expect(terms).toContain("pottery");
    expect(terms).toContain("quiet");
    expect(terms).toContain("gallery");
    expect(terms).not.toContain("crowded");
  });

  it("collects negatives from avoid and the neg half of requests", () => {
    const terms = negativeTerms(
      ctx({
        avoid: ["crowded"],
        requests: [{ pos: "gallery", neg: "loud music", mustsee: false, type: "location" }],
      }),
    );
    expect(terms).toContain("crowded");
    expect(terms).toContain("loud");
    expect(terms).not.toContain("gallery");
  });
});

describe("reachMetres", () => {
  it("returns null when the origin is unresolved, so nothing is dropped", () => {
    expect(reachMetres(ctx({ origin: { label: "somewhere", point: null } }))).toBeNull();
  });

  it("grows with the time budget", () => {
    const short = reachMetres(ctx({ availableMin: 30 }));
    const long = reachMetres(ctx({ availableMin: 300 }));
    expect(short).not.toBeNull();
    expect(long).not.toBeNull();
    expect(long as number).toBeGreaterThan(short as number);
  });

  it("is generous enough that a 3-hour auto budget is effectively no filter in Mumbai", () => {
    // 180 min x 420 m/min x 2 pad = 151 km. Nothing in the city is excluded.
    expect(reachMetres(ctx({ availableMin: 180, travelMode: "auto" }))).toBeGreaterThan(50_000);
  });
});

describe("retrieve — recall", () => {
  const catalogue = [
    exp({ id: "a", name: "Kyani & Co", category: "cafe" }),
    exp({ id: "b", name: "Bandra Fort", category: "heritage_site" }),
    exp({ id: "c", name: "Carter Road", category: "beach" }),
  ];

  it("returns everything when the query is empty, rather than guessing", () => {
    expect(run(ctx(), catalogue)).toHaveLength(3);
  });

  it("returns [] for an empty catalogue", () => {
    expect(run(ctx(), [])).toEqual([]);
  });

  it("does NOT drop excludedIds — the gate owns that rejection and its copy", () => {
    const kept = run(ctx({ excludedIds: ["a"] }), catalogue);
    expect(kept.map((e) => e.id)).toContain("a");
  });

  it("does NOT drop pinnedIds", () => {
    const kept = run(ctx({ pinnedIds: ["b"] }), catalogue);
    expect(kept.map((e) => e.id)).toContain("b");
  });

  it("does not drop a far-away venue when the origin is unresolved", () => {
    const far = exp({ id: "far", name: "Elephanta", location: { lat: 18.9633, lon: 72.9315 } });
    const kept = run(ctx({ origin: { label: "unresolved", point: null } }), [far]);
    expect(kept).toHaveLength(1);
  });
});

describe("retrieve — geo prefilter", () => {
  it("drops a venue that could not be reached even at the padded radius", () => {
    const delhi = exp({ id: "delhi", name: "India Gate", location: { lat: 28.6129, lon: 77.2295 } });
    const bandra = exp({ id: "bandra", name: "Bandra Fort" });
    const kept = run(ctx({ availableMin: 120, travelMode: "walk" }), [delhi, bandra]);
    expect(kept.map((e) => e.id)).toEqual(["bandra"]);
  });

  it("keeps a venue a few km away on a short walking budget", () => {
    // 30 min walking = 30 x 80 x 2 = 4.8 km of straight-line allowance.
    const juhu = exp({ id: "juhu", name: "Juhu Beach", location: { lat: 19.0967, lon: 72.8266 } });
    const kept = run(ctx({ availableMin: 30, travelMode: "walk" }), [juhu]);
    expect(kept.map((e) => e.id)).toEqual(["juhu"]);
  });
});

describe("retrieve — text ranking", () => {
  it("ranks a name hit above an identical description-only hit", () => {
    const named = exp({ id: "named", name: "Pottery Studio" });
    const described = exp({
      id: "described",
      name: "Generic Workshop",
      description: "a pottery studio with wheels and kilns",
    });
    const ranked = run(ctx({ interests: ["pottery"] }), [described, named]);
    expect(ranked.map((e) => e.id)).toEqual(["named", "described"]);
  });

  it("ranks a keyword hit above a description hit", () => {
    const keyword = exp({ id: "kw", name: "Studio A", keywords: ["pottery"] });
    const desc = exp({ id: "desc", name: "Studio B", description: "pottery" });
    const ranked = run(ctx({ interests: ["pottery"] }), [desc, keyword]);
    expect(ranked.map((e) => e.id)).toEqual(["kw", "desc"]);
  });

  it("weights a rare term above a common one via IDF", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      exp({ id: `cafe-${i}`, name: `Cafe ${i}`, category: "cafe" }),
    );
    const rare = exp({ id: "rare", name: "Pottery Studio" });
    const ranked = run(ctx({ interests: ["pottery", "cafe"] }), [...many, rare]);
    expect(ranked[0]?.id).toBe("rare");
  });
});

describe("retrieve — facets boost, never filter", () => {
  it("boosts a venue matching a typed interest", () => {
    const match = exp({ id: "match", name: "A", category: "craft_workshop" });
    const other = exp({ id: "other", name: "B", category: "cafe" });
    const ranked = run(ctx({ interests: ["craft"] }), [other, match]);
    expect(ranked[0]?.id).toBe("match");
  });

  it("boosts a declared diet but does not penalise an undeclared one", () => {
    const declares = exp({ id: "declares", name: "A", diets: ["vegetarian"] });
    const silent = exp({ id: "silent", name: "B", diets: [] });
    const ranked = run(ctx({ diets: ["vegetarian"] }), [silent, declares]);
    expect(ranked[0]?.id).toBe("declares");
    expect(ranked).toHaveLength(2);
  });

  it("demotes but keeps a venue matching an avoid term", () => {
    const crowded = exp({ id: "crowded", name: "A", keywords: ["crowded"] });
    const quiet = exp({ id: "quiet", name: "B", keywords: ["quiet"] });
    const ranked = run(ctx({ avoid: ["crowded"] }), [crowded, quiet]);
    expect(ranked[0]?.id).toBe("quiet");
    expect(ranked.map((e) => e.id)).toContain("crowded");
  });
});

describe("retrieve — determinism", () => {
  it("gives byte-identical output across repeated runs", () => {
    const catalogue = [
      exp({ id: "a", name: "Same Name" }),
      exp({ id: "b", name: "Same Name" }),
      exp({ id: "c", name: "Same Name" }),
    ];
    const first = run(ctx(), catalogue).map((e) => e.id);
    const second = run(ctx(), catalogue).map((e) => e.id);
    expect(first).toEqual(second);
  });

  it("breaks equal scores by id, so shuffling the catalogue cannot reshuffle the plan", () => {
    // Three rows that are identical except for id: no text query, all at the
    // same point, so every score is exactly equal.
    const mk = (id: string) => exp({ id, name: `Identical ${id}` });
    const forward = run(ctx(), [mk("a"), mk("b"), mk("c")]).map((e) => e.id);
    const shuffled = run(ctx(), [mk("c"), mk("a"), mk("b")]).map((e) => e.id);
    expect(forward).toEqual(["a", "b", "c"]);
    expect(shuffled).toEqual(forward);
  });

  it("does not mutate the catalogue it was given", () => {
    const catalogue = [exp({ id: "a", name: "A" }), exp({ id: "b", name: "B" })];
    const before = JSON.stringify(catalogue);
    run(ctx(), catalogue);
    expect(JSON.stringify(catalogue)).toBe(before);
  });
});

describe("retrieve — limit", () => {
  const catalogue = Array.from({ length: 20 }, (_, i) => exp({ id: `e${i}`, name: `Place ${i}` }));

  it("honours an explicit limit", () => {
    expect(run(ctx(), catalogue, 5)).toHaveLength(5);
  });

  it("defaults to DEFAULT_LIMIT", () => {
    expect(DEFAULT_LIMIT).toBe(120);
    expect(run(ctx(), catalogue)).toHaveLength(20);
  });

  it("is capped at the catalogue size when fewer rows exist", () => {
    expect(run(ctx(), catalogue, 999)).toHaveLength(20);
  });
});

describe("buildCandidates", () => {
  const origin = { lat: 19.0596, lon: 72.8296 };

  it("refuses to guess when the origin is unresolved", async () => {
    await expect(
      buildCandidates(ctx({ origin: { label: "Colaba Causeway", point: null } }), [
        exp({ id: "a", name: "A" }),
      ]),
    ).rejects.toThrow(/origin\.point is null/);
  });

  it("attaches travel minutes and metres per candidate, offline", async () => {
    const far = exp({
      id: "far",
      name: "Far",
      location: { lat: 19.0967, lon: 72.8266 },
    });
    const candidates = await buildCandidates(ctx(), [far], { allowNetwork: false });
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c?.experience.id).toBe("far");
    expect(c?.travelMin).toBeGreaterThan(0);
    expect(Number.isInteger(c?.travelMin)).toBe(true);
    expect(c?.distanceM).toBeGreaterThan(0);
  });

  it("reports exactly the facade's minutes — rounding happens once, in travel.ts", async () => {
    const target = exp({ id: "t", name: "T", location: { lat: 19.07, lon: 72.84 } });
    const c = ctx();
    const leg = await travelBetween(origin, target.location, {
      atMin: c.nowMin,
      mode: "auto",
      allowNetwork: false,
    });
    const [candidate] = await buildCandidates(c, [target], { allowNetwork: false });
    expect(candidate?.travelMin).toBe(leg.minutes);
    expect(candidate?.distanceM).toBe(leg.metres);
  });

  it("never returns a fractional or zero minute, so a plan cannot pack into one minute", async () => {
    const adjacent = exp({
      id: "adjacent",
      name: "Adjacent",
      location: { lat: 19.059601, lon: 72.829601 },
    });
    const [candidate] = await buildCandidates(ctx(), [adjacent], { allowNetwork: false });
    expect(candidate?.travelMin).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(candidate?.travelMin)).toBe(true);
  });

  it("preserves input order, one candidate per item", async () => {
    const items = [
      exp({ id: "x", name: "X" }),
      exp({ id: "y", name: "Y" }),
      exp({ id: "z", name: "Z" }),
    ];
    const candidates = await buildCandidates(ctx(), items, { allowNetwork: false });
    expect(candidates.map((c) => c.experience.id)).toEqual(["x", "y", "z"]);
  });

  it("returns [] for no items without touching the origin", async () => {
    expect(await buildCandidates(ctx(), [], { allowNetwork: false })).toEqual([]);
  });
});
