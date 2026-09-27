/**
 * Who operates this site, and the terms the legal pages quote.
 *
 * WHY A FILE AND NOT INLINE PROSE. A privacy policy that names a company in
 * three places and an address in two is a policy that will be half-updated after
 * the company moves. Every page renders the operator from this object, so there
 * is exactly one place to edit.
 *
 * WHY EVERY FIELD IS NULLABLE, AND WHY THEY ARE ALL CURRENTLY NULL. A privacy
 * policy that is missing the operator's registered address is not a privacy
 * policy. Writing a plausible one would be the worst thing this file could do —
 * inventing a company name, a postal address or a registration number is the
 * same class of false claim this codebase was cleaned up for. `null` means
 * unfilled and the pages say so visibly, which `missingOperatorDetails()` drives.
 *
 * DPDP Act 2023 section 5(1) requires a Data Fiduciary to publish the name and
 * contact of the Data Fiduciary and any Data Processor. Until `legalName` and
 * `privacyEmail` are filled, this site does not meet that duty, and the footer
 * carries a visible marker rather than silently omitting the block.
 *
 * THIS IS THE ONE FILE TO EDIT BEFORE ANY PUBLIC LAUNCH.
 */

export type Unfilled = null;

export interface BusinessDetails {
  /** The legal entity operating the site. Rendered in the footer and on /terms. */
  legalName: string | Unfilled;
  /** The name the product is known by. Not a legal name. */
  productName: string;
  registeredAddress: readonly string[] | Unfilled;
  /** Jurisdiction whose law governs the terms. */
  jurisdiction: string | Unfilled;
  /** Reaches the Data Fiduciary's grievance channel. */
  privacyEmail: string | Unfilled;
  supportEmail: string | Unfilled;
  registrationNumber: string | Unfilled;
  /** Year first published, for the copyright line. */
  firstPublished: number;
}

export const BUSINESS: BusinessDetails = {
  legalName: null,
  productName: "Like a Local Guide",
  registeredAddress: null,
  jurisdiction: null,
  privacyEmail: null,
  supportEmail: null,
  registrationNumber: null,
  firstPublished: 2026,
};

/** The date the terms were last changed. Bump this when BUSINESS changes. */
export const LEGAL_REVISION = "2026-01-15";

/** A field is filled only if it is a non-empty string or a non-empty address. */
export function isFilled(value: string | readonly string[] | Unfilled): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return (value as string).trim().length > 0;
}

/**
 * The operator fields that are still blank. An empty array means the legal pages
 * are complete enough to publish. Until then they render a visible marker, which
 * is the honest outcome — a published policy with invented contact details is
 * worse than an obviously unfinished one.
 */
export function missingOperatorDetails(details: BusinessDetails = BUSINESS): readonly string[] {
  const required: ReadonlyArray<readonly [string, string | readonly string[] | Unfilled]> = [
    ["legalName", details.legalName],
    ["registeredAddress", details.registeredAddress],
    ["jurisdiction", details.jurisdiction],
    ["privacyEmail", details.privacyEmail],
  ];
  return required.filter(([, value]) => !isFilled(value)).map(([key]) => key);
}

export function isLaunchReady(details: BusinessDetails = BUSINESS): boolean {
  return missingOperatorDetails(details).length === 0;
}

/**
 * The copyright line. Falls back to the product name rather than an empty
 * operator, so the footer is never blank.
 */
export function copyrightLine(details: BusinessDetails = BUSINESS, now = new Date()): string {
  const year = now.getFullYear();
  const first = details.firstPublished;
  const span = year > first ? `${first}–${year}` : String(first);
  const who = isFilled(details.legalName) ? details.legalName : details.productName;
  return `© ${span} ${who}`;
}
