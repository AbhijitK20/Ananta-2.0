import { describe, expect, it } from "vitest";
import { Experience } from "../../contracts";
import { DEMO_LISTING_DRAFTS, DEMO_TODAY, demoState } from "./demo";
import {
  buildExperience,
  CATEGORY_OPTIONS,
  draftFromExperience,
  EMPTY_DRAFT,
  type ListingDraft,
  minorToRupees,
  rupeesToMinor,
  validateListing,
} from "./listing";

const validDraft = (patch: Partial<ListingDraft> = {}): ListingDraft => ({
  ...EMPTY_DRAFT,
  name: "Block Print Studio Session",
  category: "craft_workshop",
  lat: "18.9335",
  lon: "72.8345",
  neighbourhood: "Fort",
  durationMin: "120",
  priceRupees: "450",
  capacity: "8",
  ...patch,
});

const build = (draft: ListingDraft) =>
  buildExperience(draft, { id: "exp-test", providerId: "prov-1", today: DEMO_TODAY });

describe("money", () => {
  it("keeps paise as integers and round-trips", () => {
    expect(rupeesToMinor("450")).toBe(45000);
    expect(rupeesToMinor("450.50")).toBe(45050);
    expect(minorToRupees(45050)).toBe("450.50");
  });

  it("rejects anything we cannot round-trip", () => {
    expect(rupeesToMinor("")).toBeNull();
    expect(rupeesToMinor("450.555")).toBeNull();
    expect(rupeesToMinor("-1")).toBeNull();
    expect(rupeesToMinor("free")).toBeNull();
  });
});

describe("listing validation", () => {
  it("accepts a complete draft", () => {
    expect(validateListing(validDraft())).toEqual({});
  });

  it("rejects the fields a traveller depends on", () => {
    const errors = validateListing(
      validDraft({ name: "x", category: "", lat: "999", lon: "", durationMin: "0", neighbourhood: "" }),
    );
    expect(errors.name).toBeTruthy();
    expect(errors.category).toBeTruthy();
    expect(errors.lat).toBeTruthy();
    expect(errors.lon).toBeTruthy();
    expect(errors.durationMin).toBeTruthy();
    expect(errors.neighbourhood).toBeTruthy();
  });

  it("rejects a category that is not on the contract enum", () => {
    expect(validateListing(validDraft({ category: "yoga_retreat" })).category).toBeTruthy();
    expect(CATEGORY_OPTIONS).toContain("craft_workshop");
  });

  it("rejects zero capacity but allows unlimited", () => {
    expect(validateListing(validDraft({ capacity: "0" })).capacity).toBeTruthy();
    expect(validateListing(validDraft({ capacity: "-3" })).capacity).toBeTruthy();
    expect(validateListing(validDraft({ capacity: "" })).capacity).toBeUndefined();
  });

  it("rejects a price it cannot store as paise", () => {
    expect(validateListing(validDraft({ priceRupees: "450.555" })).priceRupees).toBeTruthy();
    expect(validateListing(validDraft({ priceRupees: "" })).priceRupees).toBeUndefined();
  });

  it("rejects a rating with no review behind it", () => {
    const errors = validateListing(validDraft({ ratingValue: "4.8", ratingCount: "" }));
    expect(errors.ratingCount).toBeTruthy();
  });

  it("wants OSM-shaped opening hours", () => {
    expect(validateListing(validDraft({ hoursRaw: "9am to 7pm" })).hoursRaw).toBeTruthy();
    expect(validateListing(validDraft({ hoursRaw: "Mo-Su 09:00-19:00" })).hoursRaw).toBeUndefined();
    expect(validateListing(validDraft({ hoursRaw: "Mo-Su 19:00-09:00" })).hoursRaw).toBeTruthy();
  });

  it("does not demand a neighbourhood when editing an existing listing", () => {
    const existing = build(validDraft());
    expect(validateListing({ ...validDraft({ neighbourhood: "" }) }, existing).neighbourhood).toBeUndefined();
  });
});

describe("building a listing", () => {
  it("produces a contract-valid Experience", () => {
    const experience = build(validDraft());
    expect(() => Experience.parse(experience)).not.toThrow();
    expect(experience.pricePerPerson?.minor).toBe(45000);
    expect(experience.capacity).toBe(8);
    expect(experience.location).toEqual({ lat: 18.9335, lon: 72.8345 });
    expect(experience.rating).toEqual({ value: 0, count: 0, rawMean: null });
  });

  it("treats unanswered questions as inferred, never as false", () => {
    const experience = build(validDraft());
    expect(experience.kidFriendly).toBeNull();
    expect(experience.accessibility.hearingLoop).toBeNull();
    expect(experience.provenance.kidFriendly).toBe("inferred");
    expect(experience.provenance.name).toBe("provider");
  });

  it("marks provider hours partial and stamps them as checked today", () => {
    const experience = build(validDraft({ hoursRaw: "Tu-Su 11:00-19:00" }));
    expect(experience.hours.status).toBe("partial");
    expect(experience.hours.lastVerified).toBe(DEMO_TODAY);
    expect(build(validDraft()).hours.status).toBe("absent");
  });

  it("keeps null capacity as unlimited", () => {
    expect(build(validDraft({ capacity: "" })).capacity).toBeNull();
  });

  it("round-trips an edit without losing enrichment", () => {
    const original = build(validDraft());
    const enriched = Experience.parse({
      ...original,
      bestMonths: [11, 12, 1],
      perception: { landscape: ["workshop"], activities: ["carving"], atmosphere: ["quiet"] },
    });
    const redrafted = draftFromExperience(enriched);
    expect(redrafted.name).toBe(enriched.name);
    expect(redrafted.priceRupees).toBe("450.00");
    const rebuilt = buildExperience(redrafted, {
      id: enriched.id,
      providerId: "prov-1",
      today: DEMO_TODAY,
      existing: enriched,
    });
    expect(rebuilt.bestMonths).toEqual([11, 12, 1]);
    expect(rebuilt.perception.activities).toEqual(["carving"]);
    expect(rebuilt.provenance.name).toBe("provider");
  });
});

describe("demo data", () => {
  it("is contract-valid and deterministic", () => {
    const first = demoState();
    const second = demoState();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    for (const listing of first.listings) expect(() => Experience.parse(listing)).not.toThrow();
    expect(DEMO_LISTING_DRAFTS).toHaveLength(first.listings.length);
  });
});
