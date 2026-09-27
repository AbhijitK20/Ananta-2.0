/**
 * Consent state. Plain, synchronous, framework-free — the whole thing is one
 * localStorage key, so it belongs in `lib/` and is unit-testable without a DOM.
 *
 * WHY IT EXISTS. `components/WorldGlobe.tsx` requests OpenStreetMap raster
 * tiles from the visitor's browser. That request necessarily carries the
 * visitor's IP address, their User-Agent and the part of the globe they are
 * looking at to a server we do not run. There is no consent gate in front of it,
 * no cookie notice, and — before this file — no privacy policy or terms page for
 * either to be described in. `components/Footer.tsx` linked the words "Privacy
 * Policy" and "Terms & Conditions" at the site homepage, so a visitor who
 * clicked them got the same page they came from.
 *
 * WHY THE SHAPE IS DELIBERATELY BORING. The categories below are the ONLY
 * categories this site has, because the map is the only thing it loads from a
 * third party:
 *
 *   necessary  — the storage needed to serve a page and to remember this decision
 *   map        — OpenStreetMap raster tiles for the globe
 *
 * There is no analytics, no advertising, no social widget and no session replay
 * here, and inventing empty rows for them would be a consent dialog that lies
 * about what it governs. If somebody adds a tracker, it gets a category here and
 * a row in `describeCategories()`. `unknownCategories()` is the check that stops
 * a switchable category being added without the disclosure following it.
 *
 * DPDP ACT 2023 section 6 requires free, plain, specific, informed and
 * unconditional consent for processing outside a Data Principal's reasonable
 * expectations. A map tile request is arguably within reasonable expectations
 * for a travel guide, so this is notice-plus-choice territory rather than
 * opt-in — but "reasonable expectation" is a judgement call about one endpoint,
 * and a visitor who would rather not have their IP sent to a tile server should
 * be able to say so without leaving. So the globe is withheld until somebody
 * answers.
 *
 * WHAT IS NOT STORED. No identifier, no consent receipt, no IP, no timestamp
 * beyond the version string, and nothing server-side. The record is that a
 * choice was made, locally, by this browser.
 */

/** Bumping this re-prompts everyone. Do it when the categories or wording change. */
export const CONSENT_VERSION = 1;

export const CONSENT_KEY = `lal:consent:v${CONSENT_VERSION}`;

export type ConsentCategory = "necessary" | "map";

/** Every category the site can know about. The banner renders from this. */
export const ALL_CATEGORIES: readonly ConsentCategory[] = ["necessary", "map"];

/**
 * Categories the visitor can refuse.
 *
 * "necessary" is absent on purpose: it is the storage required to serve a page
 * and to remember this very decision, and a banner offering to switch it off is a
 * banner that breaks the site when accepted. This is disclosed, not offered.
 */
export const OPTIONAL_CATEGORIES: readonly ConsentCategory[] = ["map"];

export type ConsentChoice = {
  version: number;
  granted: boolean;
};

export type ConsentState = "undecided" | "granted" | "refused";

export function isValidChoice(value: unknown): value is ConsentChoice {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ConsentChoice>;
  return record.version === CONSENT_VERSION && typeof record.granted === "boolean";
}

function storage(): Storage | null {
  try {
    // Private-mode Safari and locked-down browsers make localStorage throw on
    // write rather than return null. Consent must never break a page.
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readConsent(): ConsentChoice | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(CONSENT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidChoice(parsed) ? parsed : null;
  } catch {
    // Corrupt or hand-edited value. Treat it as no answer rather than guessing.
    return null;
  }
}

export function writeConsent(granted: boolean): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(CONSENT_KEY, JSON.stringify({ version: CONSENT_VERSION, granted }));
  } catch {
    /* a full or blocked store is not worth an error */
  }
}

export function clearConsent(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(CONSENT_KEY);
  } catch {
    /* see writeConsent */
  }
}

/** Fired on `window` after a choice is recorded, so every consumer can re-read. */
export const CONSENT_EVENT = "lal:consent-changed";

/**
 * Record a choice and tell the rest of the page.
 *
 * Writing and announcing are one operation because doing them separately is how
 * a "turn the map back on" button ends up with a hardcoded copy of `CONSENT_KEY`
 * and a version number that outlives the constant it was copied from.
 */
export function setConsent(granted: boolean): void {
  writeConsent(granted);
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: granted }));
}

export function consentState(choice: ConsentChoice | null = readConsent()): ConsentState {
  if (!choice) return "undecided";
  return choice.granted ? "granted" : "refused";
}

/**
 * Whether a category's third-party requests may be made.
 *
 * Undecided is NOT granted. That is the whole point: the globe stays withheld
 * until somebody answers, so no tile is requested and no IP address leaves the
 * device on a first visit.
 */
export function isCategoryAllowed(category: ConsentCategory, choice?: ConsentChoice | null): boolean {
  if (category === "necessary") return true;
  const resolved = choice === undefined ? readConsent() : choice;
  return resolved !== null && resolved.granted;
}

export interface ConsentCategoryDoc {
  category: ConsentCategory;
  label: string;
  detail: string;
  optional: boolean;
}

/**
 * The disclosure rows. These strings and these rows are the cookie policy's
 * substance — `CookieConsent` renders them and `/cookies` repeats them, so the
 * banner and the policy cannot drift apart.
 */
export function describeCategories(): readonly ConsentCategoryDoc[] {
  return [
    {
      category: "necessary",
      label: "Strictly necessary",
      detail:
        "Your consent answer, stored in this browser only. No third party receives it, and nothing is kept on our side.",
      optional: false,
    },
    {
      category: "map",
      label: "Map tiles",
      detail:
        "The globe's basemap imagery is fetched from the OpenStreetMap Foundation tile server. Those requests carry your IP address, your browser's User-Agent and the part of the globe you are looking at. No account, cookie or identifier is set by us alongside them.",
      optional: true,
    },
  ];
}

/**
 * Categories in `ALL_CATEGORIES` with no row in `describeCategories()`.
 *
 * Non-empty means somebody added a switchable category and forgot to describe
 * it, which would be a consent dialog granting a permission it never named.
 */
export function unknownCategories(): readonly ConsentCategory[] {
  const described = new Set(describeCategories().map((row) => row.category));
  return ALL_CATEGORIES.filter((category) => !described.has(category));
}
