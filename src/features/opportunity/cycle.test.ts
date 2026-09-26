/**
 * THE MANDATORY TEST. Real requests, real catalogue, real provider model.
 *
 * Nothing here is a fixture. Seven traveller searches are built with the
 * discovery feature's own `createContext` and run against the 133 curated rows in
 * `content/experiences/`. The unmet-demand rows are whatever those searches
 * actually produced. Supply is created by calling the provider feature's own
 * `ProviderStore.saveListing`, and edits are made by calling it again.
 *
 * The scenario, from real data: a family of four in Bandra, ₹3,000, three hours,
 * a stroller, looking for a pottery workshop. There is exactly one craft workshop
 * within 2 km and it is ₹2,500 a head with three days' notice and no stroller
 * access. Seven different travellers asked. That is the opportunity.
 *
 * Then the provider answers it, and the feed has to answer back.
 *
 * One module-level store, walked forward on purpose: this file is a scenario, not
 * eleven independent cases, and the order the `it` blocks run in is the order the
 * provider acts in. `engine.test.ts` covers every rule here in isolation.
 */
import { describe, expect, it } from "vitest";
import { Provider } from "../../contracts";
import { createContext, type ContextSeed } from "../discovery/context";
import { draftFromExperience } from "../provider/listing";
import { ProviderStore } from "../provider/store";
import { loadCatalogue } from "./catalogue";
import { searchTraveller, type TravellerRequest } from "./demand";
import {
  acquisitionGaps,
  aggregateGaps,
  detectOpportunities,
  opportunitiesForProvider,
  type ProviderOpportunityRecord,
} from "./engine";

const catalogue = loadCatalogue();
const TODAY = "2026-09-20";
const AS_OF = "2026-09-20T09:00:00.000Z";
const BANDRA = { lat: 19.0596, lon: 72.8392 };

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

/** Seven real searches. Same want, seven different people, one day apart. */
const SEARCHES = 7;

function familyRequest(i: number): TravellerRequest {
  const seed: ContextSeed = {
    id: `ctx-${i}`,
    origin: { label: "Bandra", point: BANDRA },
    availableMin: 180,
    nowMin: 600 + i,
    budgetMinor: 300000,
    partySize: 4,
    childAges: [5, 8],
    accessNeeds: ["stroller"],
    interests: ["pottery"],
  };
  const { ctx } = createContext(seed);
  return {
    travellerId: `t${String(i).padStart(2, "0")}`,
    at: `2026-09-${String(10 + i).padStart(2, "0")}T05:30:00.000Z`,
    // Jittered inside the neighbourhood, so the radius check is a real distance.
    point: { lat: BANDRA.lat + i * 0.0004, lon: BANDRA.lon - i * 0.0003 },
    neighbourhood: "Bandra",
    ctx,
  };
}

const requests = Array.from({ length: SEARCHES }, (_unused, i) => familyRequest(i));
const outcomes = requests.map((request) => searchTraveller(request, catalogue));
const logged = outcomes.map((outcome) => outcome.demand).filter((row) => row !== null);

function feed(listings = store.allListings()): ProviderOpportunityRecord[] {
  return detectOpportunities(gaps, [...catalogue, ...listings], {
    asOf: AS_OF,
    providers: [provider],
    datasetLabel: "content/experiences + real searches",
  });
}

const store = new ProviderStore(provider, {}, TODAY);
const gaps = aggregateGaps(logged, { asOf: AS_OF });

describe("step 1 — real traveller searches produce real unmet demand", () => {
  it("every one of them found nothing, and every one of them was logged", () => {
    expect(outcomes).toHaveLength(SEARCHES);
    expect(logged).toHaveLength(SEARCHES);
    for (const outcome of outcomes) {
      expect(outcome.passed, outcome.travellerId).toEqual([]);
      expect(outcome.retrieved).toBeGreaterThan(0);
    }
  });

  it("the rows are contract rows, carrying a real blocker with a real count", () => {
    for (const row of logged) {
      expect(row.shortfallCount).toBe(0);
      expect(row.topBlockingCount).toBeGreaterThan(0);
      expect(row.neighbourhood).toBe("Bandra");
      expect(row.constraints.partySize).toBe(4);
      expect(row.constraints.budgetMinor).toBe(300000);
      expect(row.constraints.accessNeeds).toEqual(["stroller"]);
    }
    // The single craft workshop in range needs three days' notice. Seven
    // searches, seven times the same binding constraint, no hardcoding anywhere:
    // this number is the tally the search itself produced.
    expect(new Set(logged.map((row) => row.topBlockingCode))).toEqual(new Set(["lead_time_too_short"]));
    expect(logged.every((row) => row.topBlockingCount === 1)).toBe(true);
  });

  it("no identity leaks into the analytics path", () => {
    const serialised = JSON.stringify(logged);
    // Constraints and a pseudonymous id, per DATA_SPEC §: no name, no contact,
    // and nothing that would let a provider work out who was in the room.
    expect(serialised).not.toMatch(/@|\+91|email|phone|street/i);
    for (const row of logged) {
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
    }
  });
});

describe("step 2 — the searches aggregate into one gap", () => {
  it("one cell, counted honestly", () => {
    expect(gaps).toHaveLength(1);
    const gap = gaps[0]!;
    expect(gap.key).toBe("Bandra|lead_time_too_short|craft_workshop");
    expect(gap.searches).toBe(SEARCHES);
    expect(gap.travellers).toBe(SEARCHES);
    expect(gap.blockedCandidates).toBe(SEARCHES);
    expect(gap.budgetMinor).toBe(300000);
    expect(gap.partySize).toBe(4);
    expect(gap.availableMin).toBe(180);
    expect(gap.accessNeeds).toEqual(["stroller"]);
    expect(gap.reliable).toBe(true);
  });
});

describe("step 3 — the gap becomes a provider-facing opportunity", () => {
  it("before anybody claims the listing, it is an acquisition gap, not a push", () => {
    const records = feed();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.kind).toBe("must_see_gap");
    expect(record.status).toBe("open");
    expect(record.providerId).toBeNull();
    expect(opportunitiesForProvider(records, provider.id)).toEqual([]);
    expect(acquisitionGaps(records)).toHaveLength(1);
  });

  it("once the provider claims it, the record names the listing and the field", () => {
    const curated = catalogue.find((row) => row.id === "ban-ceramicist")!;
    const saved = store.saveListing(null, draftFromExperience(curated));
    expect(saved.ok).toBe(true);

    const records = feed();
    const record = opportunitiesForProvider(records, provider.id);
    expect(record).toHaveLength(1);
    const opportunity = record[0]!;
    expect(opportunity.kind).toBe("capacity_window");
    expect(opportunity.status).toBe("open");
    expect(opportunity.providerId).toBe(provider.id);
    expect(opportunity.targetListingName).toBe("The ceramicist's kiln day");
    expect(opportunity.missingSupply).toEqual({
      code: "lead_time_too_short",
      field: "booking.leadTimeMin",
      label: "less notice needed",
    });
    expect(opportunity.contract.headline).toContain("Cut the notice on The ceramicist's kiln day to 3h");
    expect(opportunity.contract.headline).toContain(`7 searches near Bandra`);
    expect(opportunity.contract.cta).toBe(
      "Open The ceramicist's kiln day at booking.leadTimeMin and cut the notice to 3h.",
    );
    // Four independent reasons this listing misses that demand, all real, all
    // read off the listing as it stands.
    expect(opportunity.targetBlockers).toEqual([
      "over_budget",
      "not_stroller_ok",
      "requires_booking_not_available",
      "lead_time_too_short",
    ]);
  });

  it("the evidence is the demand, with counts, location, category, budget and constraints", () => {
    const evidence = new Map(
      opportunitiesForProvider(feed(), provider.id)[0]!.contract.evidence.map((row) => [row.label, row.value]),
    );
    expect(evidence.get("searches")).toBe("7 in the last 14 days");
    expect(evidence.get("travellers")).toBe("7 different accounts");
    expect(evidence.get("where")).toBe("Bandra, within 2 km");
    expect(evidence.get("category")).toBe("craft workshops, read as inferred");
    expect(evidence.get("asked for")).toBe("pottery");
    expect(evidence.get("budget")).toBe("₹3,000 total, ₹750 a head (median)");
    expect(evidence.get("window")).toBe("3h (median)");
    expect(evidence.get("party")).toBe("4 people (median)");
    expect(evidence.get("constraints")).toBe("stroller");
    expect(evidence.get("blocked on")).toBe("lead time too short");
    expect(evidence.get("candidates blocked on it")).toBe("7");
    expect(evidence.get("first seen")).toBe("2026-09-10");
    expect(evidence.get("last seen")).toBe("2026-09-16");
    // A prediction is not a measurement, and we have not measured one.
    expect(opportunitiesForProvider(feed(), provider.id)[0]!.contract.estimatedImpact).toBeNull();
  });
});

describe("step 4 — supply arrives, and the opportunity answers", () => {
  it("a partial fix keeps the opportunity and shrinks what is left to do", () => {
    const listing = store.allListings()[0]!;
    const cut = store.saveListing(listing.id, { ...draftFromExperience(listing), priceRupees: "700" });
    expect(cut.ok).toBe(true);

    const records = feed();
    const still = opportunitiesForProvider(records, provider.id);
    expect(still).toHaveLength(1);
    // Price is answered. The access need and the notice requirement are not.
    expect(still[0]!.targetBlockers).toEqual([
      "not_stroller_ok",
      "requires_booking_not_available",
      "lead_time_too_short",
    ]);
    expect(still[0]!.servedBy).toEqual([]);
  });

  it("finishing the fix empties the provider's feed and closes the gap", () => {
    const listing = store.allListings()[0]!;
    const fixed = store.saveListing(listing.id, {
      ...draftFromExperience(listing),
      strollerOk: "yes",
      requiresBooking: false,
      walkIn: true,
    });
    expect(fixed.ok).toBe(true);

    const records = feed();
    // The work is gone from the feed. Not hidden behind a filter: absent.
    expect(opportunitiesForProvider(records, provider.id)).toEqual([]);
    // And it is gone from the acquisition list, because supply now answers it.
    expect(acquisitionGaps(records)).toEqual([]);
    // Every record left is the provider being told the loop closed.
    expect(records).toHaveLength(1);
    const met = opportunitiesForProvider(records, provider.id, { includeMet: true })[0]!;
    expect(met.status).toBe("met");
    expect(met.targetListingId).toBe(store.allListings()[0]!.id);
    expect(met.servedBy).toEqual([store.allListings()[0]!.id]);
    expect(met.contract.headline).toContain("now serves this");
    expect(met.contract.cta).toContain("Nothing to do");
  });

  it("and the same seven searches, re-run against the new supply, now find something", () => {
    // The loop, closed from the traveller's side: the same requests, the same
    // catalogue plus the provider's fixed listing, and the search is satisfied.
    // This is the only proof that the opportunity was worth acting on.
    const supply = [...catalogue, ...store.allListings()];
    const after = requests.map((request) => searchTraveller(request, supply));
    expect(after.every((outcome) => outcome.passed.length > 0)).toBe(true);
    expect(after.filter((outcome) => outcome.demand !== null)).toEqual([]);
  });

  it("detection is a pure function of its inputs", () => {
    const supply = [...catalogue, ...store.allListings()];
    const options = { asOf: AS_OF, providers: [provider], datasetLabel: "content/experiences + real searches" } as const;
    expect(JSON.stringify(detectOpportunities(gaps, supply, options))).toBe(
      JSON.stringify(detectOpportunities(gaps, supply, options)),
    );
  });
});
