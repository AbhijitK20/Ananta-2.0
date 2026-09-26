/**
 * Public surface of the provider feature. Karan imports from here; nothing
 * outside this folder needs to know the file layout.
 */
export { ProviderPanel } from "./ProviderPanel";
export { ListingEditor } from "./ListingEditor";
export { AvailabilityEditor } from "./AvailabilityEditor";
export { RequestInbox } from "./RequestInbox";

export { ProviderApi } from "./api";
export { ProviderStore, type ProviderState } from "./store";
export { createDemoApi, createDemoStore, DEMO_TODAY, demoState } from "./demo";

export {
  type AvailabilityBlock,
  type BlockDraft,
  buildBlock,
  buildSlot,
  committedSeats,
  deriveAvailability,
  type DatedSlot,
  EMPTY_BLOCK_DRAFT,
  EMPTY_SLOT_DRAFT,
  type SlotDraft,
  type SlotErrors,
  slotLabel,
  type SlotView,
  slotViews,
  validateSlotDraft,
} from "./availability";

export {
  allowedNext,
  applyTransition,
  type BookingContext,
  canTransition,
  confirmDecision,
  declineDecision,
  type Decision,
  type ProviderError,
  type ProviderErrorCode,
  type RequestView,
  requestViews,
} from "./bookings";

export {
  buildExperience,
  CATEGORY_OPTIONS,
  draftFromExperience,
  EMPTY_DRAFT,
  INDOOR_OUTDOOR_OPTIONS,
  type ListingDraft,
  type ListingErrors,
  listingProvenance,
  validateListing,
} from "./listing";

export { hhmmToMin, isISODate, minToHHMM, minToLabel } from "./time";
export type { Result } from "./result";
