/**
 * Calendar awareness, measurement, action collapse, trend, and privacy.
 *
 * The headline `FEATURES.md` §10 writes for this feature is "Add a Thursday
 * 17:00 slot", so the first half of this file is about whether the engine can
 * actually say that: can it read the hour real searches happened at, can it tell
 * a bookable slot from a slot that merely exists, and does it stay quiet when the
 * fields pass but nothing is published.
 *
 * Fixtures here are hand-built rows, for the same reason as `engine.test.ts`: you
 * cannot test a counter by generating its input with the code under test.
 * `cycle.test.ts` runs the whole thing against real searches and the committed
 * catalogue.
 */
import { describe, expect, it } from "vitest";
import { Experience, Provider, UnmetDemand } from "../../contracts";
import { buildSlot, type AvailabilityBlock, type DatedSlot } from "../provider/availability";
import { buildExperience, EMPTY_DRAFT, type ListingDraft } from "../provider/listing";
import { toActions } from "./actions";
import { aggregateGaps, detectOpportunities, MIN_SEARCHES, opportunitiesForProvider, SUPPRESS_BELOW } from "./engine";
import { measureGap } from "./measure";
import { bookableDates, bucketOf, localMinutesOfDay, suggestSlot, usableSlots, verdictFor, type Calendar } from "./slots";

const TODAY = "2026-09-20";
const AS_OF = "2026-09-20T09:00:00.000Z";
const BANDRA = { lat: 19.0596, lon: 72.8392 };
/** The window that `aggregateGaps` reads, given AS_OF and the default 14 days. */
const WINDOW_START = "2026-09-06";

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

const listing = (id: string, providerId: string | null, over: Partial<ListingDraft> = {}) =>
  Experience.parse({
    ...buildExperience(
      {
        ...EMPTY_DRAFT,
        name: "Kiln bench",
        category: "craft_workshop",
        // The draft holds raw form strings, so a number here is a type error the
        // provider feature's own validation would have caught.
        lat: String(BANDRA.lat),
        lon: String(BANDRA.lon),
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

/** Fort is 14 km from Bandra, so a cell there needs its own listing to act on. */
const FORT = { lat: 18.9355, lon: 72.8355 };
const fortListing = (id: string, providerId: string | null, over: Partial<ListingDraft> = {}) =>
  listing(id, providerId, { lat: String(FORT.lat), lon: String(FORT.lon), neighbourhood: "Fort", ...over });

/** 05:30Z is 11:00 in Mumbai, which is the hour these searches happen. */
const at = (day: string, hourUtc: number, minute = 30): string =>
  `${day}T${String(hourUtc).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

const baseConstraints = {
  availableMin: 180,
  budgetMinor: 300000,
  partySize: 4,
  accessNeeds: [] as UnmetDemand["constraints"]["accessNeeds"],
  interests: ["pottery"],
  weather: "clear",
};

const row = (over: Partial<UnmetDemand> = {}): UnmetDemand =>
  UnmetDemand.parse({
    id: "ud-seed",
    travellerId: "t01",
    point: { lat: BANDRA.lat, lon: BANDRA.lon },
    neighbourhood: "Bandra",
    at: at("2026-09-17", 5),
    constraints: baseConstraints,
    shortfallCount: 0,
    topBlockingCode: "over_budget",
    topBlockingCount: 3,
    ...over,
  });

/** n searches from n different accounts, so the cell clears the traveller bar. */
const many = (n: number, over: Partial<UnmetDemand> = {}): UnmetDemand[] =>
  Array.from({ length: n }, (_unused, i) =>
    row({ id: `ud-${String(i).padStart(2, "0")}`, travellerId: `t${String(i).padStart(2, "0")}`, ...over }),
  );

const cheap = (over: Partial<ListingDraft> = {}) => listing("exp-1", provider.id, { priceRupees: "500", ...over });

const slotFor = (experienceId: string, date: string, start: string, end: string, capacity = 8, index = 0): DatedSlot =>
  buildSlot({ experienceId, date, start, end, capacity: String(capacity) }, { today: TODAY, experience: undefined, slots: [], blocks: [] }, `slot-${index}`);

const emptyCalendar: Calendar = { slots: [], blocks: [], bookings: [], horizonDays: 14 };
const withSlots = (slots: DatedSlot[]): Calendar => ({ ...emptyCalendar, slots });

const detect = (gaps: ReturnType<typeof aggregateGaps>, catalogue: Experience[], supply?: Calendar) =>
  detectOpportunities(gaps, catalogue, {
    asOf: AS_OF,
    providers: [provider],
    datasetLabel: "test log",
    ...(supply === undefined ? {} : { supply }),
  });

function evidence(record: { contract: { evidence: { label: string; value: string }[] } }, label: string): string | undefined {
  return record.contract.evidence.find((row) => row.label === label)?.value;
}

describe("reading the hour real searches happened at", () => {
  it("converts a logged UTC timestamp to the local clock", () => {
    // Mumbai is UTC+5:30, so 05:30Z is 11:00 local, not 11:30.
    expect(localMinutesOfDay("2026-09-17T05:30:00.000Z")).toBe(11 * 60);
    // 20:00Z is the small hours the next morning in Mumbai, not 8pm.
    expect(localMinutesOfDay("2026-09-17T20:00:00.000Z")).toBe(90);
  });

  it("buckets a day into the contract's own five parts, each minute in exactly one", () => {
    expect(bucketOf(0)).toBe("night");
    expect(bucketOf(300)).toBe("early_morning");
    expect(bucketOf(600)).toBe("morning");
    expect(bucketOf(900)).toBe("afternoon");
    expect(bucketOf(1100)).toBe("evening");
    expect(bucketOf(1300)).toBe("night");
    expect(new Set(Array.from({ length: 1440 }, (_u, m) => bucketOf(m))).size).toBe(5);
  });

  it("reports the modal quarter-hour when the cell agrees on one", () => {
    const gap = aggregateGaps(many(MIN_SEARCHES), { asOf: AS_OF })[0]!;
    expect(gap.hourMin).toBe(11 * 60);
    expect(gap.hourBucket).toBe("morning");
  });

  it("refuses to invent a time from a split, rather than opening at an hour nobody came for", () => {
    // Two each at three different hours: no half agrees, so no time advice.
    const split = aggregateGaps(
      [
        ...many(2, { id: "a1", travellerId: "a1" }),
        ...many(2, { id: "b1", travellerId: "b1", at: at("2026-09-17", 9, 15) }),
        ...many(2, { id: "c1", travellerId: "c1", at: at("2026-09-17", 14, 5) }),
      ],
      { asOf: AS_OF },
    )[0]!;
    expect(split.hourMin).toBeNull();
    expect(split.hourBucket).toBeNull();
  });
});

describe("what counts as bookable", () => {
  const hours = listing("exp-h", provider.id, { priceRupees: "500" });
  const window = { arriveMin: 11 * 60, availableMin: 180, partySize: 4 };
  const one = (over: Partial<Calendar> = {}): Calendar => ({
    slots: [slotFor("exp-h", "2026-09-21", "11:00", "12:30")],
    blocks: [],
    bookings: [],
    horizonDays: 14,
    ...over,
  });

  it("serves a search when a slot covers it, with room for the whole party", () => {
    expect(usableSlots(hours, one(), TODAY, window)).toHaveLength(1);
  });

  it("does not count a slot the party has walked most of", () => {
    expect(usableSlots(hours, one(), TODAY, { ...window, arriveMin: 11 * 60 + 45 })).toEqual([]);
  });

  it("does not count a slot that starts after they had to leave", () => {
    // The bug this gate exists for: a 19:00 slot is not bookable by someone who
    // searched at 11:00 with three hours left, however free it is.
    const late = withSlots([slotFor("exp-h", "2026-09-21", "19:00", "20:00")]);
    expect(usableSlots(hours, late, TODAY, window)).toEqual([]);
  });

  it("does not count a slot with fewer seats than the party", () => {
    expect(usableSlots(hours, one({ slots: [slotFor("exp-h", "2026-09-21", "11:00", "12:30", 2)] }), TODAY, window)).toEqual([]);
  });

  it("does not count a slot the provider blocked out", () => {
    const blocks: AvailabilityBlock[] = [
      { id: "blk-1", experienceId: "exp-h", date: "2026-09-21", startMin: 600, endMin: 900, reason: "kiln firing" },
    ];
    expect(usableSlots(hours, one({ blocks }), TODAY, window)).toEqual([]);
  });

  it("does not count a slot in the past or past the horizon", () => {
    expect(usableSlots(hours, one({ slots: [slotFor("exp-h", "2026-09-19", "11:00", "12:30")] }), TODAY, window)).toEqual([]);
    expect(usableSlots(hours, one({ slots: [slotFor("exp-h", "2027-01-04", "11:00", "12:30")] }), TODAY, window)).toEqual([]);
  });

  it("does not count a slot whose seats are already committed", () => {
    // Capacity is derived, not counted, and `deriveAvailability` owns that rule:
    // 4 confirmed against a capacity of 4 leaves nothing, whatever the draft says.
    const booked = one({
      slots: [slotFor("exp-h", "2026-09-21", "11:00", "12:30", 4)],
      bookings: [{ slotId: "slot-0", partySize: 4, state: "confirmed" }],
    });
    expect(usableSlots(hours, booked, TODAY, window)).toEqual([]);
  });

  it("still counts a slot that has room, however many seats are already gone", () => {
    const partlyBooked = one({ bookings: [{ slotId: "slot-0", partySize: 2, state: "confirmed" }] });
    expect(usableSlots(hours, partlyBooked, TODAY, window)).toHaveLength(1);
  });

  it("picks the first bookable day, skipping one already taken at that window", () => {
    expect(suggestSlot(hours, window, TODAY, emptyCalendar)).toMatchObject({
      date: "2026-09-20",
      startMin: 11 * 60,
      endMin: 12 * 60,
      bucket: "morning",
    });
    const taken = withSlots([slotFor("exp-h", "2026-09-20", "11:00", "12:00")]);
    expect(suggestSlot(hours, window, TODAY, taken)?.date).toBe("2026-09-21");
  });

  it("rounds down to a quarter hour, because nobody opens a kiln at 11:07", () => {
    expect(suggestSlot(hours, { ...window, arriveMin: 11 * 60 + 7 }, TODAY, emptyCalendar)?.startMin).toBe(11 * 60);
    expect(suggestSlot(hours, { ...window, arriveMin: 11 * 60 + 23 }, TODAY, emptyCalendar)?.startMin).toBe(11 * 60 + 15);
  });

  it("suggests nothing when the experience outlasts the time the demand had", () => {
    // A slot cannot fix a listing that is too long. That is a duration problem,
    // and recommending a window here would be advice the provider cannot act on.
    const long = listing("exp-long", provider.id, { durationMin: "400" });
    expect(suggestSlot(long, window, TODAY, emptyCalendar)).toBeNull();
  });

  it("has a bounded, ordered list of bookable dates", () => {
    expect(bookableDates(TODAY, 3)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"]);
  });

  it("splits the calendar into served, mismatched and unusable without double counting", () => {
    const mixed: Calendar = {
      slots: [
        slotFor("exp-h", "2026-09-21", "11:00", "12:30", 8, 0), // usable
        slotFor("exp-h", "2026-09-22", "19:00", "20:30", 8, 1), // wrong hour
        slotFor("exp-h", "2026-09-23", "11:00", "12:30", 1, 2), // too small
        slotFor("exp-h", "2026-09-10", "11:00", "12:30", 8, 3), // past
      ],
      blocks: [],
      bookings: [],
      horizonDays: 14,
    };
    const verdict = verdictFor(hours, mixed, TODAY, window);
    expect(verdict.published).toBe(4);
    expect(verdict.served).toBe(true);
    expect(verdict.unusable).toBe(1);
    expect(verdict.mismatched).toBe(2);
  });
});

describe("the spec's own headline: add a slot", () => {
  const gaps = aggregateGaps(many(MIN_SEARCHES), { asOf: AS_OF });
  const mine = cheap();

  it("stays quiet when no calendar was supplied, rather than guessing", () => {
    const records = detect(gaps, [mine]);
    expect(records[0]!.missingSupply.field).toBe("pricePerPerson");
  });

  it("reports a calendar gap once the fields pass, with a concrete window", () => {
    const record = opportunitiesForProvider(detect(gaps, [mine], emptyCalendar), provider.id)[0]!;
    expect(record.missingSupply).toEqual({ code: "over_budget", field: "slots", label: "a bookable slot" });
    expect(record.kind).toBe("capacity_window");
    expect(record.suggestedSlot).toMatchObject({ startMin: 11 * 60, endMin: 12 * 60, bucket: "morning" });
    expect(record.targetBlockers).toEqual([]);
    expect(record.contract.headline).toContain("Add a 11:00 to 12:00 slot");
    expect(record.contract.headline).toContain("you publish nothing they can book around 11:00");
    expect(record.contract.cta).toBe("Add a slot to Kiln bench: add a 11:00 to 12:00 slot on 2026-09-20.");
  });

  it("names the calendar honestly: nothing published, versus published at the wrong hour", () => {
    const nothing = opportunitiesForProvider(detect(gaps, [mine], emptyCalendar), provider.id)[0]!;
    expect(evidence(nothing, "your bookable calendar for Kiln bench")).toBe("nothing published at all");

    const wrongHour = opportunitiesForProvider(
      detect(gaps, [mine], withSlots([slotFor("exp-1", "2026-09-21", "19:00", "20:00")])),
      provider.id,
    )[0]!;
    expect(evidence(wrongHour, "your bookable calendar for Kiln bench")).toContain("none bookable at that hour");
  });

  it("closes the moment a bookable slot exists, and says the work is done", () => {
    const records = detect(gaps, [mine], withSlots([slotFor("exp-1", "2026-09-21", "11:00", "12:00")]));
    expect(opportunitiesForProvider(records, provider.id)).toEqual([]);
    const met = opportunitiesForProvider(records, provider.id, { includeMet: true })[0]!;
    expect(met.status).toBe("met");
    expect(met.servedBy).toEqual(["exp-1"]);
    expect(met.contract.headline).toContain("now serves this");
  });

  it("stays silent about slots when the cell has no time pattern to act on", () => {
    const split = aggregateGaps(
      [
        ...many(2, { id: "a1", travellerId: "a1" }),
        ...many(2, { id: "b1", travellerId: "b1", at: at("2026-09-17", 9, 15) }),
        ...many(2, { id: "c1", travellerId: "c1", at: at("2026-09-17", 14, 5) }),
      ],
      { asOf: AS_OF },
    );
    // The listing is dear, so the fix is a price, and with no agreed hour there
    // is no honest slot advice to give alongside it.
    const dear = listing("exp-1", provider.id, { priceRupees: "2500" });
    const record = opportunitiesForProvider(detect(split, [dear], emptyCalendar), provider.id)[0]!;
    expect(record.missingSupply.field).toBe("pricePerPerson");
    expect(record.suggestedSlot).toBeNull();
  });

  it("prefers the cheap field fix when both the fields and the calendar are wrong", () => {
    // Two records for one listing is a to-do list, and to-do lists get ignored.
    const dear = listing("exp-1", provider.id, { priceRupees: "2500" });
    const records = detect(gaps, [dear], emptyCalendar);
    expect(records).toHaveLength(1);
    expect(records[0]!.missingSupply.field).toBe("pricePerPerson");
  });
});

describe("measuring instead of predicting", () => {
  const rows = many(MIN_SEARCHES);
  const gaps = aggregateGaps(rows, { asOf: AS_OF });
  const base = { asOf: AS_OF, radiusKm: 2, category: "craft_workshop" as const };

  it("reports nothing measured when nothing would be served", () => {
    const result = measureGap(rows, [listing("exp-1", provider.id)], base);
    expect(result.total).toBe(MIN_SEARCHES);
    expect(result.satisfied).toBe(0);
    expect(result.estimatedImpact).toBeNull();
  });

  it("replays real rows against real supply and counts what would now book", () => {
    const result = measureGap(rows, [cheap()], { ...base, targetListingId: "exp-1" });
    expect(result.satisfied).toBe(MIN_SEARCHES);
    expect(result.byTarget).toBe(MIN_SEARCHES);
    expect(result.estimatedImpact).toContain(`${MIN_SEARCHES} of the ${MIN_SEARCHES} logged searches`);
    expect(result.estimatedImpact).toContain("Measured by re-running");
  });

  it("counts a listing as unserving when it passes the fields but has no slot", () => {
    const result = measureGap(rows, [cheap()], { ...base, calendar: emptyCalendar });
    expect(result.satisfied).toBe(0);
  });

  it("credits the target only for the searches it alone would have served", () => {
    // Two listings can each serve. The dashboard must not claim both.
    const result = measureGap(rows, [cheap(), listing("exp-2", provider.id, { priceRupees: "500" })], {
      ...base,
      targetListingId: "exp-2",
    });
    expect(result.satisfied).toBe(MIN_SEARCHES);
    // `exp-1` sorts first, so it is the one that would have taken every booking.
    expect(result.byTarget).toBe(0);
  });

  it("fills the contract field on a served gap, and leaves it null on an open one", () => {
    const open = detectOpportunities(gaps, [listing("exp-1", provider.id, { priceRupees: "2500" })], {
      asOf: AS_OF,
      providers: [provider],
      unmetDemand: rows,
    });
    // Nothing has been acted on, so there is nothing measured to report. A number
    // here would be a prediction wearing a measurement's clothes.
    expect(open[0]!.contract.estimatedImpact).toBeNull();

    const served = detectOpportunities(gaps, [cheap()], {
      asOf: AS_OF,
      providers: [provider],
      unmetDemand: rows,
      supply: withSlots([slotFor("exp-1", "2026-09-21", "11:00", "12:00")]),
    });
    const met = opportunitiesForProvider(served, provider.id, { includeMet: true })[0]!;
    expect(met.contract.estimatedImpact).toContain("would now find something bookable");
  });

  it("stays null when the caller supplied no rows to replay", () => {
    const records = detect(gaps, [listing("exp-1", provider.id, { priceRupees: "2500" })]);
    expect(records[0]!.contract.estimatedImpact).toBeNull();
    expect(records[0]!.measurement).toBeNull();
  });
});

describe("the action a provider actually works from", () => {
  /**
   * Six in Bandra and six in Fort. Six, not three: a cell needs MIN_SEARCHES
   * before anything is actionable, so a three-per-area fixture builds two real
   * cells that are correctly ignored.
   */
  const twoAreas = (): UnmetDemand[] => {
    const bandra = many(6);
    const fort = many(6).map((r, i) =>
      row({
        ...r,
        id: `f-${i}`,
        travellerId: `f-${i}`,
        neighbourhood: "Fort",
        point: FORT,
      }),
    );
    return [...bandra, ...fort];
  };

  /** One listing per area, both too expensive for the demand in their own area. */
  const bothAreas = (): Experience[] => [
    listing("exp-1", provider.id, { priceRupees: "2500" }),
    fortListing("exp-2", provider.id, { priceRupees: "2500" }),
  ];

  it("collapses the same change wanted in two areas into one action", () => {
    const rows = twoAreas();
    const gaps = aggregateGaps(rows, { asOf: AS_OF });
    const records = detect(gaps, bothAreas(), emptyCalendar);
    expect(records).toHaveLength(2);
    const actions = toActions(records);
    // Two cells, one provider, two listings, one field. Two actions, because
    // editing Bandra's price does nothing for Fort's.
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.neighbourhoods)).toEqual([["Bandra"], ["Fort"]]);
    expect(actions.every((action) => action.field === "pricePerPerson")).toBe(true);
    const fortAction = actions[1]!;
    expect(fortAction.targetListingId).toBe("exp-2");
    expect(fortAction.searches).toBe(6);
    expect(fortAction.travellers).toBe(6);
  });

  it("collapses many cells wanting one change on ONE listing into one action", () => {
    // The real case this layer exists for: one listing near a boundary, one price
    // edit, and two localities whose searches all want that same field changed.
    // Bandra West and Bandra East are ~1 km apart, so one listing is in range of
    // both. Fort is 14 km away and would be a different listing entirely.
    const rows = [
      ...many(6),
      ...many(6).map((r, i) =>
        row({ ...r, id: `e-${i}`, travellerId: `e-${i}`, neighbourhood: "Bandra East", point: { lat: 19.068, lon: 72.841 } }),
      ),
    ];
    const gaps = aggregateGaps(rows, { asOf: AS_OF });
    const shared = listing("exp-1", provider.id, { priceRupees: "2500" });
    const records = detect(gaps, [shared], emptyCalendar);
    expect(records).toHaveLength(2);
    const actions = toActions(records);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.field).toBe("pricePerPerson");
    expect(action.targetListingId).toBe("exp-1");
    expect(action.searches).toBe(12);
    expect(action.travellers).toBe(12);
    expect(action.neighbourhoods).toEqual(["Bandra", "Bandra East"]);
    expect(action.cellKeys).toHaveLength(2);
    expect(action.action).toBe("Add a ₹750 band to Kiln bench");
    expect(evidence2(action, "searches behind this one change")).toContain("12 across 2 areas");
  });

  it("carries the suggested window onto the action, so it is one click not two", () => {
    const gaps = aggregateGaps(many(MIN_SEARCHES), { asOf: AS_OF });
    const actions = toActions(detect(gaps, [cheap()], emptyCalendar));
    expect(actions[0]!.field).toBe("slots");
    expect(evidence2(actions[0]!, "suggested window")).toBe("11:00 to 12:00 on 2026-09-20");
  });

  it("never hands an acquisition gap to a provider as a to-do", () => {
    const gaps = aggregateGaps(many(MIN_SEARCHES), { asOf: AS_OF });
    const records = detect(gaps, [listing("exp-osm", null)], emptyCalendar);
    expect(records).toHaveLength(1);
    expect(records[0]!.providerId).toBeNull();
    expect(toActions(records)).toEqual([]);
  });

  it("drops met records, which are not work", () => {
    const gaps = aggregateGaps(many(MIN_SEARCHES), { asOf: AS_OF });
    const records = detect(gaps, [cheap()], withSlots([slotFor("exp-1", "2026-09-21", "11:00", "12:00")]));
    expect(records[0]!.status).toBe("met");
    expect(toActions(records)).toEqual([]);
  });

  it("carries no measured impact, because an open action has not happened yet", () => {
    const rows = twoAreas();
    const gaps = aggregateGaps(rows, { asOf: AS_OF });
    const records = detectOpportunities(gaps, [listing("exp-1", provider.id, { priceRupees: "2500" })], {
      asOf: AS_OF,
      providers: [provider],
      unmetDemand: rows,
      supply: emptyCalendar,
    });
    // Reporting a number here would be estimating the effect of a fix nobody has
    // made. The measurement lives on the `met` record instead.
    expect(toActions(records)[0]!.estimatedImpact).toBeNull();
  });

  it("keeps one action per listing, not one per listing per gap", () => {
    const rows = twoAreas();
    const gaps = aggregateGaps(rows, { asOf: AS_OF });
    const records = detect(
      gaps,
      [
        listing("exp-1", provider.id, { priceRupees: "2500" }),
        listing("exp-2", provider.id, { priceRupees: "2500" }),
        fortListing("exp-3", provider.id, { priceRupees: "2500" }),
      ],
      emptyCalendar,
    );
    // Three failing listings, two cells. Detection names ONE listing per cell —
    // the cheapest to fix — so three listings do not become three to-dos for the
    // same price edit. Fix exp-1 and the Bandra cell is answered.
    const actions = toActions(records);
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => action.field === "pricePerPerson")).toBe(true);
    expect(actions.map((action) => action.targetListingId).sort()).toEqual(["exp-1", "exp-3"]);
  });
});

describe("not identifying anyone", () => {
  it("rounds off the identifying detail on a thin cell and keeps it on a solid one", () => {
    // Enough searches to be actionable, few enough accounts to be a fingerprint.
    // That combination is exactly the one FEATURES §10 asks us to catch.
    const thin = aggregateGaps(many(7, { travellerId: "one" }).map((r, i) => ({ ...r, travellerId: `p${i % 2}` })), { asOf: AS_OF })[0]!;
    expect(thin.searches).toBe(MIN_SEARCHES + 2);
    expect(thin.travellers).toBe(2);
    expect(thin.travellers).toBeLessThan(SUPPRESS_BELOW);
    expect(thin.detail).toBe("coarse");

    const solid = aggregateGaps(many(SUPPRESS_BELOW + 2), { asOf: AS_OF })[0]!;
    expect(solid.detail).toBe("exact");
  });

  it("says the exact hour is withheld, rather than quietly dropping the evidence", () => {
    const thin = aggregateGaps(
      many(7).map((r, i) => ({ ...r, travellerId: `p${i % 2}` })),
      { asOf: AS_OF },
    )[0]!;
    const record = detect([thin], [listing("exp-1", provider.id, { priceRupees: "2500" })])[0]!;
    expect(evidence(record, "exact dates and times")).toContain("withheld");
    expect(evidence(record, "first seen")).toBeUndefined();
    // The demand is still counted. Coarsening the fingerprint is not hiding it.
    expect(evidence(record, "searches")).toContain(String(thin.searches));
    expect(evidence(record, "time of day")).toContain("morning");
    expect(evidence(record, "time of day")).not.toContain("11:00");
  });

  it("keeps the hour on a solid cell, because that is the actionable part", () => {
    const solid = aggregateGaps(many(SUPPRESS_BELOW + 2), { asOf: AS_OF })[0]!;
    const record = detect([solid], [listing("exp-1", provider.id, { priceRupees: "2500" })])[0]!;
    expect(evidence(record, "time of day they searched")).toContain("11:00");
  });
});

describe("trend", () => {
  it("compares against the window before, not against nothing", () => {
    // `2026-08-30` is inside the previous 14-day window, not the current one.
    const older = (n: number): UnmetDemand[] =>
      Array.from({ length: n }, (_u, i) => row({ id: `old-${i}`, travellerId: `old-${i}`, at: at("2026-08-30", 5) }));

    const rising = aggregateGaps([...many(MIN_SEARCHES), ...older(2)], { asOf: AS_OF })[0]!;
    expect(rising.previousSearches).toBe(2);
    expect(rising.trend).toBe("rising");

    expect(aggregateGaps([...many(5), ...older(5)], { asOf: AS_OF })[0]!.trend).toBe("flat");
    expect(aggregateGaps([...many(3), ...older(9)], { asOf: AS_OF })[0]!.trend).toBe("falling");
  });

  it("ignores anything older than two windows", () => {
    const ancient = row({ id: "ancient", travellerId: "ancient", at: at("2026-07-01", 5) });
    const gap = aggregateGaps([...many(MIN_SEARCHES), ancient], { asOf: AS_OF })[0]!;
    expect(gap.searches).toBe(MIN_SEARCHES);
    expect(gap.previousSearches).toBe(0);
    expect(Date.parse(WINDOW_START)).toBeLessThan(Date.parse(gap.lastSeenAt));
  });

  it("says the comparison in the evidence, with both numbers", () => {
    const rows = [...many(MIN_SEARCHES), row({ id: "old", travellerId: "old", at: at("2026-08-30", 5) })];
    const record = detect(aggregateGaps(rows, { asOf: AS_OF }), [listing("exp-1", provider.id, { priceRupees: "2500" })])[0]!;
    expect(evidence(record, "versus the previous 14 days")).toBe(`${MIN_SEARCHES}, up from 1 (rising)`);
  });
});

function evidence2(action: { evidence: { label: string; value: string }[] }, label: string): string | undefined {
  return action.evidence.find((row) => row.label === label)?.value;
}
