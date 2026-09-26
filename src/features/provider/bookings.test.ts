import { describe, expect, it } from "vitest";
import { BookingRequest, BOOKING_TRANSITIONS, type BookingState } from "../../contracts";
import { applyTransition, canTransition, confirmDecision, declineDecision } from "./bookings";
import { deriveAvailability } from "./availability";
import { createDemoStore, DEMO_TODAY, demoState } from "./demo";
import { draftFromExperience } from "./listing";
import { ProviderStore } from "./store";

const remaining = (store: ProviderStore, slotId: string): number =>
  store.availability().find((view) => view.dated.slot.id === slotId)?.availability.remaining ?? -1;

const state = demoState();
const today = DEMO_TODAY;

const contextFor = (store: ProviderStore, requestId: string) => {
  const request = store.snapshot().bookings.find((entry) => entry.id === requestId)!;
  const slot = store.availability().find((view) => view.dated.slot.id === request.slotId)?.dated;
  return {
    request,
    slot,
    blocks: store.snapshot().blocks,
    today,
    remaining: slot ? deriveAvailability(slot.slot, store.snapshot().bookings).remaining : 0,
  };
};

describe("the frozen transition table", () => {
  it("is the only state machine in the feature", () => {
    expect(BOOKING_TRANSITIONS.requested).toEqual(["confirmed", "declined", "cancelled"]);
    expect(BOOKING_TRANSITIONS.declined).toEqual([]);
    expect(canTransition("requested", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "confirmed")).toBe(false);
  });

  it("rejects every move the table does not list", () => {
    const states: BookingState[] = ["requested", "confirmed", "declined", "cancelled", "completed"];
    for (const from of states) {
      for (const to of states) {
        const allowed = BOOKING_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(allowed);
      }
    }
  });

  it("records who moved it, when, and why", () => {
    const request = state.bookings.find((entry) => entry.state === "requested")!;
    const moved = applyTransition(request, "confirmed", { by: "prov-1", at: "2026-02-14T10:00:00.000Z" });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const parsed = BookingRequest.parse(moved.value);
    expect(parsed.state).toBe("confirmed");
    expect(parsed.travellerNotifiedAt).toBe("2026-02-14T10:00:00.000Z");
    expect(parsed.history.at(-1)).toMatchObject({ from: "requested", to: "confirmed", by: "prov-1" });
  });

  it("refuses an illegal move before it reaches the history", () => {
    const declined = state.bookings.find((entry) => entry.state === "declined")!;
    const moved = applyTransition(declined, "confirmed", { by: "prov-1", at: "2026-02-14T10:00:00.000Z" });
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe("invalid_transition");
    expect(declined.history).toHaveLength(1);
  });
});

describe("confirming", () => {
  it("decrements the remaining capacity by the party size", () => {
    const store = createDemoStore();
    expect(remaining(store, "slot-2")).toBe(8);
    const result = store.confirm("req-2");
    expect(result.ok).toBe(true);
    expect(remaining(store, "slot-2")).toBe(5);
    expect(store.requests().find((view) => view.request.id === "req-2")?.request.state).toBe("confirmed");
  });

  it("never goes negative and never overbooks", () => {
    const store = createDemoStore();
    store.confirm("req-2");
    const refused = store.confirm("req-3");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("insufficient_capacity");
    expect(refused.error.message).toBe("Only 5 of 8 places are left, and this request is for 6.");
    expect(remaining(store, "slot-2")).toBe(5);
  });

  it("refuses a second confirmation of the same request", () => {
    const store = createDemoStore();
    const first = store.confirm("req-1");
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe("invalid_transition");
    expect(remaining(store, "slot-1")).toBe(4);
  });

  it("refuses a slot that has already passed", () => {
    const store = createDemoStore();
    const decision = confirmDecision(contextFor(store, "req-7"));
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("slot_past");
    expect(store.confirm("req-7").ok).toBe(false);
  });

  it("refuses a slot that became unavailable after it was published", () => {
    const store = createDemoStore();
    const published = store.addSlot({ experienceId: "exp-1", date: "2026-02-20", start: "10:00", end: "12:00", capacity: "6" });
    expect(published.ok).toBe(true);
    store.addBlock({ experienceId: "exp-1", date: "2026-02-20", start: "09:00", end: "13:00", reason: "Studio closed" });
    const slot = store.availability("exp-1").at(-1)?.dated;
    const decision = confirmDecision({
      request: BookingRequest.parse({
        id: "req-x",
        slotId: slot!.slot.id,
        experienceId: "exp-1",
        travellerName: "Test Traveller",
        travellerContact: "t@example.com",
        partySize: 2,
        state: "requested",
        createdAt: "2026-02-14T09:00:00.000Z",
      }),
      slot,
      blocks: store.snapshot().blocks,
      today,
      remaining: 6,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("unavailable");
  });

  it("refuses an unknown request", () => {
    const store = createDemoStore();
    const result = store.confirm("req-nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
  });
});

describe("declining", () => {
  it("leaves capacity untouched and records the reason", () => {
    const store = createDemoStore();
    const before = remaining(store, "slot-2");
    const result = store.decline("req-3", "The press is booked that afternoon.");
    expect(result.ok).toBe(true);
    expect(remaining(store, "slot-2")).toBe(before);
    const declined = store.requests().find((view) => view.request.id === "req-3")?.request;
    expect(declined?.state).toBe("declined");
    expect(declined?.declineReason).toBe("The press is booked that afternoon.");
    expect(declined?.travellerNotifiedAt).toBeTruthy();
  });

  it("refuses a decline with no reason, because the traveller is told", () => {
    const store = createDemoStore();
    const result = store.decline("req-3", "   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("decline_reason_required");
    expect(store.requests().find((view) => view.request.id === "req-3")?.request.state).toBe("requested");
  });

  it("is terminal", () => {
    const store = createDemoStore();
    expect(store.decline("req-4", "Trying again").ok).toBe(false);
    const decision = declineDecision(contextFor(store, "req-4"));
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("invalid_transition");
    expect(decision.reason).toBe("This request is already declined, so no further change is possible.");
  });

  it("can still be taken back as confirmed only from requested", () => {
    const store = createDemoStore();
    store.decline("req-2", "Away that day.");
    expect(store.confirm("req-2").ok).toBe(false);
    expect(remaining(store, "slot-2")).toBe(8);
  });
});

describe("the inbox", () => {
  it("puts what needs an answer first and explains every refusal", () => {
    const store = createDemoStore();
    const views = store.requests();
    expect(views[0]?.request.state).toBe("requested");
    const refused = views.find((view) => view.request.id === "req-4");
    expect(refused?.canConfirm.allowed).toBe(false);
    expect(views.find((view) => view.request.id === "req-3")?.canConfirm.allowed).toBe(true);

    store.confirm("req-2");
    const afterConfirm = store.requests();
    const overbooked = afterConfirm.find((view) => view.request.id === "req-3");
    if (overbooked?.canConfirm.allowed !== false) throw new Error("expected a refusal");
    expect(overbooked.canConfirm.code).toBe("insufficient_capacity");
    expect(overbooked.remaining).toBe(5);
  });

  it("shows a full slot as gone", () => {
    const store = createDemoStore();
    const full = store.availability().find((view) => view.dated.slot.id === "slot-5");
    expect(full?.availability.status).toBe("gone");
    expect(full?.availability.remaining).toBe(0);
  });
});

describe("what this provider is allowed to touch", () => {
  /**
   * A booking whose slot and listing were never loaded into this store — the
   * inbox filters it out, but `confirm(id)` used to take it anyway.
   */
  function storeWithUnloadedRequest() {
    const state = demoState();
    const foreignRequest = { ...state.bookings[1]!, id: "req-foreign", slotId: "slot-foreign", experienceId: "exp-foreign" };
    return new ProviderStore(state.provider, { ...state, bookings: [...state.bookings, foreignRequest] }, DEMO_TODAY);
  }

  it("will not edit, publish against, or block another provider's listing", () => {
    const state = demoState();
    const store = new ProviderStore(state.provider, {
      ...state,
      listings: [...state.listings, { ...state.listings[0]!, id: "exp-foreign", providerId: "prov-2" }],
    }, DEMO_TODAY);
    expect(store.listing("exp-foreign")).toBeUndefined();

    const draft = draftFromExperience(store.allListings()[0]!);
    expect(store.saveListing("exp-foreign", draft).ok).toBe(false);
    expect(store.allListings().find((l) => l.id === "exp-foreign")?.providerId).toBe("prov-2");

    expect(store.addSlot({ experienceId: "exp-foreign", date: "2026-02-21", start: "10:00", end: "12:00", capacity: "4" }).ok).toBe(false);
    expect(store.addBlock({ experienceId: "exp-foreign", date: "2026-02-21", start: "10:00", end: "12:00", reason: "x" }).ok).toBe(false);
  });

  it("will not move a request that is not in its inbox", () => {
    const store = storeWithUnloadedRequest();
    expect(store.requests().some((view) => view.request.id === "req-foreign")).toBe(false);
    const result = store.confirm("req-foreign");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
    expect(store.snapshot().bookings.find((b) => b.id === "req-foreign")?.state).toBe("requested");
  });

  it("will not publish a slot or block for a listing that does not exist", () => {
    const store = createDemoStore();
    expect(store.addSlot({ experienceId: "exp-nope", date: "2026-02-21", start: "10:00", end: "12:00", capacity: "4" }).ok).toBe(false);
    expect(store.addBlock({ experienceId: "exp-nope", date: "2026-02-21", start: "10:00", end: "12:00", reason: "x" }).ok).toBe(false);
    expect(store.snapshot().slots.some((dated) => dated.slot.providerId === "unassigned")).toBe(false);
  });

  it("hands out a snapshot the caller cannot write back through", () => {
    const store = createDemoStore();
    const snap = store.snapshot();
    snap.bookings[1]!.state = "confirmed";
    snap.slots[0]!.slot.capacity = 999;
    expect(store.snapshot().bookings[1]!.state).toBe("requested");
    expect(store.snapshot().slots[0]!.slot.capacity).not.toBe(999);
  });

  it("counts carts against a confirmation, not just confirmed seats", () => {
    const state = demoState();
    const withCarts = {
      ...state,
      slots: state.slots.map((dated) =>
        dated.slot.id === "slot-2" ? { ...dated, slot: { ...dated.slot, held: { ...dated.slot.held, carts: 4 } } } : dated,
      ),
    };
    const store = new ProviderStore(state.provider, withCarts, DEMO_TODAY);
    expect(store.availability().find((v) => v.dated.slot.id === "slot-2")?.availability.remaining).toBe(4);
    // req-3 is for 6. 8 - 4 carts = 4 free, so it must be refused.
    const result = store.confirm("req-3");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("insufficient_capacity");
  });
});
