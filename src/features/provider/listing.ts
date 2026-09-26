/**
 * Listing editor: draft -> validated -> `Experience`.
 *
 * Two rules from the contract drive this file:
 *  1. The draft holds RAW form strings, so an invalid keystroke can be shown
 *     back to the provider instead of being silently swallowed.
 *  2. `Experience` is the only catalogue shape. We never widen it and we never
 *     keep a parallel listing type. `buildExperience` ends in `Experience.parse`,
 *     so a bad row fails here rather than three sessions downstream.
 */
import {
  Experience,
  Category,
  IndoorOutdoor,
  Money,
  type Provenance,
  Rating,
} from "../../contracts";
import { hhmmToMin, isISODate } from "./time";

/** Read off the contract enums, never a second hand-written list. */
const CATEGORY_VALUES = Category.options;
const INDOOR_OUTDOOR_VALUES = IndoorOutdoor.options;

export type Tri = "yes" | "no" | "unknown";

/** null is a real state in this product. "I never surveyed it" is not `false`. */
const toBool = (tri: Tri): boolean | null => (tri === "unknown" ? null : tri === "yes");

const toTri = (value: boolean | null): Tri => (value === null ? "unknown" : value ? "yes" : "no");

export type ListingDraft = {
  name: string;
  category: string;
  description: string;
  blurb: string;
  lat: string;
  lon: string;
  neighbourhood: string;
  city: string;
  priceRupees: string;
  durationMin: string;
  capacity: string;
  minAge: string;
  kidFriendly: Tri;
  requiresJourney: boolean;
  indoorOutdoor: IndoorOutdoor;
  stepFree: Tri;
  strollerOk: Tri;
  lowStairs: Tri;
  seatingAvailable: Tri;
  hearingLoop: Tri;
  restroomOnSite: Tri;
  diets: string;
  cuisines: string;
  keywords: string;
  hoursRaw: string;
  requiresBooking: boolean;
  walkIn: boolean;
  leadTimeMin: string;
  ratingValue: string;
  ratingCount: string;
};

export type ListingErrors = Record<string, string>;

export const EMPTY_DRAFT: ListingDraft = {
  name: "",
  category: "",
  description: "",
  blurb: "",
  lat: "",
  lon: "",
  neighbourhood: "",
  city: "Mumbai",
  priceRupees: "",
  durationMin: "60",
  capacity: "",
  minAge: "",
  kidFriendly: "unknown",
  requiresJourney: false,
  indoorOutdoor: "indoor",
  stepFree: "unknown",
  strollerOk: "unknown",
  lowStairs: "unknown",
  seatingAvailable: "unknown",
  hearingLoop: "unknown",
  restroomOnSite: "unknown",
  diets: "",
  cuisines: "",
  keywords: "",
  hoursRaw: "",
  requiresBooking: false,
  walkIn: true,
  leadTimeMin: "0",
  ratingValue: "",
  ratingCount: "",
};

/** Comma/space separated free text -> the contract's open-vocabulary arrays. */
const list = (raw: string): string[] =>
  raw
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 12);

const isCategory = (raw: string): boolean => (CATEGORY_VALUES as readonly string[]).includes(raw);

const isDigits = (raw: string): boolean => /^\d+$/.test(raw.trim());

/** `"450.50"` -> `45050` paise. Rejects anything we cannot round-trip. */
export function rupeesToMinor(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const minor = Math.round(Number(value) * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function minorToRupees(minor: number): string {
  return (minor / 100).toFixed(2);
}

/**
 * `Mo-Su 09:00-21:00` is the shape OSM uses, so a provider's answer stays
 * portable. We only shape-check here: real evaluation is the engine's hours
 * adapter, which must degrade to `unparsable` rather than throw.
 */
const HOURS_SHAPE = /^(Mo|Tu|We|Th|Fr|Sa|Su)/;
const HOURS_RANGE = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/;

function validateHours(raw: string, errors: ListingErrors): void {
  const value = raw.trim();
  if (value === "") return;
  if (!HOURS_SHAPE.test(value)) {
    errors.hoursRaw = "Start with a day, for example Mo-Su 09:00-21:00.";
    return;
  }
  const range = HOURS_RANGE.exec(value);
  const [from, to] = [range?.[1] ?? "", range?.[2] ?? ""];
  if (!range || hhmmToMin(from) === null || hhmmToMin(to) === null) {
    errors.hoursRaw = "Use 24-hour times inside the range, for example Mo-Su 09:00-21:00.";
    return;
  }
  if (hhmmToMin(from)! >= hhmmToMin(to)!) {
    errors.hoursRaw = "The closing time must be after the opening time.";
  }
}

export function validateListing(draft: ListingDraft, existing?: Experience): ListingErrors {
  const errors: ListingErrors = {};

  if (draft.name.trim().length < 2) {
    errors.name = "Give the experience a name of at least 2 characters.";
  } else if (draft.name.trim().length > 80) {
    errors.name = "Keep the name under 80 characters so it fits on a card.";
  }

  if (!isCategory(draft.category)) {
    errors.category = "Pick a category, otherwise travellers cannot find you.";
  }

  const lat = Number(draft.lat);
  const lon = Number(draft.lon);
  if (draft.lat.trim() === "" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    errors.lat = "Latitude must be a number between -90 and 90.";
  }
  if (draft.lon.trim() === "" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    errors.lon = "Longitude must be a number between -180 and 180.";
  }

  if (!isDigits(draft.durationMin) || Number(draft.durationMin) < 1) {
    errors.durationMin = "Duration must be a whole number of minutes, at least 1.";
  } else if (Number(draft.durationMin) > 1440) {
    errors.durationMin = "A single visit cannot run past 24 hours.";
  }

  if (draft.priceRupees.trim() !== "" && rupeesToMinor(draft.priceRupees) === null) {
    errors.priceRupees = "Price must be rupees with at most two decimals, or blank for free.";
  }

  if (draft.capacity.trim() !== "" && (!isDigits(draft.capacity) || Number(draft.capacity) < 1)) {
    errors.capacity = "Capacity must be a whole number of at least 1, or blank for unlimited.";
  }

  if (draft.minAge.trim() !== "" && (!isDigits(draft.minAge) || Number(draft.minAge) > 17)) {
    errors.minAge = "Minimum age must be between 0 and 17, or blank if anyone can come.";
  }

  if (draft.requiresBooking && !isDigits(draft.leadTimeMin)) {
    errors.leadTimeMin = "Notice needed must be a whole number of minutes, 0 for none.";
  }

  validateHours(draft.hoursRaw, errors);

  const hasRating = draft.ratingValue.trim() !== "" || draft.ratingCount.trim() !== "";
  if (hasRating) {
    const value = Number(draft.ratingValue);
    const count = Number(draft.ratingCount);
    if (draft.ratingValue.trim() === "" || !Number.isFinite(value) || value < 0 || value > 5) {
      errors.ratingValue = "Rating must be between 0 and 5.";
    }
    if (!isDigits(draft.ratingCount) || count < 1) {
      errors.ratingCount = "A rating needs at least 1 review behind it, otherwise leave it blank.";
    }
  }

  if (!existing && !draft.neighbourhood.trim()) {
    errors.neighbourhood = "Add the neighbourhood, it is how travellers filter for you.";
  }

  return errors;
}

/**
 * What the provider typed is `provider` provenance. What they could not answer
 * is `inferred` — the lowest trust band, which the UI must badge. We never let a
 * provider self-declare `curated`.
 */
export function listingProvenance(draft: ListingDraft, existing?: Experience): Record<string, Provenance> {
  const known = (answered: boolean, key: string): [string, Provenance] => [
    key,
    answered ? "provider" : "inferred",
  ];
  return Object.fromEntries([
    known(draft.name.trim() !== "", "name"),
    known(isCategory(draft.category), "category"),
    known(Number.isFinite(Number(draft.lat)) && draft.lat.trim() !== "", "location"),
    known(draft.description.trim() !== "", "description"),
    known(draft.blurb.trim() !== "", "blurb"),
    known(isDigits(draft.durationMin), "durationMin"),
    known(draft.priceRupees.trim() !== "", "pricePerPerson"),
    known(draft.capacity.trim() !== "", "capacity"),
    known(draft.hoursRaw.trim() !== "", "hours"),
    known(draft.kidFriendly !== "unknown", "kidFriendly"),
    known(draft.minAge.trim() !== "", "minAge"),
    known(draft.stepFree !== "unknown", "accessibility"),
    ["indoorOutdoor", "provider"],
    known(list(draft.keywords).length > 0, "keywords"),
    known(list(draft.diets).length > 0, "diets"),
    known(list(draft.cuisines).length > 0, "cuisines"),
    known(draft.ratingValue.trim() !== "", "rating"),
    known(draft.requiresBooking, "booking"),
    known(isISODate(String(existing?.hours.lastVerified ?? "")), "hours.lastVerified"),
  ]);
}

export type BuildOptions = {
  id: string;
  providerId: string;
  today: string;
  existing?: Experience;
};

export function buildExperience(draft: ListingDraft, opts: BuildOptions): Experience {
  const base = opts.existing;
  const priceMinor = rupeesToMinor(draft.priceRupees);
  const capacity = draft.capacity.trim() === "" ? null : Number(draft.capacity);
  const rawHours = draft.hoursRaw.trim();
  const hasRating = draft.ratingValue.trim() !== "" && draft.ratingCount.trim() !== "";

  return Experience.parse({
    ...base,
    id: opts.id,
    name: draft.name.trim(),
    category: draft.category as Category,
    location: { lat: Number(draft.lat), lon: Number(draft.lon) },
    durationMin: Number(draft.durationMin),
    pricePerPerson: priceMinor === null ? null : Money.parse({ minor: priceMinor, currency: "INR" }),
    capacity,
    hours: {
      raw: rawHours === "" ? null : rawHours,
      // Provider-entered is honest but unverified by us, so `partial` not `ok`.
      status: rawHours === "" ? "absent" : "partial",
      lastVerified: rawHours === "" ? null : opts.today,
    },
    indoorOutdoor: draft.indoorOutdoor,
    accessibility: {
      stepFree: toBool(draft.stepFree),
      strollerOk: toBool(draft.strollerOk),
      lowStairs: toBool(draft.lowStairs),
      seatingAvailable: toBool(draft.seatingAvailable),
      hearingLoop: toBool(draft.hearingLoop),
      restroomOnSite: toBool(draft.restroomOnSite),
    },
    kidFriendly: toBool(draft.kidFriendly),
    minAge: draft.minAge.trim() === "" ? null : Number(draft.minAge),
    diets: list(draft.diets),
    cuisines: list(draft.cuisines),
    keywords: list(draft.keywords),
    blurb: draft.blurb.trim() === "" ? null : draft.blurb.trim(),
    description: draft.description.trim() === "" ? null : draft.description.trim(),
    rating: hasRating
      ? Rating.parse({ value: Number(draft.ratingValue), count: Number(draft.ratingCount), rawMean: null })
      : base?.rating ?? Rating.parse({ value: 0, count: 0, rawMean: null }),
    requiresJourney: draft.requiresJourney,
    booking: {
      required: draft.requiresBooking,
      leadTimeMin: draft.requiresBooking ? Number(draft.leadTimeMin) : 0,
      walkIn: draft.walkIn,
    },
    neighbourhood: draft.neighbourhood.trim() === "" ? null : draft.neighbourhood.trim(),
    city: draft.city.trim() === "" ? "Mumbai" : draft.city.trim(),
    providerId: opts.providerId,
    provenance: { ...(base?.provenance ?? {}), ...listingProvenance(draft, base) },
  });
}

/** Edit flow: catalogue row back into raw form strings. */
export function draftFromExperience(experience: Experience): ListingDraft {
  const money = experience.pricePerPerson?.minor ?? null;
  return {
    name: experience.name,
    category: experience.category,
    description: experience.description ?? "",
    blurb: experience.blurb ?? "",
    lat: String(experience.location.lat),
    lon: String(experience.location.lon),
    neighbourhood: experience.neighbourhood ?? "",
    city: experience.city,
    priceRupees: money === null ? "" : minorToRupees(money),
    durationMin: String(experience.durationMin),
    capacity: experience.capacity === null ? "" : String(experience.capacity),
    minAge: experience.minAge === null ? "" : String(experience.minAge),
    kidFriendly:
      experience.kidFriendly === null ? "unknown" : experience.kidFriendly ? "yes" : "no",
    requiresJourney: experience.requiresJourney,
    indoorOutdoor: experience.indoorOutdoor,
    stepFree: toTri(experience.accessibility.stepFree),
    strollerOk: toTri(experience.accessibility.strollerOk),
    lowStairs: toTri(experience.accessibility.lowStairs),
    seatingAvailable: toTri(experience.accessibility.seatingAvailable),
    hearingLoop: toTri(experience.accessibility.hearingLoop),
    restroomOnSite: toTri(experience.accessibility.restroomOnSite),
    diets: experience.diets.join(", "),
    cuisines: experience.cuisines.join(", "),
    keywords: experience.keywords.join(", "),
    hoursRaw: experience.hours.raw ?? "",
    requiresBooking: experience.booking.required,
    walkIn: experience.booking.walkIn,
    leadTimeMin: String(experience.booking.leadTimeMin),
    ratingValue: experience.rating.count > 0 ? String(experience.rating.value) : "",
    ratingCount: experience.rating.count > 0 ? String(experience.rating.count) : "",
  };
}

export const CATEGORY_OPTIONS: readonly Category[] = CATEGORY_VALUES;
export const INDOOR_OUTDOOR_OPTIONS: readonly IndoorOutdoor[] = INDOOR_OUTDOOR_VALUES;
