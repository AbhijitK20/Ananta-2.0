/**
 * Demand aggregation: the counts, the ordering, the tiering, and the ways it
 * must refuse to answer.
 */
import { describe, expect, it } from "vitest";
import type { AccessNeed, RejectionCode, UnmetDemand } from "../../contracts";
import { Category } from "../../contracts";
import {
  MIN_SAMPLE,
  aggregateDemand,
  buildCells,
  categoryIntent,
  durationBandOf,
  distanceKm,
  localDate,
  localMinutesOfDay,
  partyBandOf,
  priceBandOf,
} from "./aggregate";
import { createDemoSource, AS_OF } from "./demo-data";

const AS_OF_ISO = "2026-09-26T14:00:00.000Z";

function demand(over: Partial<UnmetDemand> & { at?: string } = {}): UnmetDemand {
  return {
    id: "ud-test",
    travellerId: "t01",
    point: { lat: 18.9355, lon: 72.8355 },
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

describe("aggregateDemand", () => {
  it("counts every demand row in the window", () => {
    const agg = aggregateDemand(repeat(7), { asOf: AS_OF_ISO });
    expect(agg.total).toBe(7);
    expect(agg.byConstraint.bars).toHaveLength(1);
    expect(agg.byConstraint.bars[0]!.key).toBe("not_step_free");
    expect(agg.byConstraint.bars[0]!.value).toBe(7);
    expect(agg.byConstraint.bars[0]!.sampleSize).toBe(7);
  });

  it("excludes rows outside the window and counts them rather than dropping them silently", () => {
    const rows = [
      ...repeat(3),
      demand({ id: "old", at: "2026-08-01T12:00:00.000Z" }),
      demand({ id: "future", at: "2026-10-01T12:00:00.000Z" }),
    ];
    const agg = aggregateDemand(rows, { asOf: AS_OF_ISO, windowDays: 14 });
    expect(agg.total).toBe(3);
    expect(agg.outsideWindow).toBe(2);
  });

  it("sorts bars by count then key, so output cannot depend on input order", () => {
    const rows = [
      ...repeat(3, { topBlockingCode: "over_budget" }),
      ...repeat(5, { topBlockingCode: "closed_now" }),
      ...repeat(5, { topBlockingCode: "already_planned" }),
    ];
    const a = aggregateDemand(rows, { asOf: AS_OF_ISO });
    const b = aggregateDemand([...rows].reverse(), { asOf: AS_OF_ISO });
    expect(a).toEqual(b);
    expect(a.byConstraint.bars.map((x) => x.key)).toEqual(["already_planned", "closed_now", "over_budget"]);
    expect(a.byConstraint.bars.map((x) => x.value)).toEqual([5, 5, 3]);
  });

  it("shares sum to 1 within a dimension", () => {
    const rows = [
      ...repeat(6, { neighbourhood: "Fort" }),
      ...repeat(2, { neighbourhood: "Bandra West" }),
    ];
    const agg = aggregateDemand(rows, { asOf: AS_OF_ISO });
    const total = agg.byLocality.bars.reduce((a, b) => a + b.share, 0);
    expect(total).toBeCloseTo(1, 3);
  });

  it("marks a dimension unreliable below the sample bar but still returns the counts", () => {
    const agg = aggregateDemand(repeat(MIN_SAMPLE - 1), { asOf: AS_OF_ISO });
    expect(agg.byLocality.reliable).toBe(false);
    expect(agg.byLocality.n).toBe(MIN_SAMPLE - 1);
    expect(agg.byLocality.bars[0]!.value).toBe(MIN_SAMPLE - 1);
  });

  it("returns an empty, safe shape for no demand at all", () => {
    const agg = aggregateDemand([], { asOf: AS_OF_ISO });
    expect(agg.total).toBe(0);
    for (const dim of [
      agg.byCategory,
      agg.byLocality,
      agg.byTime,
      agg.byPrice,
      agg.byConstraint,
      agg.byAccessNeed,
      agg.byPartySize,
      agg.byWeather,
      agg.byDuration,
    ]) {
      expect(dim.bars).toEqual([]);
      expect(dim.n).toBe(0);
      expect(dim.reliable).toBe(false);
    }
  });

  it("keeps a null budget as its own band instead of a zero", () => {
    const rows = [...repeat(4, { constraints: { ...demand().constraints, budgetMinor: null } }), ...repeat(3)];
    const agg = aggregateDemand(rows, { asOf: AS_OF_ISO });
    const keys = agg.byPrice.bars.map((b) => b.key);
    expect(keys).toContain("no_limit");
    expect(agg.byPrice.bars.every((b) => b.value > 0)).toBe(true);
  });

  it("buckets time in local time, not UTC", () => {
    // 18:00 IST is 12:30 UTC. Bucketing on UTC would call this afternoon.
    const row = demand({ at: "2026-09-20T12:30:00.000Z" });
    expect(localMinutesOfDay(row.at)).toBe(18 * 60);
    const agg = aggregateDemand([row], { asOf: AS_OF_ISO });
    expect(agg.byTime.bars[0]!.key).toBe("evening");
  });

  it("honours a supplied timezone offset", () => {
    const row = demand({ at: "2026-09-20T12:30:00.000Z" });
    const utc = aggregateDemand([row], { asOf: AS_OF_ISO, tzOffsetMin: 0 });
    expect(utc.byTime.bars[0]!.key).toBe("afternoon");
  });
});

describe("categoryIntent", () => {
  it("reads an exact category tag as observed", () => {
    const intent = categoryIntent(["craft_workshop", "family"]);
    expect(intent.category).toBe("craft_workshop");
    expect(intent.tier).toBe("observed");
    expect(intent.matchedOn).toBe("craft_workshop");
  });

  it("returns a real Category, never the spaced string the traveller typed", () => {
    // `"craft workshop"` matched the set and came back verbatim, which is not a
    // `Category`. It then failed `listing.category === cell.category` and the
    // search produced no opportunity at all.
    const intent = categoryIntent(["craft workshop"]);
    expect(intent.category).toBe("craft_workshop");
    expect(intent.matchedOn).toBe("craft workshop");
    expect(Category.options).toContain(intent.category);
  });

  it("reads free text as inferred, not as fact", () => {
    const intent = categoryIntent(["block printing"]);
    expect(intent.category).toBe("craft_workshop");
    expect(intent.tier).toBe("inferred");
  });

  it("prefers the longest keyword so a specific phrase beats a generic one", () => {
    expect(categoryIntent(["workshop"]).category).toBe("craft_workshop");
    expect(categoryIntent(["pottery workshop"]).category).toBe("craft_workshop");
    expect(categoryIntent(["live music"]).category).toBe("music_live");
  });

  it("returns null when nothing is recognisable, and says so", () => {
    expect(categoryIntent(["somewhere quiet", "  "])).toEqual({
      category: null,
      tier: "observed",
      matchedOn: null,
    });
  });

  it("badges each bar by how its own category was read", () => {
    const stated = repeat(3, { constraints: { ...demand().constraints, interests: ["craft_workshop"] } });
    const inferred = repeat(3, {
      constraints: { ...demand().constraints, interests: ["ghazal nights"] },
      topBlockingCode: "over_budget",
    });
    const agg = aggregateDemand([...stated, ...inferred], { asOf: AS_OF_ISO });
    expect(agg.byCategory.bars.map((b) => [b.key, b.tier, b.value])).toEqual([
      ["craft_workshop", "observed", 3],
      ["music_live", "inferred", 3],
    ]);
    expect(agg.byCategory.n).toBe(6);
  });

  it("adds up a category that was both stated and guessed, and badges it once", () => {
    const rows = [
      ...repeat(3, { constraints: { ...demand().constraints, interests: ["craft_workshop"] } }),
      ...repeat(2, { constraints: { ...demand().constraints, interests: ["handloom weaving"] } }),
    ];
    const agg = aggregateDemand(rows, { asOf: AS_OF_ISO });
    expect(agg.byCategory.bars).toHaveLength(1);
    expect(agg.byCategory.bars[0]!.value).toBe(5);
    expect(agg.byCategory.bars[0]!.tier).toBe("observed");
  });
});

describe("bands", () => {
  it("prices in rupees and reads as money", () => {
    expect(priceBandOf(50000).key).toBe("250-500");
    expect(priceBandOf(50000).label).toContain("₹500");
    expect(priceBandOf(100000).key).toBe("500-1000");
    expect(priceBandOf(1000000).key).toBe("5000+");
  });

  it("buckets party size and duration by named ranges", () => {
    expect(partyBandOf(1).key).toBe("1");
    expect(partyBandOf(4).key).toBe("3-4");
    expect(partyBandOf(9).key).toBe("5+");
    expect(durationBandOf(45).key).toBe("0-60");
    expect(durationBandOf(600).key).toBe("480+");
  });
});

describe("buildCells", () => {
  it("groups by neighbourhood, blocking code and category", () => {
    const rows = [
      ...repeat(4, { topBlockingCode: "not_step_free" }),
      ...repeat(3, { topBlockingCode: "over_budget" }),
      ...repeat(2, { neighbourhood: "Bandra West", topBlockingCode: "not_step_free" }),
    ];
    const cells = buildCells(rows, { asOf: AS_OF_ISO });
    expect(cells).toHaveLength(3);
    expect(cells[0]!.key).toBe("Fort|not_step_free|craft_workshop");
    expect(cells[0]!.n).toBe(4);
  });

  it("carries the medians a provider actually needs", () => {
    const rows = [
      demand({ constraints: { ...demand().constraints, budgetMinor: 30000, partySize: 2, availableMin: 90 } }),
      demand({ constraints: { ...demand().constraints, budgetMinor: 50000, partySize: 6, availableMin: 150 } }),
      demand({ constraints: { ...demand().constraints, budgetMinor: 70000, partySize: 4, availableMin: 120 } }),
    ];
    const cell = buildCells(rows, { asOf: AS_OF_ISO })[0]!;
    expect(cell.budgetMinor).toBe(50000);
    expect(cell.partySize).toBe(4);
    expect(cell.availableMin).toBe(120);
  });

  it("refuses to name a time of day below the sample bar", () => {
    const cell = buildCells(repeat(3), { asOf: AS_OF_ISO })[0]!;
    expect(cell.timeBucket).toBeNull();
    expect(cell.timeTier).toBe("inferred");
    expect(cell.reliable).toBe(false);

    const solid = buildCells(repeat(MIN_SAMPLE), { asOf: AS_OF_ISO })[0]!;
    expect(solid.timeBucket).toBe("evening");
    expect(solid.timeTier).toBe("observed");
    expect(solid.reliable).toBe(true);
  });

  it("flags a family signal from party size or from the traveller's own words", () => {
    const group = buildCells(repeat(6, { constraints: { ...demand().constraints, partySize: 4 } }), { asOf: AS_OF_ISO })[0]!;
    expect(group.kidSignal).toBe(true);
    const words = buildCells(
      repeat(6, { constraints: { ...demand().constraints, partySize: 2, interests: ["craft_workshop", "toddler"] } }),
      { asOf: AS_OF_ISO },
    )[0]!;
    expect(words.kidSignal).toBe(true);
  });
});

describe("demo dataset", () => {
  const source = createDemoSource();

  it("satisfies the contracts, since the adapter parses it", () => {
    expect(() => import("./adapter").then((m) => m.parseAnalyticsSource(source))).not.toThrow();
  });

  it("is byte-identical on every call", () => {
    expect(JSON.stringify(createDemoSource())).toBe(JSON.stringify(source));
  });

  it("puts every demand row inside the window, and none in the future", () => {
    const agg = aggregateDemand(source.unmetDemand, { asOf: AS_OF });
    expect(agg.outsideWindow).toBe(0);
    expect(agg.total).toBe(source.unmetDemand.length);
    expect(source.unmetDemand.every((d) => Date.parse(d.at) <= Date.parse(AS_OF))).toBe(true);
  });

  it("anchors the window to a fixed date", () => {
    expect(AS_OF).toBe("2026-09-26T14:00:00.000Z");
    expect(localDate("2026-09-25T20:00:00.000Z")).toBe("2026-09-26");
  });

  it("exercises every access-need code it claims to", () => {
    const needs = new Set<AccessNeed>();
    for (const d of source.unmetDemand) for (const n of d.constraints.accessNeeds) needs.add(n);
    expect([...needs].sort()).toEqual(["hearingLoop", "restroom", "stroller", "wheelchair"]);
  });

  it("covers a spread of blocking codes rather than one", () => {
    const codes = new Set<RejectionCode>(source.unmetDemand.map((d) => d.topBlockingCode));
    expect(codes.size).toBeGreaterThanOrEqual(8);
  });
});

describe("distanceKm", () => {
  it("is zero for a point and about 3.4 km for Fort to Colaba", () => {
    expect(distanceKm({ lat: 18.9355, lon: 72.8355 }, { lat: 18.9355, lon: 72.8355 })).toBe(0);
    const fortToColaba = distanceKm({ lat: 18.9355, lon: 72.8355 }, { lat: 18.9067, lon: 72.8147 });
    expect(fortToColaba).toBeGreaterThan(3);
    expect(fortToColaba).toBeLessThan(4);
  });
});
