import { describe, expect, it } from "vitest";
import { Slot } from "../../contracts";
import {
  type AvailabilityContext,
  buildSlot,
  deriveAvailability,
  type DatedSlot,
  EMPTY_SLOT_DRAFT,
  slotViews,
  validateSlotDraft,
} from "./availability";
import { createDemoStore, DEMO_TODAY, demoState } from "./demo";

const state = demoState();
const workshop = state.listings[0]!;
const walk = state.listings[1]!;

const ctx = (patch: Partial<AvailabilityContext> = {}): AvailabilityContext => ({
  today: DEMO_TODAY,
  experience: workshop,
  slots: [],
  blocks: [],
  ...patch,
});

const draft = (patch: Partial<typeof EMPTY_SLOT_DRAFT> = {}) => ({ ...EMPTY_SLOT_DRAFT, ...patch });

describe("slot validation", () => {
  it("accepts a slot that fits the listing", () => {
    const good = draft({ experienceId: workshop.id, date: "2026-02-20", start: "10:00", end: "12:00" });
    expect(validateSlotDraft(good, ctx())).toEqual({});
    const built = buildSlot(good, ctx(), "slot-x");
    expect(() => Slot.parse(built.slot)).not.toThrow();
    expect(built.slot.startMin).toBe(600);
    expect(built.slot.endMin).toBe(720);
    expect(built.slot.capacity).toBe(6);
  });

  it("refuses a window shorter than the experience", () => {
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-20" }), ctx()).end).toBe(
      "This window is 60 min but the experience needs 120 min.",
    );
    const errors = validateSlotDraft(
      draft({ experienceId: workshop.id, date: "2026-02-20", start: "10:00", end: "10:30" }),
      ctx(),
    );
    expect(errors.end).toBe("This window is 30 min but the experience needs 120 min.");
  });

  it("refuses a date in the past", () => {
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-13" }), ctx()).date).toBe(
      "That date has already passed. Publish a slot for today or later.",
    );
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: DEMO_TODAY }), ctx()).date).toBeUndefined();
  });

  it("refuses a malformed date and an impossible clock time", () => {
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "20/02/2026" }), ctx()).date).toBeTruthy();
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-31" }), ctx()).date).toBeTruthy();
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-20", start: "25:00" }), ctx()).start).toBeTruthy();
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-20", end: "10:00" }), ctx()).end).toBe(
      "End time must be after the start time.",
    );
  });

  it("refuses zero or over-listed capacity", () => {
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-20", capacity: "0" }), ctx()).capacity).toBe(
      "Capacity must be a whole number of at least 1.",
    );
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-20", capacity: "20" }), ctx()).capacity).toBe(
      "Your listing seats at most 8, so a slot cannot hold 20.",
    );
  });

  it("refuses a window shorter than the experience", () => {
    const errors = validateSlotDraft(
      draft({ experienceId: workshop.id, date: "2026-02-20", start: "10:00", end: "10:30" }),
      ctx(),
    );
    expect(errors.end).toBe("This window is 30 min but the experience needs 120 min.");
  });
  it("refuses a duplicate and then a partial overlap", () => {
    const first = buildSlot(draft({ experienceId: workshop.id, date: "2026-02-20", start: "10:00", end: "12:00" }), ctx(), "slot-a");
    const withFirst = ctx({ slots: [first] });
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-20", start: "10:00", end: "12:00" }), withFirst).start).toBe(
      "You already published 10:00 to 12:00 on this date.",
    );
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-20", start: "11:00", end: "13:00" }), withFirst).start).toBe(
      "That overlaps the 10:00 to 12:00 slot on this date.",
    );
    // Abutting, not overlapping.
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-20", start: "12:00", end: "14:00" }), withFirst).start).toBeUndefined();
  });

  it("refuses a slot inside an unavailable window", () => {
    const withBlock = ctx({ blocks: state.blocks });
    expect(validateSlotDraft(draft({ experienceId: workshop.id, date: "2026-02-15", start: "13:30", end: "15:30" }), withBlock).start).toBe(
      "That falls inside an unavailable window (13:00 to 14:00).",
    );
  });
});

describe("derived availability", () => {
  const slot = (over: Partial<Slot> = {}): Slot =>
    Slot.parse({
      id: "slot-t",
      providerId: "prov-1",
      experienceId: workshop.id,
      startMin: 600,
      endMin: 720,
      capacity: 8,
      pricePerPerson: workshop.pricePerPerson!,
      held: { pendingOrders: 0, confirmedOrders: 0, carts: 0 },
      status: "ok",
      ...over,
    });

  it("is ok when nothing is booked", () => {
    const availability = deriveAvailability(slot(), []);
    expect(availability).toMatchObject({ status: "ok", remaining: 8 });
    expect(availability.derivedFrom).toContain("capacity:8");
  });

  it("holds nothing for a pending request, so confirming visibly moves the number", () => {
    const pending = deriveAvailability(slot(), [{ slotId: "slot-t", partySize: 3, state: "requested" }]);
    expect(pending.remaining).toBe(8);
    expect(pending.status).toBe("reserved");
    const confirmed = deriveAvailability(slot(), [{ slotId: "slot-t", partySize: 3, state: "confirmed" }]);
    expect(confirmed.remaining).toBe(5);
    expect(confirmed.status).toBe("ordered");
  });

  it("counts carts and never reports a negative remainder", () => {
    expect(deriveAvailability(slot(), []).remaining).toBe(8);
    const oversold = deriveAvailability(slot({ capacity: 2 }), [{ slotId: "slot-t", partySize: 5, state: "confirmed" }]);
    expect(oversold.remaining).toBe(0);
    expect(oversold.status).toBe("gone");
  });

  it("ignores bookings on other slots", () => {
    const other = [{ slotId: "slot-other", partySize: 4, state: "confirmed" }];
    expect(deriveAvailability(slot(), other).remaining).toBe(8);
  });

  it("flags a slot covered by an unavailable window", () => {
    const dated: DatedSlot = { date: "2026-02-15", slot: slot({ startMin: 720, endMin: 900 }) };
    const [view] = slotViews([dated], state.blocks, state.bookings);
    expect(view?.blockedBy?.reason).toBe("Studio closed for lunch");
  });
});

describe("the store's availability", () => {
  it("rejects a bad slot without writing it", () => {
    const store = createDemoStore();
    const before = store.availability().length;
    const result = store.addSlot({ experienceId: workshop.id, date: "2026-02-01", start: "10:00", end: "12:00", capacity: "6" });
    expect(result.ok).toBe(false);
    expect(store.availability()).toHaveLength(before);
  });

  it("publishes a good slot and lists it by date", () => {
    const store = createDemoStore();
    const result = store.addSlot({ experienceId: walk.id, date: "2026-02-21", start: "07:00", end: "08:30", capacity: "12" });
    expect(result.ok).toBe(true);
    const views = store.availability(walk.id);
    expect(views.map((view) => view.dated.date)).toEqual(["2026-02-15", "2026-02-21"]);
  });

  it("adds an unavailable window and then refuses slots inside it", () => {
    const store = createDemoStore();
    const block = store.addBlock({ experienceId: walk.id, date: "2026-02-22", start: "07:00", end: "10:00", reason: "Puffin colony" });
    expect(block.ok).toBe(true);
    const clash = store.addSlot({ experienceId: walk.id, date: "2026-02-22", start: "08:00", end: "09:00", capacity: "4" });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.start).toContain("unavailable window");
  });
});
