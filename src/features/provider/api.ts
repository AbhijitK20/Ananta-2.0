/**
 * The async shell the provider UI talks to. One reason it exists: the loading
 * and error states have to be real, not decorative. Swap `ProviderApi` for
 * `fetch("/api/provider/...")` in Karan's route handlers and the components do
 * not change.
 *
 * ponytail: ceiling — the 120ms delay is the only fake in the feature. Set
 * `latencyMs: 0` in tests.
 */
import type { BookingRequest, Experience, Provider } from "../../contracts";
import type { AvailabilityBlock, BlockDraft, DatedSlot, SlotDraft, SlotErrors, SlotView } from "./availability";
import type { ProviderError, RequestView } from "./bookings";
import type { ListingDraft, ListingErrors } from "./listing";
import type { Result } from "./result";
import { ProviderStore, type ProviderState } from "./store";

const wait = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class ProviderApi {
  constructor(
    private store: ProviderStore,
    private latencyMs = 120,
  ) {}

  private async call<T>(run: () => T): Promise<T> {
    await wait(this.latencyMs);
    return run();
  }

  today(): string {
    return this.store.today;
  }

  provider(): Provider {
    return this.store.provider;
  }

  listings(): Promise<Experience[]> {
    return this.call(() => this.store.allListings());
  }

  saveListing(id: string | null, draft: ListingDraft): Promise<Result<Experience, ListingErrors>> {
    return this.call(() => this.store.saveListing(id, draft));
  }

  addSlot(draft: SlotDraft): Promise<Result<DatedSlot, SlotErrors>> {
    return this.call(() => this.store.addSlot(draft));
  }

  addBlock(draft: BlockDraft): Promise<Result<AvailabilityBlock, SlotErrors>> {
    return this.call(() => this.store.addBlock(draft));
  }

  availability(experienceId?: string): Promise<SlotView[]> {
    return this.call(() => this.store.availability(experienceId));
  }

  requests(): Promise<RequestView[]> {
    return this.call(() => this.store.requests());
  }

  confirm(requestId: string): Promise<Result<BookingRequest, ProviderError>> {
    return this.call(() => this.store.confirm(requestId));
  }

  decline(requestId: string, reason: string): Promise<Result<BookingRequest, ProviderError>> {
    return this.call(() => this.store.decline(requestId, reason));
  }

  state(): ProviderState {
    return this.store.snapshot();
  }
}
