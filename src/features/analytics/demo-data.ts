/**
 * Deterministic demo dataset for the analytics feature.
 *
 * Honest by construction: every row is hand-authored, every count is a fixture,
 * and `dataset.source` is `"demo"` so the dashboard can say so. No `Date.now()`,
 * no `Math.random()` — every timestamp is derived from the fixed `AS_OF` anchor,
 * so the whole feature produces identical output on every machine, in CI, and in
 * a screen recording.
 *
 * Times are written as IST wall clock and stored as UTC, because that is what a
 * real event log does and because "16:00-20:00" has to mean the same thing to a
 * traveller in Colaba and to us in the aggregation.
 */
import type {
  Accessibility,
  AccessNeed,
  BookingRequest,
  BookingState,
  Experience,
  GeoPoint,
  Interaction,
  InteractionType,
  Provider,
  RejectionCode,
  UnmetDemand,
} from "../../contracts";
import type { AnalyticsSource } from "./types";

/** Fixed anchor. Nothing in this feature reads the wall clock. */
export const AS_OF = "2026-09-26T14:00:00.000Z";

/** Mumbai is UTC+5:30. Buckets are local, because travellers think local. */
export const IST_OFFSET_MIN = 330;

const DAY_MS = 86_400_000;

/** ISO datetime for a local wall-clock time `daysAgo` days before `AS_OF`. */
function isoAt(daysAgo: number, istHour: number, istMinute = 0): string {
  const shifted = Date.parse(AS_OF) + IST_OFFSET_MIN * 60_000;
  const midnight = Math.floor(shifted / DAY_MS) * DAY_MS;
  const ms = midnight - daysAgo * DAY_MS + (istHour * 60 + istMinute) * 60_000 - IST_OFFSET_MIN * 60_000;
  return new Date(ms).toISOString();
}

function dateAt(daysAgo: number): string {
  return isoAt(daysAgo, 12).slice(0, 10);
}

// --- providers ------------------------------------------------------------

const PROVIDERS: Provider[] = [
  {
    id: "prov-nila",
    name: "Nila Loom Studio",
    kind: "craft studio",
    bio: "Block-printing and handloom workshops run by two printers who trained in Bagru.",
    neighbourhood: "Fort",
    city: "Mumbai",
    contact: { email: "hello@example.invalid", phone: null },
    reliability: 0.82,
    verified: true,
    createdAt: isoAt(260, 10),
  },
  {
    id: "prov-kala",
    name: "Kala Ghoda Art House",
    kind: "art studio",
    bio: "Painting and sketching classes in a restored 1920s hall behind the Jehangir.",
    neighbourhood: "Kala Ghoda",
    city: "Mumbai",
    contact: { email: "studio@example.invalid", phone: null },
    reliability: 0.74,
    verified: true,
    createdAt: isoAt(240, 11),
  },
  {
    id: "prov-mehfil",
    name: "Mehfil Nights",
    kind: "live music venue",
    bio: "Ghazal and qawwali evenings in a 90-seat room. Unamplified.",
    neighbourhood: "Fort",
    city: "Mumbai",
    contact: { email: "bookings@example.invalid", phone: null },
    reliability: 0.68,
    verified: false,
    createdAt: isoAt(200, 19),
  },
  {
    id: "prov-sabzi",
    name: "Sabzi Tiffin Room",
    kind: "restaurant",
    bio: "Home-style Maharashtrian thali, twelve tables, no music.",
    neighbourhood: "Bandra West",
    city: "Mumbai",
    contact: { email: "table@example.invalid", phone: null },
    reliability: 0.9,
    verified: true,
    createdAt: isoAt(300, 12),
  },
  {
    id: "prov-kora",
    name: "Kora Surf Club",
    kind: "adventure outfitter",
    bio: "Small-group surfing and paddle sessions at Juhu beach.",
    neighbourhood: "Juhu",
    city: "Mumbai",
    contact: { email: "surf@example.invalid", phone: null },
    reliability: 0.61,
    verified: false,
    createdAt: isoAt(180, 7),
  },
];

// --- listings -------------------------------------------------------------

const ALL_ACCESS_NULL: Accessibility = {
  stepFree: null,
  strollerOk: null,
  lowStairs: null,
  seatingAvailable: null,
  hearingLoop: null,
  restroomOnSite: null,
};

interface ListingSpec {
  id: string;
  name: string;
  category: Experience["category"];
  providerId: string;
  neighbourhood: string;
  location: GeoPoint;
  durationMin: number;
  priceMinor: number | null;
  indoorOutdoor: Experience["indoorOutdoor"];
  bestTimeOfDay: Experience["bestTimeOfDay"];
  accessibility?: Partial<Accessibility>;
  kidFriendly?: boolean | null;
  capacity?: number | null;
  bookingRequired?: boolean;
  diets?: string[];
  keywords?: string[];
  blurb: string;
}

function listing(spec: ListingSpec): Experience {
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    location: spec.location,
    durationMin: spec.durationMin,
    pricePerPerson: spec.priceMinor === null ? null : { minor: spec.priceMinor, currency: "INR" },
    capacity: spec.capacity ?? null,
    hours: { raw: "Mo-Su 10:00-19:00", status: "ok", lastVerified: "2026-08-14" },
    indoorOutdoor: spec.indoorOutdoor,
    accessibility: { ...ALL_ACCESS_NULL, ...(spec.accessibility ?? {}) },
    kidFriendly: spec.kidFriendly ?? null,
    minAge: spec.kidFriendly ? 6 : null,
    diets: spec.diets ?? [],
    cuisines: [],
    rating: { value: 4.6, count: 132, rawMean: 4.5 },
    blurb: spec.blurb,
    description: null,
    keywords: spec.keywords ?? [],
    perception: { landscape: [], activities: [], atmosphere: [] },
    bestTimeOfDay: spec.bestTimeOfDay,
    requiresJourney: false,
    booking: { required: spec.bookingRequired ?? false, leadTimeMin: 0, walkIn: true },
    bestMonths: [11, 12, 1, 2, 3],
    weatherSensitive: spec.indoorOutdoor === "outdoor" ? "rain" : "none",
    provenance: {
      category: "curated",
      durationMin: "provider",
      pricePerPerson: "provider",
      indoorOutdoor: "provider",
      accessibility: "provider",
      bestTimeOfDay: "provider",
      rating: "derived",
    },
    providerId: spec.providerId,
    neighbourhood: spec.neighbourhood,
    city: "Mumbai",
  };
}

const LISTINGS: Experience[] = [
  listing({
    id: "exp-nila-print",
    name: "Block-printing a cotton stole",
    category: "craft_workshop",
    providerId: "prov-nila",
    neighbourhood: "Fort",
    location: { lat: 18.9355, lon: 72.8355 },
    durationMin: 120,
    priceMinor: 80000,
    indoorOutdoor: "indoor",
    bestTimeOfDay: ["morning", "afternoon"],
    capacity: 8,
    keywords: ["block print", "textile", "bagru"],
    blurb: "Two hours carving and printing a 2 m stole. Aprons and ink included.",
  }),
  listing({
    id: "exp-nila-archive",
    name: "Handloom archive walk",
    category: "craft_workshop",
    providerId: "prov-nila",
    neighbourhood: "Fort",
    location: { lat: 18.9362, lon: 72.8341 },
    durationMin: 45,
    priceMinor: 40000,
    indoorOutdoor: "indoor",
    bestTimeOfDay: ["morning", "afternoon"],
    capacity: 12,
    keywords: ["handloom", "weaving", "textile"],
    blurb: "Forty-five minutes among 1930s looms with a weaver who still works them.",
  }),
  listing({
    id: "exp-kala-paint",
    name: "Watercolour morning class",
    category: "art_studio",
    providerId: "prov-kala",
    neighbourhood: "Kala Ghoda",
    location: { lat: 18.928, lon: 72.832 },
    durationMin: 90,
    priceMinor: 120000,
    indoorOutdoor: "indoor",
    bestTimeOfDay: ["morning", "afternoon"],
    accessibility: { stepFree: true, seatingAvailable: true, restroomOnSite: true, lowStairs: true },
    kidFriendly: false,
    capacity: 10,
    keywords: ["painting", "watercolour", "sketching"],
    blurb: "Ninety minutes at the long table, south light, materials included.",
  }),
  listing({
    id: "exp-kala-portrait",
    name: "Portrait sitting, one to one",
    category: "art_studio",
    providerId: "prov-kala",
    neighbourhood: "Kala Ghoda",
    location: { lat: 18.9284, lon: 72.8327 },
    durationMin: 180,
    priceMinor: 350000,
    indoorOutdoor: "indoor",
    bestTimeOfDay: ["afternoon"],
    accessibility: { stepFree: true, seatingAvailable: true, restroomOnSite: true },
    capacity: 1,
    bookingRequired: true,
    keywords: ["portrait", "charcoal", "commission"],
    blurb: "Three hours, charcoal on paper, one sitter, no audience.",
  }),
  listing({
    id: "exp-mehfil-ghazal",
    name: "Ghazal evening",
    category: "music_live",
    providerId: "prov-mehfil",
    neighbourhood: "Fort",
    location: { lat: 18.9341, lon: 72.8362 },
    durationMin: 120,
    priceMinor: 90000,
    indoorOutdoor: "indoor",
    bestTimeOfDay: ["evening", "night"],
    accessibility: { hearingLoop: false, restroomOnSite: true, seatingAvailable: true },
    capacity: 30,
    keywords: ["ghazal", "live music", "unamplified"],
    blurb: "Two sets, ninety seats, no amplification.",
  }),
  listing({
    id: "exp-sabzi-thali",
    name: "Maharashtrian thali, twelve items",
    category: "restaurant",
    providerId: "prov-sabzi",
    neighbourhood: "Bandra West",
    location: { lat: 19.0596, lon: 72.8295 },
    durationMin: 60,
    priceMinor: 50000,
    indoorOutdoor: "indoor",
    bestTimeOfDay: ["morning", "afternoon"],
    accessibility: { restroomOnSite: true, seatingAvailable: true },
    kidFriendly: true,
    capacity: 6,
    diets: ["vegetarian"],
    keywords: ["thali", "home meal", "vegetarian"],
    blurb: "One thali, refilled, no music, no hurry.",
  }),
  listing({
    id: "exp-kora-surf",
    name: "Small-group surf lesson",
    category: "adventure",
    providerId: "prov-kora",
    neighbourhood: "Juhu",
    location: { lat: 19.121, lon: 72.844 },
    durationMin: 120,
    priceMinor: 180000,
    indoorOutdoor: "outdoor",
    bestTimeOfDay: ["morning", "afternoon"],
    capacity: 4,
    kidFriendly: false,
    keywords: ["surfing", "beginner", "board"],
    blurb: "Two hours, four boards, one instructor per two people.",
  }),
  listing({
    id: "exp-kora-paddle",
    name: "Sunrise paddle, Juhu beach",
    category: "adventure",
    providerId: "prov-kora",
    neighbourhood: "Juhu",
    location: { lat: 19.1224, lon: 72.8461 },
    durationMin: 90,
    priceMinor: 90000,
    indoorOutdoor: "outdoor",
    bestTimeOfDay: ["early_morning", "morning"],
    capacity: 6,
    keywords: ["paddle", "sunrise", "kayak"],
    blurb: "Ninety minutes on the water before the crowd lands.",
  }),
];

// --- unmet demand ---------------------------------------------------------
//
// Authored as cells, not as 90 individual rows: a cell is one real pattern of
// demand (where, what, blocked on what, how many), and the rows are expanded from
// it across the window. Each cell is designed to be — or not to be — fixable by
// a specific provider, which is what the opportunity tests lean on.

interface CellSpec {
  n: number;
  neighbourhood: string;
  point: GeoPoint;
  code: RejectionCode;
  interests: string[];
  budgetMinor: number | null;
  partySize: number;
  availableMin: number;
  accessNeeds?: AccessNeed[];
  weather?: string;
  /** Local hour. 4, 10, 14, 18, 21 sit in the middle of the five buckets. */
  istHour: number;
  /** Candidates that died on the binding code, summed across the cell. */
  blocked: number;
  /** Results the search returned. Always 0: that is what makes it unmet. */
  shortfall: number;
}

const CELLS: CellSpec[] = [
  {
    n: 9, neighbourhood: "Fort", point: { lat: 18.9355, lon: 72.8355 },
    code: "not_step_free", interests: ["craft_workshop", "family", "textile"],
    budgetMinor: 50000, partySize: 4, availableMin: 120, accessNeeds: ["wheelchair"],
    weather: "light_rain", istHour: 18, blocked: 31, shortfall: 0,
  },
  {
    n: 6, neighbourhood: "Fort", point: { lat: 18.9362, lon: 72.8341 },
    code: "not_step_free", interests: ["block printing", "handloom"],
    budgetMinor: 40000, partySize: 2, availableMin: 90, accessNeeds: ["wheelchair"],
    istHour: 10, blocked: 19, shortfall: 0,
  },
  {
    n: 7, neighbourhood: "Fort", point: { lat: 18.9341, lon: 72.8362 },
    code: "over_budget", interests: ["live music", "ghazal"],
    budgetMinor: 50000, partySize: 2, availableMin: 120, istHour: 21, blocked: 24, shortfall: 0,
  },
  {
    n: 5, neighbourhood: "Fort", point: { lat: 18.9341, lon: 72.8362 },
    code: "closed_during_window", interests: ["live music"],
    budgetMinor: 90000, partySize: 2, availableMin: 120, istHour: 19, blocked: 12, shortfall: 0,
  },
  {
    n: 5, neighbourhood: "Fort", point: { lat: 18.9355, lon: 72.8355 },
    code: "no_hearing_loop", interests: ["live music", "qawwali"],
    budgetMinor: 90000, partySize: 2, availableMin: 120, accessNeeds: ["hearingLoop"],
    istHour: 21, blocked: 9, shortfall: 0,
  },
  {
    n: 5, neighbourhood: "Fort", point: { lat: 18.9341, lon: 72.8362 },
    code: "duration_exceeds_budget", interests: ["live music", "ghazal"],
    budgetMinor: 90000, partySize: 2, availableMin: 60, istHour: 21, blocked: 16, shortfall: 0,
  },
  {
    n: 6, neighbourhood: "Fort", point: { lat: 18.9355, lon: 72.8355 },
    code: "closed_during_window", interests: ["craft_workshop", "textile"],
    budgetMinor: 60000, partySize: 2, availableMin: 120, istHour: 18, blocked: 15, shortfall: 0,
  },
  {
    n: 6, neighbourhood: "Fort", point: { lat: 18.9355, lon: 72.8355 },
    code: "over_budget", interests: ["craft_workshop", "family"],
    budgetMinor: 50000, partySize: 4, availableMin: 120, istHour: 11, blocked: 22, shortfall: 0,
  },
  {
    n: 6, neighbourhood: "Fort", point: { lat: 18.9355, lon: 72.8355 },
    code: "sold_out", interests: ["craft_workshop", "team outing"],
    budgetMinor: 60000, partySize: 10, availableMin: 120, istHour: 11, blocked: 17, shortfall: 0,
  },
  {
    n: 6, neighbourhood: "Kala Ghoda", point: { lat: 18.928, lon: 72.832 },
    code: "over_budget", interests: ["painting", "art class", "watercolour"],
    budgetMinor: 50000, partySize: 2, availableMin: 120, istHour: 15, blocked: 21, shortfall: 0,
  },
  {
    n: 5, neighbourhood: "Kala Ghoda", point: { lat: 18.928, lon: 72.832 },
    code: "duration_exceeds_budget", interests: ["art class", "sketching"],
    budgetMinor: 120000, partySize: 1, availableMin: 60, istHour: 10, blocked: 14, shortfall: 0,
  },
  {
    n: 6, neighbourhood: "Kala Ghoda", point: { lat: 18.9284, lon: 72.8327 },
    code: "closed_during_window", interests: ["portrait", "charcoal"],
    budgetMinor: 350000, partySize: 1, availableMin: 180, istHour: 19, blocked: 8, shortfall: 0,
  },
  {
    n: 7, neighbourhood: "Bandra West", point: { lat: 19.0596, lon: 72.8295 },
    code: "not_stroller_ok", interests: ["food", "dining", "family", "toddler"],
    budgetMinor: 80000, partySize: 3, availableMin: 90, accessNeeds: ["stroller"],
    weather: "clear", istHour: 13, blocked: 26, shortfall: 0,
  },
  {
    n: 6, neighbourhood: "Bandra West", point: { lat: 19.0596, lon: 72.8295 },
    code: "closed_during_window", interests: ["dinner", "food"],
    budgetMinor: 60000, partySize: 2, availableMin: 120, istHour: 20, blocked: 19, shortfall: 0,
  },
  {
    n: 6, neighbourhood: "Bandra West", point: { lat: 19.0596, lon: 72.8295 },
    code: "closed_during_window", interests: ["lunch", "thali"],
    budgetMinor: 60000, partySize: 2, availableMin: 90, istHour: 13, blocked: 11, shortfall: 0,
  },
  {
    n: 5, neighbourhood: "Bandra West", point: { lat: 19.0596, lon: 72.8295 },
    code: "duration_exceeds_budget", interests: ["thali", "food"],
    budgetMinor: 60000, partySize: 2, availableMin: 30, istHour: 13, blocked: 13, shortfall: 0,
  },
  {
    n: 5, neighbourhood: "Bandra West", point: { lat: 19.0596, lon: 72.8295 },
    code: "over_budget", interests: ["thali", "food", "snack"],
    budgetMinor: 30000, partySize: 2, availableMin: 45, istHour: 16, blocked: 18, shortfall: 0,
  },
  {
    n: 6, neighbourhood: "Juhu", point: { lat: 19.121, lon: 72.844 },
    code: "weather_unsafe", interests: ["surfing", "beginner"],
    budgetMinor: 120000, partySize: 2, availableMin: 120, weather: "light_rain",
    istHour: 10, blocked: 15, shortfall: 0,
  },
  {
    n: 5, neighbourhood: "Juhu", point: { lat: 19.1224, lon: 72.8461 },
    code: "weather_unsafe", interests: ["surfing", "sunset"],
    budgetMinor: 150000, partySize: 2, availableMin: 90, weather: "heavy_rain",
    istHour: 18, blocked: 13, shortfall: 0,
  },
  {
    n: 5, neighbourhood: "Juhu", point: { lat: 19.121, lon: 72.844 },
    code: "duration_exceeds_budget", interests: ["surfing", "paddle"],
    budgetMinor: 180000, partySize: 1, availableMin: 60, istHour: 8, blocked: 10, shortfall: 0,
  },
  {
    n: 5, neighbourhood: "Juhu", point: { lat: 19.121, lon: 72.844 },
    code: "over_budget", interests: ["surfing"],
    budgetMinor: 120000, partySize: 2, availableMin: 120, istHour: 10, blocked: 12, shortfall: 0,
  },
  {
    // Colaba is 3.4 km from every provider here, so this cell must produce no
    // opportunity. It is in the fixture so the radius gate is exercised by the
    // demo, not only by a test.
    n: 5, neighbourhood: "Colaba", point: { lat: 18.9067, lon: 72.8147 },
    code: "not_step_free", interests: ["heritage", "fort"],
    budgetMinor: 150000, partySize: 2, availableMin: 150, accessNeeds: ["wheelchair"],
    istHour: 10, blocked: 18, shortfall: 0,
  },
  {
    // Deliberately thin: above the bar for showing an opportunity, below the bar
    // for recommending a change. It is in the fixture so the dashboard ships
    // with a visibly `inferred` item and an honest "not enough signal" note.
    n: 3, neighbourhood: "Fort", point: { lat: 18.9355, lon: 72.8355 },
    code: "no_restroom", interests: ["craft_workshop", "toddler"],
    budgetMinor: 60000, partySize: 3, availableMin: 90, accessNeeds: ["restroom"],
    istHour: 14, blocked: 4, shortfall: 0,
  },
];

function buildUnmetDemand(): UnmetDemand[] {
  const rows: UnmetDemand[] = [];
  let seq = 0;
  for (const spec of CELLS) {
    for (let k = 0; k < spec.n; k += 1) {
      seq += 1;
      // Days 1..13, never 0: a 21:00 search stamped on the as-of day would sit
      // in the future, and a dataset that reports the future as history is worse
      // than one that is a day short at the edges.
      const daysAgo = 1 + ((k * 11) % 13);
      const minute = (k * 17) % 50;
      const point = {
        // Jitter inside the neighbourhood, deterministic per row, so a radius
        // check is a real distance rather than a constant.
        lat: Math.round((spec.point.lat + ((k % 3) - 1) * 0.0009) * 1e6) / 1e6,
        lon: Math.round((spec.point.lon + ((k % 5) - 2) * 0.0009) * 1e6) / 1e6,
      };
      rows.push({
        id: `ud-${String(seq).padStart(3, "0")}`,
        travellerId: `t${String((k % 8) + 1).padStart(2, "0")}`,
        point,
        neighbourhood: spec.neighbourhood,
        at: isoAt(daysAgo, spec.istHour, minute),
        constraints: {
          availableMin: spec.availableMin,
          budgetMinor: spec.budgetMinor,
          partySize: spec.partySize,
          accessNeeds: spec.accessNeeds ?? [],
          interests: spec.interests,
          weather: spec.weather ?? "clear",
        },
        shortfallCount: spec.shortfall,
        topBlockingCode: spec.code,
        topBlockingCount: spec.blocked,
      });
    }
  }
  return rows;
}

// --- interactions ---------------------------------------------------------

/** impressions, then fit-views (clicks), per listing. */
const TRAFFIC: ReadonlyArray<readonly [string, number, number, number]> = [
  ["exp-nila-print", 268, 74, 12],
  ["exp-nila-archive", 141, 33, 4],
  ["exp-kala-paint", 412, 156, 21],
  ["exp-kala-portrait", 96, 21, 5],
  ["exp-mehfil-ghazal", 224, 88, 17],
  ["exp-sabzi-thali", 533, 198, 26],
  ["exp-kora-surf", 187, 71, 14],
  ["exp-kora-paddle", 132, 44, 6],
];

/**
 * Spread a count across the window without a random number generator:
 * day `d` receives `floor(n*(d+1)/D) - floor(n*d/D)`. Sums back to `n` exactly,
 * which is the property the trend test asserts.
 */
function spread(total: number, days: number, daysAgo: number): number {
  return Math.floor((total * (daysAgo + 1)) / days) - Math.floor((total * daysAgo) / days);
}

function buildInteractions(): Interaction[] {
  const rows: Interaction[] = [];
  let seq = 0;
  for (const [experienceId, impressions, clicks, bookRequested] of TRAFFIC) {
    const plan: ReadonlyArray<readonly [InteractionType, number, number]> = [
      ["impression", impressions, 0.02],
      ["click", clicks, 0.35],
      ["book_requested", bookRequested, 0.7],
    ];
    for (const [type, total, reward] of plan) {
      for (let daysAgo = 0; daysAgo < 14; daysAgo += 1) {
        const n = spread(total, 14, daysAgo);
        for (let i = 0; i < n; i += 1) {
          seq += 1;
          rows.push({
            travellerId: `t${String((i % 8) + 1).padStart(2, "0")}`,
            experienceId,
            type,
            reward,
            at: isoAt(daysAgo, 9 + ((seq * 3) % 10), (seq * 7) % 60),
            contextSnapshotId: `ctx-${String(daysAgo + 1).padStart(2, "0")}`,
          });
        }
      }
    }
  }
  return rows;
}

// --- bookings -------------------------------------------------------------

interface BookingSpec {
  experienceId: string;
  state: BookingState;
  partySize: number;
  daysAgo: number;
  declineReason?: string;
}

const BOOKINGS: BookingSpec[] = [
  { experienceId: "exp-kala-paint", state: "confirmed", partySize: 2, daysAgo: 1 },
  { experienceId: "exp-kala-paint", state: "confirmed", partySize: 1, daysAgo: 3 },
  { experienceId: "exp-kala-paint", state: "completed", partySize: 3, daysAgo: 6 },
  { experienceId: "exp-kala-paint", state: "declined", partySize: 4, daysAgo: 4, declineReason: "No benches free at that hour" },
  { experienceId: "exp-kala-portrait", state: "confirmed", partySize: 1, daysAgo: 2 },
  { experienceId: "exp-kala-portrait", state: "cancelled", partySize: 1, daysAgo: 8 },
  { experienceId: "exp-nila-print", state: "confirmed", partySize: 2, daysAgo: 2 },
  { experienceId: "exp-nila-print", state: "confirmed", partySize: 4, daysAgo: 5 },
  { experienceId: "exp-nila-print", state: "declined", partySize: 6, daysAgo: 3, declineReason: "Print bench occupied" },
  { experienceId: "exp-nila-print", state: "completed", partySize: 2, daysAgo: 9 },
  { experienceId: "exp-nila-archive", state: "completed", partySize: 3, daysAgo: 7 },
  { experienceId: "exp-mehfil-ghazal", state: "confirmed", partySize: 2, daysAgo: 1 },
  { experienceId: "exp-mehfil-ghazal", state: "declined", partySize: 2, daysAgo: 6, declineReason: "House full" },
  { experienceId: "exp-mehfil-ghazal", state: "requested", partySize: 4, daysAgo: 0 },
  { experienceId: "exp-sabzi-thali", state: "confirmed", partySize: 2, daysAgo: 1 },
  { experienceId: "exp-sabzi-thali", state: "completed", partySize: 5, daysAgo: 4 },
  { experienceId: "exp-sabzi-thali", state: "completed", partySize: 3, daysAgo: 8 },
  { experienceId: "exp-sabzi-thali", state: "cancelled", partySize: 2, daysAgo: 5 },
  { experienceId: "exp-kora-surf", state: "confirmed", partySize: 2, daysAgo: 2 },
  { experienceId: "exp-kora-surf", state: "declined", partySize: 4, daysAgo: 4, declineReason: "Small swell, unsafe for four" },
  { experienceId: "exp-kora-surf", state: "requested", partySize: 2, daysAgo: 0 },
  { experienceId: "exp-kora-paddle", state: "completed", partySize: 2, daysAgo: 6 },
];

function buildBookings(): BookingRequest[] {
  return BOOKINGS.map((spec, i) => {
    const seq = String(i + 1).padStart(2, "0");
    const at = isoAt(spec.daysAgo, 19, (i * 11) % 60);
    const history: BookingRequest["history"] = [
      { from: "requested", to: spec.state, at, by: "prov", note: spec.declineReason ?? null },
    ];
    if (spec.state === "cancelled") {
      history[0] = { from: "requested", to: "confirmed", at, by: "prov", note: null };
      history.push({ from: "confirmed", to: "cancelled", at: isoAt(Math.max(0, spec.daysAgo - 1), 12), by: "traveller", note: null });
    }
    if (spec.state === "completed") {
      history.push({ from: "confirmed", to: "completed", at: isoAt(Math.max(0, spec.daysAgo - 1), 20), by: "prov", note: null });
    }
    return {
      id: `bk-${seq}`,
      slotId: `slot-${seq}`,
      experienceId: spec.experienceId,
      travellerName: `Traveller ${seq}`,
      // example.invalid never resolves, so demo data can never reach a real inbox.
      travellerContact: `traveller${seq}@example.invalid`,
      partySize: spec.partySize,
      state: spec.state,
      declineReason: spec.declineReason ?? null,
      travellerNotifiedAt: spec.state === "declined" ? at : null,
      history,
      createdAt: at,
    };
  });
}

// --- the source -----------------------------------------------------------

/**
 * The demo implementation of the adapter. Deterministic: the same object comes
 * back on every call, so a snapshot test is a real test and the demo script
 * never changes under the presenter.
 */
export function createDemoSource(): AnalyticsSource {
  return {
    dataset: {
      source: "demo",
      label: "Demo dataset, hand-authored",
      asOf: AS_OF,
      notes: [
        "No provider analytics API exists yet. Every count here is a fixture, not traffic.",
        `Window is the ${14} days to ${AS_OF.slice(0, 10)}, anchored so output never shifts.`,
        "Times are IST, stored as UTC.",
      ],
    },
    providers: PROVIDERS.map((p) => ({ ...p })),
    listings: LISTINGS.map((l) => ({ ...l })),
    interactions: buildInteractions(),
    bookings: buildBookings(),
    unmetDemand: buildUnmetDemand(),
  };
}

/** Dates covered by the demo window, oldest first. Used by the trend axis. */
export function demoWindowDates(days = 14): string[] {
  return Array.from({ length: days }, (_, i) => dateAt(days - 1 - i));
}
