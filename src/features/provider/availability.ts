/**
 * Availability. `Slot` in the contract has `startMin`/`endMin` but no date, so
 * the calendar day lives in a feature-local wrapper rather than being bolted onto
 * the frozen schema. Everything else — the slot, the derived availability, the
 * price — is the contract's.
 *
 * Capacity is DERIVED, never stored as a `remaining` counter (pretix, and the
 * note on `Slot` in the contract). A pending request is a proposal, not a seat:
 * it holds nothing until the provider confirms, which is what makes the confirm
 * step visibly move the remaining number.
 */
import { type Experience, Money, Slot, SlotAvailability } from "../../contracts";
import { hhmmToMin, isISODate, isOnOrAfter, minToLabel } from "./time";

export type DatedSlot = { date: string; slot: Slot };

/** A window the provider is NOT taking bookings in. Lunch break, market day. */
export type AvailabilityBlock = {
  id: string;
  experienceId: string;
  date: string;
  startMin: number;
  endMin: number;
  reason: string;
};

export type SlotDraft = {
  experienceId: string;
  date: string;
  start: string;
  end: string;
  capacity: string;
};

export type BlockDraft = {
  experienceId: string;
  date: string;
  start: string;
  end: string;
  reason: string;
};

export type SlotErrors = Record<string, string>;

export const EMPTY_SLOT_DRAFT: SlotDraft = {
  experienceId: "",
  date: "",
  start: "10:00",
  end: "11:00",
  capacity: "6",
};

export const EMPTY_BLOCK_DRAFT: BlockDraft = {
  experienceId: "",
  date: "",
  start: "13:00",
  end: "14:00",
  reason: "",
};

export type AvailabilityContext = {
  today: string;
  experience: Experience | undefined;
  slots: readonly DatedSlot[];
  blocks: readonly AvailabilityBlock[];
};

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && bStart < aEnd;

export function blockOverlaps(
  draft: { experienceId: string; date: string; startMin: number; endMin: number },
  blocks: readonly AvailabilityBlock[],
): AvailabilityBlock | undefined {
  return blocks.find(
    (block) =>
      block.experienceId === draft.experienceId &&
      block.date === draft.date &&
      overlaps(draft.startMin, draft.endMin, block.startMin, block.endMin),
  );
}

export function blockCovering(
  slot: DatedSlot,
  blocks: readonly AvailabilityBlock[],
): AvailabilityBlock | undefined {
  return blockOverlaps(
    {
      experienceId: slot.slot.experienceId,
      date: slot.date,
      startMin: slot.slot.startMin,
      endMin: slot.slot.endMin,
    },
    blocks,
  );
}

function validateWindow(
  draft: { experienceId: string; date: string; start: string; end: string },
  errors: SlotErrors,
  labels: { experienceId: string; date: string },
): { startMin: number; endMin: number } | null {
  if (draft.experienceId.trim() === "") {
    errors.experienceId = labels.experienceId;
    return null;
  }
  if (!isISODate(draft.date)) {
    errors.date = labels.date;
    return null;
  }
  const startMin = hhmmToMin(draft.start);
  const endMin = hhmmToMin(draft.end);
  if (startMin === null) {
    errors.start = "Start time must look like 09:30.";
  }
  if (endMin === null) {
    errors.end = "End time must look like 09:30.";
  }
  if (startMin === null || endMin === null) return null;
  if (endMin <= startMin) {
    errors.end = "End time must be after the start time.";
    return null;
  }
  return { startMin, endMin };
}

export function validateBlockDraft(draft: BlockDraft, ctx: AvailabilityContext): SlotErrors {
  const errors: SlotErrors = {};
  const window = validateWindow(draft, errors, {
    experienceId: "Pick which experience is unavailable.",
    date: "Pick a date in the YYYY-MM-DD format.",
  });
  if (!window) return errors;
  const clash = ctx.blocks.find(
    (block) =>
      block.experienceId === draft.experienceId &&
      block.date === draft.date &&
      overlaps(window.startMin, window.endMin, block.startMin, block.endMin),
  );
  if (clash) {
    errors.start = `That overlaps an unavailable window you already set (${blockLabel(clash)}).`;
  }
  return errors;
}

export function validateSlotDraft(draft: SlotDraft, ctx: AvailabilityContext): SlotErrors {
  const errors: SlotErrors = {};
  const window = validateWindow(draft, errors, {
    experienceId: "Pick which experience this slot belongs to.",
    date: "Pick a date in the YYYY-MM-DD format.",
  });
  if (!window) return errors;

  if (!isOnOrAfter(draft.date, ctx.today)) {
    errors.date = "That date has already passed. Publish a slot for today or later.";
  }

  if (!/^\d+$/.test(draft.capacity.trim()) || Number(draft.capacity) < 1) {
    errors.capacity = "Capacity must be a whole number of at least 1.";
  } else if (ctx.experience?.capacity != null && Number(draft.capacity) > ctx.experience.capacity) {
    errors.capacity = `Your listing seats at most ${ctx.experience.capacity}, so a slot cannot hold ${draft.capacity}.`;
  }

  const lengthMin = window.endMin - window.startMin;
  if (ctx.experience && lengthMin < ctx.experience.durationMin) {
    errors.end = `This window is ${lengthMin} min but the experience needs ${ctx.experience.durationMin} min.`;
  }

  const sameDay = ctx.slots.filter(
    (dated) => dated.date === draft.date && dated.slot.experienceId === draft.experienceId,
  );
  const duplicate = sameDay.find(
    (dated) => dated.slot.startMin === window.startMin && dated.slot.endMin === window.endMin,
  );
  if (duplicate) {
    errors.start = `You already published ${slotLabel(duplicate)} on this date.`;
  } else {
    const clash = sameDay.find(
      (dated) =>
        overlaps(window.startMin, window.endMin, dated.slot.startMin, dated.slot.endMin),
    );
    if (clash) {
      errors.start = `That overlaps the ${slotLabel(clash)} slot on this date.`;
    }
  }

  const blocked = blockOverlaps(
    { experienceId: draft.experienceId, date: draft.date, startMin: window.startMin, endMin: window.endMin },
    ctx.blocks,
  );
  if (blocked) {
    errors.start = `That falls inside an unavailable window (${blockLabel(blocked)}).`;
  }

  return errors;
}

export function buildSlot(draft: SlotDraft, ctx: AvailabilityContext, id: string): DatedSlot {
  const startMin = hhmmToMin(draft.start) ?? 0;
  const endMin = hhmmToMin(draft.end) ?? 0;
  return {
    date: draft.date,
    slot: Slot.parse({
      id,
      providerId: ctx.experience?.providerId ?? "unassigned",
      experienceId: draft.experienceId,
      startMin,
      endMin,
      capacity: Number(draft.capacity),
      pricePerPerson: ctx.experience?.pricePerPerson ?? Money.parse({ minor: 0, currency: "INR" }),
      held: { pendingOrders: 0, confirmedOrders: 0, carts: 0 },
      status: "ok",
    }),
  };
}

export function buildBlock(draft: BlockDraft, id: string): AvailabilityBlock {
  return {
    id,
    experienceId: draft.experienceId,
    date: draft.date,
    startMin: hhmmToMin(draft.start) ?? 0,
    endMin: hhmmToMin(draft.end) ?? 0,
    reason: draft.reason.trim() === "" ? "Unavailable" : draft.reason.trim(),
  };
}

export function slotDurationMin(slot: Slot): number {
  return slot.endMin - slot.startMin;
}

export function slotLabel(dated: DatedSlot): string {
  return `${minToLabel(dated.slot.startMin)} to ${minToLabel(dated.slot.endMin)}`;
}

export function blockLabel(block: AvailabilityBlock): string {
  return `${minToLabel(block.startMin)} to ${minToLabel(block.endMin)}`;
}

/** Seats committed by confirmed requests, plus carts. Pending requests hold nothing. */
export function committedSeats(slotId: string, bookings: readonly { slotId: string; partySize: number; state: string }[]): number {
  return bookings
    .filter((booking) => booking.slotId === slotId && booking.state === "confirmed")
    .reduce((total, booking) => total + booking.partySize, 0);
}

export function pendingSeats(
  slotId: string,
  bookings: readonly { slotId: string; partySize: number; state: string }[],
): number {
  return bookings
    .filter((booking) => booking.slotId === slotId && booking.state === "requested")
    .reduce((total, booking) => total + booking.partySize, 0);
}

/**
 * pretix order: confirmed beats held. `remaining` is floored at zero so the
 * contract value can never go negative; `confirm` reads the same number, so an
 * over-committed slot fails the guard instead of quietly going to -4.
 */
export function deriveAvailability(
  slot: Slot,
  bookings: readonly { slotId: string; partySize: number; state: string }[],
): SlotAvailability {
  const confirmed = committedSeats(slot.id, bookings);
  const pending = pendingSeats(slot.id, bookings);
  const carts = slot.held.carts;
  const remaining = Math.max(0, slot.capacity - confirmed - carts);

  const status: SlotAvailability["status"] =
    remaining === 0 ? "gone" : remaining < slot.capacity ? "ordered" : pending > 0 ? "reserved" : "ok";

  return SlotAvailability.parse({
    slotId: slot.id,
    status,
    remaining,
    derivedFrom: [
      `capacity:${slot.capacity}`,
      `confirmed:${confirmed}`,
      `pending:${pending}`,
      `carts:${carts}`,
    ],
  });
}

export type SlotView = {
  dated: DatedSlot;
  availability: SlotAvailability;
  /** Set when an unavailable window covers this slot, so bookings must be refused. */
  blockedBy: AvailabilityBlock | undefined;
};

export function slotViews(
  slots: readonly DatedSlot[],
  blocks: readonly AvailabilityBlock[],
  bookings: readonly { slotId: string; partySize: number; state: string }[],
): SlotView[] {
  return [...slots]
    .sort((a, b) => (a.date === b.date ? a.slot.startMin - b.slot.startMin : a.date < b.date ? -1 : 1))
    .map((dated) => ({
      dated,
      availability: deriveAvailability(dated.slot, bookings),
      blockedBy: blockCovering(dated, blocks),
    }));
}
