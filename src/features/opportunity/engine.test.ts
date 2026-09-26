/**
 * Aggregation, thresholds, evidence, and what happens when supply answers.
 *
 * The `UnmetDemand` rows here are hand-built. That is deliberate and narrow: this
 * file tests the counters — is five enough, does one account count, does a stale
 * row fall out of the window — and you cannot test a counter by generating its
 * input with the code under test. That the pipeline can produce these rows from
 * real searches is `cycle.test.ts`, against the committed catalogue.
 */
import { describe, expect, it } from "vitest";
import { Experience, Provider, UnmetDemand, type RejectionCode } from "../../contracts";
import { buildExperience, EMPTY_DRAFT, type ListingDraft } from "../provider/listing";
import {
  acquisitionGaps,
  aggregateGaps,
  categoryIntent,
  detectOpportunities,
  fixFor,
  MIN_SEARCHES,
  MIN_TRAVELLERS,
  NEVER_AN_OPPORTUNITY,
  opportunitiesForProvider,
  queryOpportunities,
  WINDOW_DAYS,
} from "./engine";

const TODAY = "2026-09-20";
const AS_OF = "2026-09-20T09:00:00.000Z";
const DAY = 86_400_000;

const provider = Provider.parse({
  id: "prov-kiln",
  name: "Bandra Kiln Studio",
  kind: "workshop",
  bio: null,
  neighbourhood: "Bandra",
  city: "Mumbai",
  reliability: 0.7,
  verified: false,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const other = Provider.parse({ ...provider, id: "prov-other", name: "Fort Loom" });

/**
 * A real contract row, built by the provider's own write model. `providerId` is
 * re-applied afterwards because `buildExperience` always stamps the provider it
 * was given, and the tests need unowned OSM rows too.
 */
const listing = (id: string, providerId: string | null, over: Partial<ListingDraft> = {}) =>
  Experience.parse({
    ...buildExperience(
      {
        ...EMPTY_DRAFT,
        name: "Kiln bench",
        category: "craft_workshop",
        lat: "19.0596",
        lon: "72.8392",
        neighbourhood: "Bandra",
        durationMin: "60",
        capacity: "8",
        priceRupees: "2500",
        ...over,
      },
      { id, providerId: providerId ?? "unowned", today: TODAY },
    ),
    providerId,
  });

const at = (daysAgo: number, hour = 10): string =>
  new Date(Date.parse(AS_OF) - daysAgo * DAY).toISOString().replace(/T\d\d:.*/, `T${String(hour).padStart(2, "0")}:00:00.000Z`);

const row = (over: Partial<UnmetDemand> = {}): UnmetDemand =>
  UnmetDemand.parse({
    id: `ud-${Math.random().toString(36).slice(2)}`,
    travellerId: "t01",
    point: { lat: 19.0596, lon: 72.8392 },
    neighbourhood: "Bandra",
    at: at(3),
    constraints: {
      availableMin: 180,
      budgetMinor: 300000,
      partySize: 4,
      accessNeeds: [],
      interests: ["pottery"],
      weather: "clear",
    },
    shortfallCount: 0,
    topBlockingCode: "over_budget",
    topBlockingCount: 3,
    ...over,
  });

/** `n` distinct travellers, one search each, all the same shape. */
const many = (n: number, over: Partial<UnmetDemand> = {}): UnmetDemand[] =>
  Array.from({ length: n }, (_unused, i) =>
    row({
      id: `ud-${String(i).padStart(2, "0")}`,
      travellerId: `t${String(i).padStart(2, "0")}`,
      at: at(1 + (i % 10)),
      ...over,
    }),
  );

const detect = (gaps: ReturnType<typeof aggregateGaps>, catalogue: ReturnType<typeof listing>[], providers = [provider]) =>
  detectOpportunities(gaps, catalogue, { asOf: AS_OF, providers, datasetLabel: "test log" });

describe("aggregation", () => {
  it("groups by neighbourhood, binding code and category, and counts properly", () => {
    const gaps = aggregateGaps(many(MIN_SEARCHES), { asOf: AS_OF });
    expect(gaps).toHaveLength(1);
    const gap = gaps[0]!;
    expect(gap.key).toBe("Bandra|over_budget|craft_workshop");
    expect(gap.searches).toBe(MIN_SEARCHES);
    expect(gap.travellers).toBe(MIN_SEARCHES);
    expect(gap.blockedCandidates).toBe(MIN_SEARCHES * 3);
    expect(gap.budgetMinor).toBe(300000);
    expect(gap.availableMin).toBe(180);
    expect(gap.partySize).toBe(4);
    expect(gap.reliable).toBe(true);
    expect(gap.firstSeenAt).toBe(at(MIN_SEARCHES));
    expect(gap.lastSeenAt).toBe(at(1));
  });

  it("takes medians, not means, so one big party does not speak for the group", () => {
    const rows = [
      ...many(4, { travellerId: "a", constraints: { ...row().constraints, partySize: 2, budgetMinor: 100000 } }),
      row({ id: "ud-big", travellerId: "b", constraints: { ...row().constraints, partySize: 20, budgetMinor: 900000 } }),
    ];
    const gap = aggregateGaps(rows, { asOf: AS_OF })[0]!;
    expect(gap.partySize).toBe(2);
    expect(gap.budgetMinor).toBe(100000);
  });

  it("will not build anything from a cell below the search bar", () => {
    const thin = aggregateGaps(many(MIN_SEARCHES - 1), { asOf: AS_OF })[0]!;
    expect(thin.reliable).toBe(false);
    expect(detect([thin], [listing("exp-1", provider.id)])).toEqual([]);
  });

  it("will not build anything from one account searching many times", () => {
    const rows = many(MIN_SEARCHES, { travellerId: "one-person" });
    const gap = aggregateGaps(rows, { asOf: AS_OF })[0]!;
    expect(gap.searches).toBe(MIN_SEARCHES);
    expect(gap.travellers).toBe(1);
    expect(gap.reliable).toBe(false);
    expect(MIN_TRAVELLERS).toBe(2);
    expect(detect([gap], [listing("exp-1", provider.id)])).toEqual([]);
  });

  it("drops rows outside the window", () => {
    const gaps = aggregateGaps(
      [...many(MIN_SEARCHES), row({ id: "old", at: at(WINDOW_DAYS + 2) }), row({ id: "future", at: at(-1) })],
      { asOf: AS_OF },
    );
    expect(gaps[0]!.searches).toBe(MIN_SEARCHES);
  });

  it("re-tests a cell against the weather most of its searches were run in", () => {
    // "clear" sorts before "heavy_rain". Taking the alphabetically first value
    // would re-test four searches made in the rain as a dry-weather gap.
    const gap = aggregateGaps(
      [
        ...many(3, { topBlockingCode: "weather_unsafe" }),
        ...Array.from({ length: 4 }, (_unused, i) =>
          row({
            id: `ud-r${i}`,
            travellerId: `r${i}`,
            topBlockingCode: "weather_unsafe",
            constraints: { ...row().constraints, weather: "heavy_rain" },
          }),
        ),
      ],
      { asOf: AS_OF },
    )[0]!;
    expect(gap.searches).toBe(7);
    expect(gap.weather).toBe("heavy_rain");
  });

  it("keeps every access need in the cell, not only the most common one", () => {
    // Three travellers need a stroller route, four need step-free. A listing
    // that offers one and not the other has not closed this cell, so the union
    // is what gets re-tested against supply.
    const gap = aggregateGaps(
      [
        ...many(3, {
          topBlockingCode: "not_step_free",
          constraints: { ...row().constraints, accessNeeds: ["stroller"] },
        }),
        ...Array.from({ length: 4 }, (_unused, i) =>
          row({
            id: `ud-a${i}`,
            travellerId: `a${i}`,
            topBlockingCode: "not_step_free",
            constraints: { ...row().constraints, accessNeeds: ["wheelchair"] },
          }),
        ),
      ],
      { asOf: AS_OF },
    )[0]!;
    expect(gap.accessNeeds).toEqual(["stroller", "wheelchair"]);
  });

  it("keeps separate cells apart instead of merging unrelated demand", () => {    const gaps = aggregateGaps(
      [...many(MIN_SEARCHES), ...many(MIN_SEARCHES, { id: "x", travellerId: "u", constraints: { ...row().constraints, interests: ["museum"] } })],
      { asOf: AS_OF },
    );
    expect(gaps.map((gap) => gap.key).sort()).toEqual([
      "Bandra|over_budget|craft_workshop",
      "Bandra|over_budget|museum",
    ]);
  });
});

describe("category intent", () => {
  it("tiers an exact contract tag as observed and a keyword hit as inferred", () => {
    expect(categoryIntent(["craft_workshop"])).toEqual({ category: "craft_workshop", tier: "observed", matchedOn: "craft_workshop" });
    expect(categoryIntent(["pottery"]).tier).toBe("inferred");
    expect(categoryIntent(["pottery"]).category).toBe("craft_workshop");
    expect(categoryIntent(["zzz"])).toEqual({ category: null, tier: "observed", matchedOn: null });
  });
});

describe("blockers a provider cannot act on", () => {
  it("never become an opportunity, whatever the evidence behind them", () => {
    for (const code of NEVER_AN_OPPORTUNITY) {
      const gap = aggregateGaps(many(MIN_SEARCHES, { topBlockingCode: code, topBlockingCount: 40 }), { asOf: AS_OF })[0]!;
      expect(gap.reliable).toBe(true);
      expect(detect([gap], [listing("exp-1", provider.id)])).toEqual([]);
    }
  });

  it("catches a code that is neither fixable nor on the never list", () => {
    // `over_budget_per_person` is a real code the traveller understands and this
    // engine never produces, because `UnmetDemand` logs one budget column. A row
    // carrying it must not become an opportunity we cannot act on.
    expect(fixFor("over_budget_per_person")).toBeNull();
    const gap = aggregateGaps(many(MIN_SEARCHES, { topBlockingCode: "over_budget_per_person" }), { asOf: AS_OF })[0]!;
    expect(detect([gap], [listing("exp-1", provider.id)])).toEqual([]);
  });

  it("names a field for every code it is willing to act on", () => {
    for (const code of ["over_budget", "duration_exceeds_budget", "capacity_exceeded", "not_step_free", "no_restroom", "lead_time_too_short", "requires_booking_not_available", "weather_unsafe"] as RejectionCode[]) {
      const fix = fixFor(code);
      expect(fix, code).not.toBeNull();
      expect(fix!.field, code).not.toBe("");
    }
  });
});

describe("detection", () => {
  const gaps = aggregateGaps(many(MIN_SEARCHES), { asOf: AS_OF });

  it("records an acquisition gap when no provider owns anything in range", () => {
    const records = detect(gaps, [listing("exp-osm", null)], []);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.kind).toBe("must_see_gap");
    expect(record.status).toBe("open");
    expect(record.providerId).toBeNull();
    expect(record.targetListingId).toBeNull();
    expect(record.contract.headline).toContain("No provider can serve this yet");
    expect(record.contract.cta).toContain("List a craft workshop in Bandra");
  });

  it("targets the cheapest failing listing of the provider's own, with the field to change", () => {
    const records = detect(gaps, [listing("exp-osm", null), listing("exp-1", provider.id)]);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.kind).toBe("listing_quality");
    expect(record.providerId).toBe(provider.id);
    expect(record.targetListingId).toBe("exp-1");
    expect(record.missingSupply).toEqual({ code: "over_budget", field: "pricePerPerson", label: "a lower price band" });
    expect(record.contract.headline).toContain("Add a ₹750 band to Kiln bench");
    expect(record.contract.cta).toBe("Open Kiln bench at pricePerPerson and add a ₹750 band.");
    expect(record.targetBlockers).toEqual(["over_budget"]);
    expect(record.contract.estimatedImpact).toBeNull();
  });

  it("calls a slot-shaped blocker a capacity window, not a listing fix", () => {
    const slotGaps = aggregateGaps(
      many(MIN_SEARCHES, { topBlockingCode: "lead_time_too_short", constraints: { ...row().constraints, interests: ["theatre"] } }),
      { asOf: AS_OF },
    );
    const records = detect(slotGaps, [
      listing("exp-1", provider.id, { category: "theatre", requiresBooking: true, leadTimeMin: "1440", walkIn: false }),
    ]);
    expect(records[0]!.kind).toBe("capacity_window");
    expect(records[0]!.missingSupply.field).toBe("booking.leadTimeMin");
  });

  it("asks a provider to confirm an unknown field and to add a known-absent one", () => {
    const unknown = detect(
      aggregateGaps(many(MIN_SEARCHES, { topBlockingCode: "no_restroom" }), { asOf: AS_OF }),
      [listing("exp-1", provider.id, { restroomOnSite: "unknown" })],
    )[0]!;
    expect(unknown.contract.headline).toContain("Confirm a restroom on site");
    const absent = detect(
      aggregateGaps(many(MIN_SEARCHES, { topBlockingCode: "no_restroom" }), { asOf: AS_OF }),
      [listing("exp-1", provider.id, { restroomOnSite: "no" })],
    )[0]!;
    expect(absent.contract.headline).toContain("Add a restroom on site");
  });

  it("carries the evidence the mandate names, with real numbers in it", () => {
    const record = detect(gaps, [listing("exp-1", provider.id)])[0]!;
    const evidence = new Map(record.contract.evidence.map((row) => [row.label, row.value]));
    expect(evidence.get("searches")).toBe(`${MIN_SEARCHES} in the last 14 days`);
    expect(evidence.get("travellers")).toBe(`${MIN_SEARCHES} different accounts`);
    expect(evidence.get("where")).toBe("Bandra, within 2 km");
    expect(evidence.get("category")).toContain("craft workshops");
    expect(evidence.get("budget")).toContain("₹3,000");
    expect(evidence.get("constraints")).toBe("none stated beyond the above");
    expect(evidence.get("candidates blocked on it")).toBe(String(MIN_SEARCHES * 3));
    expect(evidence.get("source")).toBe("test log");
    // No evidence row may be a bare number with nothing to attach it to.
    for (const { label, value } of record.contract.evidence) {
      expect(label.trim(), label).not.toBe("");
      expect(value.trim(), label).not.toBe("");
    }
  });

  it("produces the same records whatever order the catalogue arrives in", () => {
    const catalogue = [listing("exp-1", provider.id), listing("exp-osm", null), listing("exp-2", other.id)];
    const first = JSON.stringify(detect(gaps, catalogue, [provider, other]));
    const second = JSON.stringify(detect(gaps, [...catalogue].reverse(), [other, provider]));
    expect(second).toBe(first);
  });
});

describe("supply answering the demand", () => {
  const gaps = aggregateGaps(many(MIN_SEARCHES), { asOf: AS_OF });

  it("keeps the opportunity while the listing still fails, and shrinks the blockers as it improves", () => {
    const dear = listing("exp-1", provider.id, { priceRupees: "2500" });
    const before = detect(gaps, [dear])[0]!;
    expect(before.status).toBe("open");
    expect(before.targetBlockers).toEqual(["over_budget"]);

    const cheaper = listing("exp-1", provider.id, { priceRupees: "2000" });
    const still = detect(gaps, [cheaper])[0]!;
    expect(still.status).toBe("open");
    expect(still.servedBy).toEqual([]);

    // The moment the price clears the ceiling the record flips. Same predicate
    // the traveller's search used, so "serves it" means what "found nothing" meant.
    const serves = listing("exp-1", provider.id, { priceRupees: "700" });
    const after = detect(gaps, [serves]);
    expect(opportunitiesForProvider(after, provider.id)).toEqual([]);
    const met = opportunitiesForProvider(after, provider.id, { includeMet: true })[0]!;
    expect(met.status).toBe("met");
    expect(met.servedBy).toEqual(["exp-1"]);
    expect(met.contract.headline).toContain("now serves this");
    expect(met.contract.cta).toContain("Nothing to do");
  });

  it("stops calling a served gap an acquisition target", () => {
    const serves = listing("exp-1", provider.id, { priceRupees: "700" });
    const stale = listing("exp-osm", null, { priceRupees: "2500" });
    const records = detect(gaps, [serves, stale]);
    expect(acquisitionGaps(records)).toEqual([]);
    expect(records.filter((record) => record.status === "open")).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it("keeps the gap alive while any provider-owned listing still fails", () => {
    const mine = listing("exp-1", provider.id, { priceRupees: "2500" });
    const rival = listing("exp-2", other.id, { priceRupees: "2500" });
    const mineFixed = listing("exp-1", provider.id, { priceRupees: "700" });
    const records = detect(gaps, [mine, rival], [provider, other]);
    expect(records.map((record) => record.providerId)).toEqual([provider.id, other.id]);

    const after = detect(gaps, [mineFixed, rival], [provider, other]);
    expect(opportunitiesForProvider(after, provider.id)).toEqual([]);
    expect(opportunitiesForProvider(after, other.id)).toHaveLength(1);
    expect(after.find((record) => record.providerId === provider.id)!.status).toBe("met");
    expect(after.find((record) => record.providerId === other.id)!.targetListingId).toBe("exp-2");
  });
});

describe("the provider-facing query", () => {
  const museumRows = Array.from({ length: MIN_SEARCHES }, (_unused, i) =>
    row({
      id: `ud-m${i}`,
      travellerId: `m${i}`,
      topBlockingCode: "no_restroom",
      constraints: { ...row().constraints, interests: ["museum"] },
    }),
  );
  const gaps = aggregateGaps([...many(MIN_SEARCHES), ...museumRows], { asOf: AS_OF });
  const records = detect(gaps, [
    listing("exp-1", provider.id, { priceRupees: "2500" }),
    listing("exp-2", provider.id, { category: "museum", priceRupees: "2500", restroomOnSite: "no" }),
  ]);

  it("returns only that provider's open work by default", () => {
    expect(opportunitiesForProvider(records, provider.id)).toHaveLength(2);
    expect(opportunitiesForProvider(records, other.id)).toEqual([]);
    expect(queryOpportunities(records, { providerId: "nobody" })).toEqual([]);
  });

  it("filters by kind, category, neighbourhood and evidence", () => {
    expect(queryOpportunities(records, { kind: "must_see_gap" })).toEqual([]);
    expect(queryOpportunities(records, { category: "museum" })).toHaveLength(1);
    expect(queryOpportunities(records, { category: null })).toEqual([]);
    expect(queryOpportunities(records, { neighbourhood: "Fort" })).toEqual([]);
    expect(queryOpportunities(records, { minSearches: MIN_SEARCHES + 1 })).toEqual([]);
    expect(queryOpportunities(records, { limit: 1 })).toHaveLength(1);
  });

  it("orders by evidence, not by the order things were detected", () => {
    const smaller = aggregateGaps(
      many(MIN_SEARCHES - 1, { id: "s", travellerId: `u${MIN_SEARCHES}` }),
      { asOf: AS_OF },
    );
    expect(detect(smaller, [listing("exp-1", provider.id)]).length).toBe(0);

    // A second gap with more searches must come first regardless of which cell
    // was aggregated first, so the feed cannot reshuffle between renders.
    const roomier = aggregateGaps(
      many(MIN_SEARCHES + 2, { id: "w", constraints: { ...row().constraints, interests: ["craft workshop"] } }),
      { asOf: AS_OF },
    );
    const forwards = detect([...gaps, ...roomier], [listing("exp-1", provider.id)]);
    const backwards = detect([...roomier, ...gaps], [listing("exp-1", provider.id)]);
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
    expect(forwards[0]!.demand.searches).toBe(MIN_SEARCHES + 2);
  });
});
