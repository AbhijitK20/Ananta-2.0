/**
 * Deterministic demo data. Every id, date and number is fixed, so the same run
 * produces the same inbox, the same capacity indicators and the same rejections
 * on every machine. No `new Date()`, no randomness, no network.
 *
 * The narrative the demo can walk through without any setup:
 *   1. Create a listing                     -> ListingEditor
 *   2. Publish slots, block the lunch hour  -> AvailabilityEditor
 *   3. Confirm Imran (3 of 8)               -> remaining 8 -> 5
 *   4. Decline Devika                       -> capacity unchanged
 *   5. Confirm the Fernandes family (6)     -> refused, 5 left
 *   6. Confirm Grace on the past walk slot  -> refused, slot has passed
 *   7. Confirm an already-declined request  -> refused, transitions are terminal
 */
import { BookingRequest, Provider } from "../../contracts";
import { ProviderApi } from "./api";
import { buildBlock, buildSlot, type DatedSlot, type AvailabilityBlock } from "./availability";
import { buildExperience, type ListingDraft } from "./listing";
import { ProviderStore, type ProviderState } from "./store";

export const DEMO_TODAY = "2026-02-14";

const PROVIDER = Provider.parse({
  id: "prov-1",
  name: "Kala Ghoda Studio",
  kind: "Craft workshop and walks",
  bio: "Two people, one studio, and a printing practice that has been on this lane since 1978.",
  neighbourhood: "Fort",
  city: "Mumbai",
  contact: { email: "hello@kalaghodastudio.example", phone: "+91 98200 00000" },
  reliability: 0.82,
  verified: true,
  createdAt: "2026-01-12T09:00:00.000Z",
});

const PRINT_DRAFT: ListingDraft = {
  name: "Block Print Studio Session",
  category: "craft_workshop",
  description:
    "Two hours at the long table. You carve a small block, pull your own prints, and leave with the sheet you made. Aprons and ink are included; wear something you do not mind marking.",
  blurb: "Carve a block, pull prints, keep the sheet.",
  lat: "18.9335",
  lon: "72.8345",
  neighbourhood: "Fort",
  city: "Mumbai",
  priceRupees: "450",
  durationMin: "120",
  capacity: "8",
  minAge: "6",
  kidFriendly: "yes",
  requiresJourney: false,
  indoorOutdoor: "indoor",
  stepFree: "yes",
  strollerOk: "yes",
  lowStairs: "yes",
  seatingAvailable: "yes",
  hearingLoop: "no",
  restroomOnSite: "yes",
  diets: "",
  cuisines: "",
  keywords: "block printing, textile, workshop, indigo, hands-on",
  hoursRaw: "Tu-Su 11:00-19:00",
  requiresBooking: true,
  walkIn: false,
  leadTimeMin: "1440",
  ratingValue: "",
  ratingCount: "",
};

const WALK_DRAFT: ListingDraft = {
  name: "Colaba Heritage Walk",
  category: "heritage_site",
  description:
    "Ninety minutes on foot through Colaba's lanes, ending at the causeway. We stop twice. Groups are capped at twelve so everyone can hear.",
  blurb: "Ninety minutes on foot through Colaba's lanes.",
  lat: "18.9216",
  lon: "72.8317",
  neighbourhood: "Colaba",
  city: "Mumbai",
  priceRupees: "",
  durationMin: "90",
  capacity: "12",
  minAge: "0",
  kidFriendly: "yes",
  requiresJourney: true,
  indoorOutdoor: "outdoor",
  stepFree: "unknown",
  strollerOk: "no",
  lowStairs: "no",
  seatingAvailable: "no",
  hearingLoop: "no",
  restroomOnSite: "no",
  diets: "",
  cuisines: "",
  keywords: "walking tour, colaba, colonial architecture, free",
  hoursRaw: "Sa-Su 07:00-10:00",
  requiresBooking: false,
  walkIn: true,
  leadTimeMin: "0",
  ratingValue: "4.6",
  ratingCount: "52",
};

const request = (
  id: string,
  slotId: string,
  experienceId: string,
  travellerName: string,
  partySize: number,
  state: "requested" | "confirmed" | "declined",
  createdAt: string,
  declineReason: string | null = null,
): BookingRequest =>
  BookingRequest.parse({
    id,
    slotId,
    experienceId,
    travellerName,
    travellerContact: `${travellerName.split(" ")[0]?.toLowerCase() ?? "traveller"}@example.com`,
    partySize,
    state,
    declineReason,
    travellerNotifiedAt: state === "requested" ? null : createdAt,
    history:
      state === "requested"
        ? []
        : [{ from: "requested", to: state, at: createdAt, by: PROVIDER.id, note: declineReason }],
    createdAt,
  });

export function demoState(): ProviderState {
  const listings = [
    buildExperience(PRINT_DRAFT, { id: "exp-1", providerId: PROVIDER.id, today: DEMO_TODAY }),
    buildExperience(WALK_DRAFT, { id: "exp-2", providerId: PROVIDER.id, today: DEMO_TODAY }),
  ];
  const ctx = (experienceId: string) => ({
    today: DEMO_TODAY,
    experience: listings.find((listing) => listing.id === experienceId),
    slots: [] as DatedSlot[],
    blocks: [] as AvailabilityBlock[],
  });

  const slots: DatedSlot[] = [
    buildSlot({ experienceId: "exp-1", date: "2026-02-14", start: "11:00", end: "13:00", capacity: "8" }, ctx("exp-1"), "slot-1"),
    buildSlot({ experienceId: "exp-1", date: "2026-02-14", start: "15:00", end: "17:00", capacity: "8" }, ctx("exp-1"), "slot-2"),
    buildSlot({ experienceId: "exp-1", date: "2026-02-13", start: "11:00", end: "13:00", capacity: "8" }, ctx("exp-1"), "slot-3"),
    buildSlot({ experienceId: "exp-1", date: "2026-02-15", start: "11:00", end: "13:00", capacity: "8" }, ctx("exp-1"), "slot-4"),
    buildSlot({ experienceId: "exp-1", date: "2026-02-15", start: "15:00", end: "17:00", capacity: "3" }, ctx("exp-1"), "slot-5"),
    buildSlot({ experienceId: "exp-2", date: "2026-02-15", start: "07:00", end: "08:30", capacity: "12" }, ctx("exp-2"), "slot-6"),
  ];

  const blocks: AvailabilityBlock[] = [
    buildBlock({ experienceId: "exp-1", date: "2026-02-15", start: "13:00", end: "14:00", reason: "Studio closed for lunch" }, "blk-1"),
  ];

  const bookings = [
    request("req-1", "slot-1", "exp-1", "Aarti Kulkarni", 4, "confirmed", "2026-02-11T07:20:00.000Z"),
    request("req-2", "slot-2", "exp-1", "Imran Shaikh", 3, "requested", "2026-02-13T16:05:00.000Z"),
    request("req-3", "slot-2", "exp-1", "The Fernandes family", 6, "requested", "2026-02-13T18:40:00.000Z"),
    request("req-4", "slot-2", "exp-1", "Devika Rao", 2, "declined", "2026-02-13T19:02:00.000Z", "I am away teaching that afternoon."),
    request("req-5", "slot-5", "exp-1", "Rohan Pillai", 3, "confirmed", "2026-02-12T11:10:00.000Z"),
    request("req-6", "slot-6", "exp-2", "Grace Fernandes", 2, "requested", "2026-02-14T06:30:00.000Z"),
    request("req-7", "slot-3", "exp-1", "Nikhil Bose", 2, "requested", "2026-02-12T09:00:00.000Z"),
  ];

  return { provider: PROVIDER, listings, slots, blocks, bookings };
}

export function createDemoStore(): ProviderStore {
  const state = demoState();
  return new ProviderStore(state.provider, state, DEMO_TODAY);
}

export function createDemoApi(latencyMs = 120): ProviderApi {
  return new ProviderApi(createDemoStore(), latencyMs);
}

export const DEMO_LISTING_DRAFTS: { title: string; draft: ListingDraft }[] = [
  { title: "Block Print Studio Session", draft: PRINT_DRAFT },
  { title: "Colaba Heritage Walk", draft: WALK_DRAFT },
];
