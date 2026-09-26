/**
 * The provider-side write model. Synchronous and pure enough to unit test, and
 * every guard lives in exactly one place:
 *
 *  listing validity   -> listing.validateListing
 *  slot validity      -> availability.validateSlotDraft
 *  state machine      -> bookings.applyTransition (the frozen transition table)
 *  capacity           -> availability.deriveAvailability (derived, never stored)
 *
 * `today` is injected, never `new Date()`, so the demo and the tests are
 * deterministic. `src/features/provider/api.ts` is the async shell the UI talks
 * to; this is what it wraps.
 */
import {
  type BookingRequest,
  type BookingState,
  type Experience,
  type Provider,
} from "../../contracts";
import {
  type AvailabilityBlock,
  type BlockDraft,
  buildBlock,
  buildSlot,
  type DatedSlot,
  type SlotDraft,
  type SlotErrors,
  slotViews,
  type SlotView,
  validateBlockDraft,
  validateSlotDraft,
} from "./availability";
import {
  applyTransition,
  bookingContext,
  confirmDecision,
  declineDecision,
  type Decision,
  type ProviderError,
  type RequestView,
  requestViews,
} from "./bookings";
import { buildExperience, type ListingDraft, type ListingErrors, validateListing } from "./listing";
import { fail, ok, type Result } from "./result";

export type ProviderState = {
  provider: Provider;
  listings: Experience[];
  slots: DatedSlot[];
  blocks: AvailabilityBlock[];
  bookings: BookingRequest[];
};

const ORPHAN_LISTING = "Pick one of your own listings first.";

export class ProviderStore {
  readonly today: string;
  private listings: Experience[];
  private slots: DatedSlot[];
  private blocks: AvailabilityBlock[];
  private bookings: BookingRequest[];
  private ticks = 0;

  constructor(
    readonly provider: Provider,
    state: { listings?: Experience[]; slots?: DatedSlot[]; blocks?: AvailabilityBlock[]; bookings?: BookingRequest[] },
    today: string,
  ) {
    this.today = today;
    this.listings = [...(state.listings ?? [])];
    this.slots = [...(state.slots ?? [])];
    this.blocks = [...(state.blocks ?? [])];
    this.bookings = [...(state.bookings ?? [])];
  }

  /** Deterministic stamps: a fixed day plus one minute per accepted mutation. */
  private stamp(): string {
    const base = Date.parse(`${this.today}T00:00:00.000Z`) + (600 + this.ticks++) * 60_000;
    return new Date(base).toISOString();
  }

  /**
   * A boundary, not a view. Shallow-cloning the arrays would hand the caller the
   * store's own booking/slot/listing objects, so `state.bookings[0].state = "x"`
   * would skip `applyTransition` and the capacity guard entirely.
   * `structuredClone` is stdlib and every field here is plain JSON data.
   */
  snapshot(): ProviderState {
    return structuredClone({
      provider: this.provider,
      listings: this.listings,
      slots: this.slots,
      blocks: this.blocks,
      bookings: this.bookings,
    });
  }

  /**
   * Rows this provider owns. The backing state can hold another provider's rows
   * (a shared load, a demo that splices one in), and every read below goes
   * through here — a read that leaks a competitor's name, dates or capacity is
   * the same defect as a mutation that touches one.
   */
  private own<T extends { providerId: string | null }>(rows: readonly T[]): T[] {
    return rows.filter((row) => row.providerId === this.provider.id);
  }

  /** `DatedSlot` keeps the date beside the slot, so ownership is read off `slot`. */
  private ownSlots(): DatedSlot[] {
    return this.slots.filter((dated) => dated.slot.providerId === this.provider.id);
  }

  allListings(): Experience[] {
    return this.own(this.listings).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * This provider's listing, or nothing. Ownership lives HERE so every mutation
   * that resolves an id inherits it: a caller who passes another provider's id
   * gets `undefined` and is refused, instead of having the row rewritten with
   * our `providerId` and quietly taken over.
   */
  listing(id: string): Experience | undefined {
    return this.own(this.listings).find((listing) => listing.id === id);
  }

  /** `id === null` creates. Anything else edits in place, keeping OSM data. */
  saveListing(id: string | null, draft: ListingDraft): Result<Experience, ListingErrors> {
    const existing = id === null ? undefined : this.listing(id);
    // An id that does not resolve must NOT fall through to create. That turns a
    // stale edit tab into a second listing with a fresh id, and the provider ends
    // up with two rows for one place and no way to tell which is live.
    if (id !== null && !existing) {
      return fail({ id: "That listing no longer exists. Reload it before saving." });
    }
    const errors = validateListing(draft, existing);
    if (Object.keys(errors).length > 0) return fail(errors);

    const nextId = existing?.id ?? this.nextListingId();
    const experience = buildExperience(draft, {
      id: nextId,
      providerId: this.provider.id,
      today: this.today,
      ...(existing ? { existing } : {}),
    });
    this.listings = existing
      ? this.listings.map((listing) => (listing.id === existing.id ? experience : listing))
      : [...this.listings, experience];
    return ok(experience);
  }

  /**
   * `length + 1` is not an id: seeded rows carry their own ids, so a store holding
   * `exp-1`, `exp-7` would mint `exp-3` and then `exp-4` fine, but any deletion
   * or any non-contiguous seed set collides. Take the first free `exp-N`.
   */
  private nextListingId(): string {
    const taken = new Set(this.listings.map((listing) => listing.id));
    for (let n = this.listings.length + 1; ; n += 1) {
      const candidate = `exp-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  addSlot(draft: SlotDraft): Result<DatedSlot, SlotErrors> {
    const experience = this.listing(draft.experienceId);
    // A slot with no listing behind it builds with `providerId: "unassigned"` and
    // a zero price, so it can never be tied back to anything. Refuse before build.
    if (!experience) return fail({ experienceId: ORPHAN_LISTING });
    const ctx = {
      today: this.today,
      experience,
      slots: this.slots,
      blocks: this.blocks,
    };
    const errors = validateSlotDraft(draft, ctx);
    if (Object.keys(errors).length > 0) return fail(errors);
    const dated = buildSlot(draft, ctx, `slot-${this.slots.length + 1}`);
    this.slots = [...this.slots, dated];
    return ok(dated);
  }

  addBlock(draft: BlockDraft): Result<AvailabilityBlock, SlotErrors> {
    const experience = this.listing(draft.experienceId);
    // Same orphan hole as `addSlot`: an unknown id validated as a non-empty
    // string, so the block was persisted for an experience nobody owns.
    if (!experience) return fail({ experienceId: ORPHAN_LISTING });
    const errors = validateBlockDraft(draft, {
      today: this.today,
      experience,
      slots: this.slots,
      blocks: this.blocks,
    });
    if (Object.keys(errors).length > 0) return fail(errors);
    const block = buildBlock(draft, `blk-${this.blocks.length + 1}`);
    this.blocks = [...this.blocks, block];
    return ok(block);
  }

  availability(experienceId?: string): SlotView[] {
    // Scoped to our own slots, or the panel prints a competitor's dates, capacity
    // and booking status.
    const mine = this.ownSlots();
    const slots = experienceId ? mine.filter((dated) => dated.slot.experienceId === experienceId) : mine;
    return slotViews(slots, this.blocks, this.bookings);
  }

  /**
   * A request is this provider's business if it points at one of THEIR slots or
   * one of THEIR listings — and the slot or listing has to actually be theirs.
   * Matching on id alone is not enough: a shared state can carry another
   * provider's slot, and then `confirm(id)` would mutate a request this provider
   * was never shown. ONE predicate, used by the inbox AND the mutation path.
   */
  private owns(request: BookingRequest): boolean {
    return (
      this.ownSlots().some((dated) => dated.slot.id === request.slotId) ||
      this.own(this.listings).some((listing) => listing.id === request.experienceId)
    );
  }

  /** Requests that belong to this provider, via the slot or the experience. */
  requests(): RequestView[] {
    const mine = this.bookings.filter((request) => this.owns(request));
    return requestViews(mine, this.slots, this.blocks, this.today, this.listings, this.bookings);
  }

  private move(
    requestId: string,
    to: BookingState,
    decide: (ctx: ReturnType<typeof bookingContext>, reason?: string | null) => Decision,
    note?: string,
  ): Result<BookingRequest, ProviderError> {
    const index = this.bookings.findIndex((request) => request.id === requestId);
    const request = this.bookings[index];
    if (index < 0 || !request) {
      return fail({ code: "not_found", message: "That request no longer exists." });
    }
    if (!this.owns(request)) {
      return fail({ code: "not_found", message: "That request is not in your inbox." });
    }
    const decision = decide(
      // `this.bookings`, NOT the provider-filtered inbox view: `committed` has to
      // count every seat already sold on that slot, or two providers sharing a
      // listing can each confirm against the same empty count and oversell.
      bookingContext(request, this.slots, this.blocks, this.today, this.bookings),
      note ?? undefined,
    );
    if (!decision.allowed) return fail({ code: decision.code, message: decision.reason });
    const moved = applyTransition(request, to, {
      by: this.provider.id,
      at: this.stamp(),
      note: note ?? null,
    });
    if (!moved.ok) return moved;
    this.bookings = this.bookings.map((entry) => (entry.id === requestId ? moved.value : entry));
    return moved;
  }

  /** Decrements remaining capacity by the party size, and refuses to go negative. */
  confirm(requestId: string): Result<BookingRequest, ProviderError> {
    return this.move(requestId, "confirmed", confirmDecision);
  }

  /** Leaves capacity untouched. The traveller is notified either way. */
  decline(requestId: string, reason: string): Result<BookingRequest, ProviderError> {
    return this.move(requestId, "declined", declineDecision, reason.trim());
  }
}
