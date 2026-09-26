/**
 * Booking request inbox. One state machine only: the frozen `BOOKING_TRANSITIONS`
 * table from the contract. There is no parallel state machine here — an illegal
 * move is a rejected decision with a human sentence, never a silent write.
 */
import {
  BOOKING_TRANSITIONS,
  type BookingRequest,
  BookingRequest as BookingRequestSchema,
  type BookingState,
  type Experience,
} from "../../contracts";
import { committedSeats, type DatedSlot, type AvailabilityBlock } from "./availability";
import { fail, ok, type Result } from "./result";
import { isOnOrAfter } from "./time";

export type ProviderErrorCode =
  | "not_found"
  | "invalid_transition"
  | "decline_reason_required"
  | "slot_missing"
  | "slot_past"
  | "unavailable"
  | "insufficient_capacity";

export type ProviderError = { code: ProviderErrorCode; message: string };

export function allowedNext(state: BookingState): readonly BookingState[] {
  return BOOKING_TRANSITIONS[state];
}

export function canTransition(from: BookingState, to: BookingState): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

export type BookingContext = {
  request: BookingRequest | undefined;
  slot: DatedSlot | undefined;
  blocks: readonly AvailabilityBlock[];
  today: string;
  /** Seats already committed to this slot by other confirmed requests. */
  committed: number;
};

export type Decision = { allowed: true } | { allowed: false; code: ProviderErrorCode; reason: string };

const stateSentence = (state: BookingState): string =>
  ({
    requested: "still waiting on you",
    confirmed: "already confirmed",
    declined: "already declined",
    cancelled: "cancelled by the traveller",
    completed: "already completed",
  })[state];

function transitionGuard(ctx: BookingContext, to: BookingState): Decision {
  if (!ctx.request) {
    return { allowed: false, code: "not_found", reason: "That request no longer exists." };
  }
  if (!canTransition(ctx.request.state, to)) {
    const next = allowedNext(ctx.request.state);
    const options =
      next.length === 0 ? "no further change is possible" : `only ${next.join(" or ")} is possible`;
    return {
      allowed: false,
      code: "invalid_transition",
      reason: `This request is ${stateSentence(ctx.request.state)}, so ${options}.`,
    };
  }
  return { allowed: true };
}

/**
 * Declining is always the provider's right, so the transition check is the only
 * thing standing between the provider and their own "no".
 *
 * A REASON is not optional, but it is not this function's job to demand one while
 * the inbox is deciding whether to draw the button. So the two states are split:
 * `reason === undefined` means "nobody has typed one yet" and only the transition
 * is checked; a supplied reason that is blank is refused. FEATURES §5: "Declining
 * requires a reason. The traveller is told, and the reason feeds provider
 * reliability." A blank reason is a support ticket with no cause, and it silently
 * discards the one signal that tells a provider WHY they lost the booking.
 */
export function declineDecision(ctx: BookingContext, reason?: string | null): Decision {
  const transition = transitionGuard(ctx, "declined");
  if (!transition.allowed) return transition;
  if (reason != null && reason.trim() === "") {
    return {
      allowed: false,
      code: "decline_reason_required",
      reason: "Add a short reason so the traveller knows, and so your reliability stays meaningful.",
    };
  }
  return { allowed: true };
}

export function confirmDecision(ctx: BookingContext): Decision {
  const transition = transitionGuard(ctx, "confirmed");
  if (!transition.allowed) return transition;
  const request = ctx.request;
  const slot = ctx.slot;
  if (!request || !slot) {
    return {
      allowed: false,
      code: "slot_missing",
      reason: "The slot this request points at is no longer published.",
    };
  }
  if (!isOnOrAfter(slot.date, ctx.today)) {
    return {
      allowed: false,
      code: "slot_past",
      reason: `That slot was on ${slot.date}, which has passed.`,
    };
  }
  const blocked = ctx.blocks.find(
    (block) =>
      block.experienceId === slot.slot.experienceId &&
      block.date === slot.date &&
      slot.slot.startMin < block.endMin &&
      block.startMin < slot.slot.endMin,
  );
  if (blocked) {
    return {
      allowed: false,
      code: "unavailable",
      reason: `${slot.date} is marked unavailable (${blocked.reason}), so nobody can be added to it.`,
    };
  }
  const remaining = Math.max(0, slot.slot.capacity - ctx.committed);
  if (remaining < request.partySize) {
    return {
      allowed: false,
      code: "insufficient_capacity",
      reason: `Only ${remaining} of ${slot.slot.capacity} places are left, and this request is for ${request.partySize}.`,
    };
  }
  return { allowed: true };
}

/** Appends the history entry the contract requires. Pure. */
export function applyTransition(
  request: BookingRequest,
  to: BookingState,
  meta: { by: string; at: string; note?: string | null },
): Result<BookingRequest, ProviderError> {
  if (!canTransition(request.state, to)) {
    return fail({
      code: "invalid_transition",
      message: `Cannot move a ${request.state} request to ${to}. Allowed: ${
        BOOKING_TRANSITIONS[request.state].join(", ") || "nothing"
      }.`,
    });
  }
  return ok(
    BookingRequestSchema.parse({
      ...request,
      state: to,
      declineReason: to === "declined" ? meta.note ?? request.declineReason : request.declineReason,
      travellerNotifiedAt: meta.at,
      history: [
        ...request.history,
        { from: request.state, to, at: meta.at, by: meta.by, note: meta.note ?? null },
      ],
    }),
  );
}

export type RequestView = {
  request: BookingRequest;
  experience: Experience | undefined;
  slot: DatedSlot | undefined;
  /** Places still bookable in that slot, before this request is applied. */
  remaining: number;
  canConfirm: Decision;
  canDecline: Decision;
};

export function bookingContext(
  request: BookingRequest,
  slots: readonly DatedSlot[],
  blocks: readonly AvailabilityBlock[],
  today: string,
  allRequests: readonly BookingRequest[],
): BookingContext {
  const slot = slots.find((dated) => dated.slot.id === request.slotId);
  return {
    request,
    slot,
    blocks,
    today,
    committed: slot ? committedSeats(slot.slot.id, allRequests) : 0,
  };
}

/** Inbox order: needs an answer first, then most recently created. */
const STATE_ORDER: Record<BookingState, number> = {
  requested: 0,
  confirmed: 1,
  declined: 2,
  cancelled: 3,
  completed: 4,
};

export function requestViews(
  requests: readonly BookingRequest[],
  slots: readonly DatedSlot[],
  blocks: readonly AvailabilityBlock[],
  today: string,
  listings: readonly Experience[],
  /**
   * Every booking in the system, not just the ones in `requests`. `requests` is
   * the provider's filtered inbox; a seat sold by anyone against the same slot
   * still has to be subtracted, or the inbox prints "5 places left" on a slot
   * with none. Defaults to `requests` so a single-provider caller is still right.
   */
  allRequests: readonly BookingRequest[] = requests,
): RequestView[] {
  return [...requests]
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        (a.createdAt === b.createdAt
          ? a.id < b.id
            ? -1
            : 1
          : a.createdAt < b.createdAt
            ? 1
            : -1),
    )
    .map((request) => {
      const context = bookingContext(request, slots, blocks, today, allRequests);
      return {
        request,
        slot: context.slot,
        experience: listings.find((listing) => listing.id === request.experienceId),
        remaining: Math.max(0, (context.slot?.slot.capacity ?? 0) - context.committed),
        canConfirm: confirmDecision(context),
        // No reason argument: the inbox is deciding whether to DRAW the button,
        // and a provider who has not typed one yet must still be able to.
        canDecline: declineDecision(context),
      };
    });
}
