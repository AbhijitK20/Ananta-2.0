/**
 * Unmet demand -> opportunity -> provider action. The flywheel.
 *
 * Three rules this file exists to hold:
 *
 *  1. A rejection that is not a supply gap never becomes an opportunity. If the
 *     traveller excluded it, or it is 40 km away, or it was already in the plan,
 *     no listing change on earth fixes that, and pretending otherwise is how a
 *     dashboard turns into marketing copy.
 *  2. Never suggest something already offered. Every fix is checked against the
 *     provider's own listings before it is shown.
 *  3. Every claim carries a count. Nothing is emitted without `n`.
 *
 * `estimatedImpact` on the contract payload is deliberately always null: the
 * contract reserves it for a measured effect, and we do not have one yet. A
 * dashboard of unmeasured predictions is worse than no dashboard.
 */
import type { Experience, Provider, ProviderOpportunity, RejectionCode } from "../../contracts";
import { MIN_SAMPLE, RADIUS_KM, WINDOW_DAYS, distanceKm, humanise } from "./aggregate";
import { describeWindow, formatInr, formatMinutes, suggestedWindow, timeBucketLabel } from "./format";
import type { ClaimTier, DemandCell, Opportunity, ProviderSuggestion, SuggestionKind, SupplyFix } from "./types";

/** Cap on a provider's suggestion list. Past this it is a to-do list, not a feed. */
export const MAX_SUGGESTIONS = 6;

/**
 * Two different bars, on purpose.
 *
 * An OPPORTUNITY is something a provider might want to act on, so a thin cell
 * is still shown — badged `inferred`, with its count in plain sight. A
 * SUGGESTION is us telling a provider to change their listing, and that needs
 * `MIN_SAMPLE` searches behind it or we would be guessing on their behalf.
 */
export const MIN_CELL_FOR_OPPORTUNITY = 2;

// --- what a rejection code points at --------------------------------------

const ACCESS_KEYS = {
  not_step_free: "stepFree",
  not_stroller_ok: "strollerOk",
  no_low_stairs: "lowStairs",
  no_hearing_loop: "hearingLoop",
  no_restroom: "restroomOnSite",
} as const;

type AccessKey = (typeof ACCESS_KEYS)[keyof typeof ACCESS_KEYS];

const ACCESS_LABEL: Record<AccessKey, string> = {
  stepFree: "step-free access",
  strollerOk: "stroller access",
  lowStairs: "few stairs",
  hearingLoop: "a hearing loop",
  restroomOnSite: "a restroom on site",
};

function accessFix(code: RejectionCode, key: AccessKey): SupplyFix {
  return {
    field: `accessibility.${key}`,
    label: ACCESS_LABEL[key],
    state: (listing) => {
      const v = listing.accessibility[key];
      return v === true ? "offered" : v === null ? "unknown" : "absent";
    },
    suggestionKind: "accessibility_attribute",
    contractKind: "listing_quality",
  };
}

function priceFix(): SupplyFix {
  return {
    field: "pricePerPerson",
    label: "a lower price band",
    state: (listing, cell) => {
      if (cell.budgetMinor === null) return "offered";
      if (listing.pricePerPerson === null) return "offered";
      return listing.pricePerPerson.minor <= cell.budgetMinor ? "offered" : "absent";
    },
    suggestionKind: "price_band",
    contractKind: "listing_quality",
  };
}

function capacityFix(): SupplyFix {
  return {
    field: "capacity",
    label: "room for a larger group",
    state: (listing, cell) =>
      listing.capacity === null || listing.capacity >= cell.partySize ? "offered" : "absent",
    suggestionKind: "capacity",
    contractKind: "capacity_window",
  };
}

function windowFix(): SupplyFix {
  return {
    field: "bestTimeOfDay",
    label: "an open slot at that hour",
    state: (listing, cell) => {
      if (cell.timeBucket === null) return "unknown";
      return listing.bestTimeOfDay.includes(cell.timeBucket) ? "offered" : "absent";
    },
    suggestionKind: "availability_window",
    contractKind: "capacity_window",
  };
}

function bookingFix(): SupplyFix {
  return {
    field: "booking",
    label: "a walk-in slot",
    state: (listing) => (listing.booking.required && !listing.booking.walkIn ? "absent" : "offered"),
    suggestionKind: "availability_window",
    contractKind: "capacity_window",
  };
}

/**
 * Which rejection codes point at something a provider can change, and what that
 * something is. A code absent from this table produces no opportunity.
 */
const FIXABLE: Partial<Record<RejectionCode, SupplyFix>> = {
  not_step_free: accessFix("not_step_free", "stepFree"),
  not_stroller_ok: accessFix("not_stroller_ok", "strollerOk"),
  no_low_stairs: accessFix("no_low_stairs", "lowStairs"),
  no_hearing_loop: accessFix("no_hearing_loop", "hearingLoop"),
  no_restroom: accessFix("no_restroom", "restroomOnSite"),

  inaccessible: {
    field: "accessibility",
    label: "accessibility details",
    state: (listing) => {
      const values = Object.values(listing.accessibility);
      if (values.some((v) => v === null)) return "unknown";
      return values.every((v) => v === true) ? "offered" : "absent";
    },
    suggestionKind: "accessibility_metadata",
    contractKind: "listing_quality",
  },

  over_budget: priceFix(),
  over_budget_per_person: priceFix(),

  duration_exceeds_budget: {
    field: "durationMin",
    label: "a shorter version",
    state: (listing, cell) => (listing.durationMin <= cell.availableMin ? "offered" : "absent"),
    suggestionKind: "shorter_duration",
    contractKind: "listing_quality",
  },

  weather_unsafe: {
    field: "indoorOutdoor",
    label: "an indoor option",
    state: (listing) =>
      listing.indoorOutdoor === "indoor" || listing.indoorOutdoor === "mixed" ? "offered" : "absent",
    suggestionKind: "indoor_option",
    contractKind: "listing_quality",
  },

  closed_now: windowFix(),
  closed_during_window: windowFix(),
  hours_unverified: windowFix(),

  sold_out: capacityFix(),
  capacity_exceeded: capacityFix(),

  lead_time_too_short: bookingFix(),
  requires_booking_not_available: bookingFix(),

  diet_mismatch: {
    field: "diets",
    label: "dietary tags",
    state: (listing) => (listing.diets.length > 0 ? "offered" : "absent"),
    suggestionKind: "listing_metadata",
    contractKind: "listing_quality",
  },

  seasonal_mismatch: {
    field: "bestMonths",
    label: "the months you run",
    state: (listing) => (listing.bestMonths.length > 0 ? "offered" : "absent"),
    suggestionKind: "listing_metadata",
    contractKind: "listing_quality",
  },
};

/**
 * Codes that are never a provider's fault to fix. Enumerated rather than left
 * as an absent table entry so a test can hold the line.
 */
export const NEVER_AN_OPPORTUNITY: ReadonlySet<RejectionCode> = new Set<RejectionCode>([
  "too_far",
  "travel_time_exceeds_budget",
  "duplicate",
  "already_planned",
  "excluded_by_traveller",
  "mustsee_conflict",
]);

export function fixFor(code: RejectionCode): SupplyFix | null {
  return FIXABLE[code] ?? null;
}

// --- matching -------------------------------------------------------------

export interface BuildOptions {
  minSample?: number;
  windowDays?: number;
  radiusKm?: number;
  datasetLabel?: string;
  /** Bar for showing an opportunity at all. Defaults to 2 searches. */
  minCell?: number;
}

function options(opts: BuildOptions = {}): Required<BuildOptions> {
  return {
    minSample: opts.minSample ?? MIN_SAMPLE,
    windowDays: opts.windowDays ?? WINDOW_DAYS,
    radiusKm: opts.radiusKm ?? RADIUS_KM,
    datasetLabel: opts.datasetLabel ?? "Unmet-demand feed",
    minCell: opts.minCell ?? MIN_CELL_FOR_OPPORTUNITY,
  };
}

/** A listing can serve a cell when it is close enough and in the right trade. */
function servesCell(listing: Experience, cell: DemandCell, radiusKm: number): boolean {
  if (distanceKm(listing.location, cell.point) > radiusKm) return false;
  return cell.category === null || listing.category === cell.category;
}

function listingsOf(listings: readonly Experience[], providerId: string): Experience[] {
  return listings.filter((l) => l.providerId === providerId);
}

/**
 * Opportunities for every provider, best first.
 *
 * Ordered by sample size then id — fully determined by the data, never by
 * insertion order, so the feed does not reshuffle between renders.
 */
export function buildOpportunities(
  cells: readonly DemandCell[],
  listings: readonly Experience[],
  providers: readonly Provider[],
  opts: BuildOptions = {},
): Opportunity[] {
  const o = options(opts);
  const out: Opportunity[] = [];

  for (const cell of cells) {
    const fix = fixFor(cell.blockingCode);
    if (fix === null || NEVER_AN_OPPORTUNITY.has(cell.blockingCode)) continue;
    if (cell.n < o.minCell) continue;

    for (const provider of providers) {
      const relevant = listingsOf(listings, provider.id).filter((l) => servesCell(l, cell, o.radiusKm));
      if (relevant.length === 0) continue;
      const index = relevant.findIndex((l) => fix.state(l, cell) !== "offered");
      if (index < 0) continue;

      const target = relevant[index]!;
      const state = fix.state(target, cell) === "unknown" ? "unknown" : "absent";
      const nearbyMatches = listings.filter(
        (l) => l.providerId !== provider.id && servesCell(l, cell, o.radiusKm),
      ).length;

      const evidence = buildEvidence(cell, fix, {
        nearbyMatches,
        radiusKm: o.radiusKm,
        windowDays: o.windowDays,
        datasetLabel: o.datasetLabel,
        state,
      });
      const cta = buildCta(cell, fix, provider, target, state);

      out.push({
        id: `opp-${provider.id}-${cell.key}`,
        providerId: provider.id,
        providerName: provider.name,
        tier: cell.reliable ? "observed" : "inferred",
        contract: {
          providerId: provider.id,
          kind: fix.contractKind,
          headline: buildHeadline(cell, fix, o.windowDays),
          evidence,
          estimatedImpact: null,
          cta,
        },
        demand: {
          neighbourhood: cell.neighbourhood,
          category: cell.category,
          categoryTier: cell.categoryTier,
          preferredBudgetMinor: cell.budgetMinor,
          preferredTime: cell.timeBucket,
          preferredTimeTier: cell.timeTier,
          constraints: {
            availableMin: cell.availableMin,
            partySize: cell.partySize,
            accessNeeds: cell.accessNeeds,
            weather: cell.weather,
            kidSignal: cell.kidSignal,
          },
        },
        missingSupply: { code: cell.blockingCode, field: fix.field, label: fix.label },
        cta,
        evidence,
        nearbyMatches,
        sampleSize: cell.n,
      });
    }
  }

  return out.sort((a, b) =>
    b.sampleSize !== a.sampleSize ? b.sampleSize - a.sampleSize : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

export function opportunitiesFor(
  opportunities: readonly Opportunity[],
  providerId: string,
): Opportunity[] {
  return opportunities.filter((o) => o.providerId === providerId);
}

interface EvidenceArgs {
  nearbyMatches: number;
  radiusKm: number;
  windowDays: number;
  datasetLabel: string;
  state: "absent" | "unknown";
}

function buildEvidence(
  cell: DemandCell,
  fix: SupplyFix,
  args: EvidenceArgs,
): { label: string; value: string }[] {
  const evidence: { label: string; value: string }[] = [
    { label: "searches", value: `${cell.n} in the last ${args.windowDays} days` },
    { label: `blocked on ${cell.blockingCode}`, value: `${cell.blockedCandidates} candidates` },
  ];
  if (cell.budgetMinor !== null) {
    evidence.push({ label: "median budget", value: formatInr(cell.budgetMinor) });
  }
  evidence.push({ label: "median window", value: formatMinutes(cell.availableMin) });
  evidence.push({ label: "median party", value: `${cell.partySize} people` });
  if (cell.accessNeeds.length > 0) {
    evidence.push({ label: "asked for", value: cell.accessNeeds.map(humanise).join(", ") });
  }
  if (cell.kidSignal) {
    evidence.push({ label: "group or family signal", value: "a group of three or more, or a stated family need" });
  }
  if (cell.weather.length > 0) {
    evidence.push({ label: "weather", value: cell.weather.map(humanise).join(", ") });
  }
  evidence.push({
    label: "time of day",
    value:
      cell.timeBucket === null
        ? `no clear pattern across ${cell.n} searches`
        : `${timeBucketLabel(cell.timeBucket)} (${cell.timeTier})`,
  });
  evidence.push({
    label: `listings within ${args.radiusKm} km`,
    value:
      args.nearbyMatches === 0
        ? "none other than yours"
        : `${args.nearbyMatches} other ${args.nearbyMatches === 1 ? "listing" : "listings"}`,
  });
  evidence.push({
    label: `${fix.field} on your listing`,
    value: args.state === "unknown" ? "never confirmed" : "not offered",
  });
  evidence.push({
    label: "category read from the traveller's own words",
    value: cell.category === null ? "nothing recognisable" : cell.categoryTier,
  });
  evidence.push({ label: "source", value: args.datasetLabel });
  return evidence;
}

/**
 * Plural names for the categories whose plural is not `+s`. A headline reading
 * "Music lives" is worse than no headline, and these strings are the product's
 * voice, so they get written rather than generated.
 */
const CATEGORY_PLURAL: Readonly<Record<string, string>> = {
  music_live: "live music sessions",
  street_food: "street food stops",
  dance_performance: "dance performances",
  art_studio: "art studios",
  craft_workshop: "craft workshops",
  community_hosted: "community-hosted sessions",
  heritage_site: "heritage walks",
  hidden_place: "hidden places",
  festival: "festivals",
  event: "events",
  market: "markets",
  gallery: "galleries",
  theatre: "theatres",
  wellness: "wellness sessions",
  nightlife: "night spots",
  adventure: "adventure activities",
  restaurant: "restaurants",
  cafe: "cafes",
};

function categoryWord(cell: DemandCell): string {
  if (cell.category === null) return "experiences";
  const plural = CATEGORY_PLURAL[cell.category];
  if (plural !== undefined) return plural;
  // Mid-sentence, so the fallback starts lower-case. "Restaurants in the
  // afternoon" reads like a title; "restaurants in the afternoon" reads like us.
  return `${humanise(cell.category).charAt(0).toLowerCase()}${humanise(cell.category).slice(1)}s`;
}

function whenPhrase(cell: DemandCell): string {
  if (cell.timeBucket === null) return "";
  return ` in the ${timeBucketLabel(cell.timeBucket).toLowerCase()}`;
}

function buildHeadline(cell: DemandCell, fix: SupplyFix, windowDays: number): string {
  const budget = cell.budgetMinor === null ? "" : ` under ${formatInr(cell.budgetMinor)}`;
  const lead =
    `Travellers asked for ${fix.label} — ${categoryWord(cell)}` +
    `${whenPhrase(cell)} around ${cell.neighbourhood}${budget} — and got nothing`;
  return `${lead}: ${cell.n} searches in ${windowDays} days, ${cell.blockedCandidates} candidates blocked on ${cell.blockingCode}.`;
}

function buildCta(
  cell: DemandCell,
  fix: SupplyFix,
  provider: Provider,
  target: Experience,
  state: "absent" | "unknown",
): string {
  switch (fix.field) {
    case "accessibility.stepFree":
    case "accessibility.strollerOk":
    case "accessibility.lowStairs":
    case "accessibility.hearingLoop":
    case "accessibility.restroomOnSite":
      return state === "unknown"
        ? `Confirm ${fix.label} at ${target.name}. Unconfirmed reads as absent, so you are skipped.`
        : `Add ${fix.label} to ${target.name} at ${provider.name}.`;
    case "accessibility":
      return `Fill in the accessibility fields on ${target.name}. Several are still unknown, and unknown reads as absent.`;
    case "pricePerPerson":
      return cell.budgetMinor === null
        ? `Review pricing on ${target.name}. ${cell.n} searches near ${cell.neighbourhood} came in with a ceiling it did not meet.`
        : `Add a ${formatInr(cell.budgetMinor)} slot at ${provider.name}; ${target.name} starts at ${formatInr(target.pricePerPerson?.minor ?? null)}.`;
    case "durationMin":
      return `Add a ${formatMinutes(cell.availableMin)} version of ${target.name}; the median window in those searches was ${formatMinutes(cell.availableMin)}.`;
    case "indoorOutdoor":
      return `Add an indoor option to ${target.name}, or publish a wet-weather plan.`;
    case "bestTimeOfDay": {
      const win = suggestedWindow(cell.timeBucket ?? "evening");
      const price = cell.budgetMinor === null ? "" : ` ${formatInr(cell.budgetMinor)}`;
      return `Add a ${formatMinutes(target.durationMin)}${price} slot at ${provider.name}, ${describeWindow(win.from, win.to)}.`;
    }
    case "capacity":
      return `Raise capacity on ${target.name} above ${cell.partySize}, or add a larger-group slot.`;
    case "booking":
      return `Allow walk-ins on ${target.name}.`;
    case "diets":
      return `Add dietary tags to ${target.name}.`;
    case "bestMonths":
      return `Add the months you actually run to ${target.name}.`;
    default:
      return `Review ${target.name} against ${cell.blockingCode}: ${cell.n} searches near ${cell.neighbourhood} in the last 14 days.`;
  }
}

// --- suggestions ----------------------------------------------------------

interface Proposal {
  kind: SuggestionKind;
  field: string;
  cells: DemandCell[];
  target: Experience;
  fix: SupplyFix | null;
  state: "absent" | "unknown";
  cell: DemandCell;
}

/**
 * Concrete listing changes, aggregated across every cell that wants the same
 * change. Two generators feed it: the rejection-code fixes above, and family
 * demand, which is a cross-cutting signal (a party of four is a party of four
 * whatever blocked it) and so has no single code of its own.
 *
 * Emitted only when a well-sampled cell asks for it AND the provider does not
 * already offer it, so the list can never contain a no-op.
 */
export function buildProviderSuggestions(
  provider: Provider,
  listings: readonly Experience[],
  cells: readonly DemandCell[],
  opts: BuildOptions = {},
): ProviderSuggestion[] {
  const o = options(opts);
  const mine = listingsOf(listings, provider.id);
  if (mine.length === 0) return [];

  const wellSampled = cells.filter((c) => c.n >= o.minSample);
  const groups = new Map<string, Proposal>();

  const add = (key: string, seed: Proposal): void => {
    const existing = groups.get(key);
    if (existing) existing.cells.push(seed.cell);
    else groups.set(key, { ...seed, cells: [seed.cell] });
  };

  for (const cell of wellSampled) {
    const fix = fixFor(cell.blockingCode);
    if (fix === null || NEVER_AN_OPPORTUNITY.has(cell.blockingCode)) continue;
    const relevant = mine.filter((l) => servesCell(l, cell, o.radiusKm));
    const index = relevant.findIndex((l) => fix.state(l, cell) !== "offered");
    if (index < 0) continue;
    const target = relevant[index]!;
    const state = fix.state(target, cell) === "unknown" ? "unknown" : "absent";
    // Unconfirmed accessibility and a confirmed `false` are different problems
    // with different fixes, so they get different kinds.
    const kind: SuggestionKind =
      state === "unknown" && fix.field.startsWith("accessibility")
        ? "accessibility_metadata"
        : fix.suggestionKind;
    add(`${kind}|${fix.field}`, { kind, field: fix.field, cells: [], target, fix, state, cell });
  }

  for (const cell of wellSampled) {
    if (!cell.kidSignal) continue;
    const relevant = mine.filter((l) => servesCell(l, cell, o.radiusKm));
    const index = relevant.findIndex((l) => l.kidFriendly !== true);
    if (index < 0) continue;
    add("family_package|kidFriendly", {
      kind: "family_package",
      field: "kidFriendly",
      cells: [],
      target: relevant[index]!,
      fix: null,
      state: "absent",
      cell,
    });
  }

  const suggestions: ProviderSuggestion[] = [];
  for (const [key, group] of groups) {
    const sampleSize = group.cells.reduce((a, c) => a + c.n, 0);
    if (sampleSize < o.minSample) continue;
    const blockedCandidates = group.cells.reduce((a, c) => a + c.blockedCandidates, 0);
    // Two different questions, two different answers, and conflating them is the
    // one mistake this whole layer exists to prevent:
    //   evidenceTier  how well sampled the DEMAND behind the suggestion is.
    //   tier          what the SUGGESTION itself is, and the answer is always
    //                 "suggested": we know people searched, we do not know what
    //                 will happen if the provider acts. Badging a recommendation
    //                 "observed" is how a dashboard ends up printing
    //                 "observed: 27 searches" next to a button and implying the
    //                 27 is an outcome.
    const evidenceTier: ClaimTier = group.cells.every((c) => c.reliable) ? "observed" : "inferred";
    const lead = group.cells[0]!;

    suggestions.push({
      id: `sug-${provider.id}-${key}`,
      providerId: provider.id,
      kind: group.kind,
      tier: "suggested",
      action: describeAction(group, o),
      cta: group.fix === null ? familyCta(group, o) : buildCta(lead, group.fix, provider, group.target, group.state),
      targetField: group.field,
      evidence: [
        { label: "searches", value: `${sampleSize} in the last ${o.windowDays} days` },
        { label: "candidates blocked", value: `${blockedCandidates}` },
        { label: "where", value: [...new Set(group.cells.map((c) => c.neighbourhood))].sort().join(", ") },
        { label: "blocked on", value: [...new Set(group.cells.map((c) => c.blockingCode))].sort().join(", ") },
        { label: "demand evidence", value: evidenceTier },
        { label: "field", value: group.field },
        { label: "source", value: o.datasetLabel },
      ],
      sampleSize,
      blockedCandidates,
      cellKeys: group.cells.map((c) => c.key).sort(),
    });
  }

  return suggestions
    .sort((a, b) =>
      b.sampleSize !== a.sampleSize ? b.sampleSize - a.sampleSize : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    .slice(0, MAX_SUGGESTIONS);
}

function describeAction(group: Proposal, o: Required<BuildOptions>): string {
  const { target, state, kind, cells } = group;
  const hood = cells[0]?.neighbourhood ?? "your area";
  const n = cells.reduce((a, c) => a + c.n, 0);
  switch (kind) {
    case "accessibility_metadata":
      return `Confirm the accessibility fields on ${target.name}. Unknown reads as absent, so every search that needs access passes ${target.name} by. ${n} searches in the last ${o.windowDays} days needed it near ${hood}.`;
    case "accessibility_attribute":
      return `Add ${group.fix?.label ?? "access"} to ${target.name}. ${n} searches in the last ${o.windowDays} days near ${hood} were blocked because it is ${state === "absent" ? "not offered" : "never confirmed"}.`;
    case "availability_window":
      return `Add a fixed slot near ${hood}'s demanded hours on ${target.name}. "Usually open" is not a slot; a time range is.`;
    case "family_package":
      return `Mark ${target.name} kid-friendly or add a family package. ${n} searches in the last ${o.windowDays} days near ${hood} were a group of three or more or named a family need, and ${target.name} is not marked for children.`;
    case "price_band":
      return `Add a lower price band to ${target.name}. ${n} searches near ${hood} in the last ${o.windowDays} days came in below its current price.`;
    case "indoor_option":
      return `Add an indoor option to ${target.name}. Rain is what removed it from ${n} searches near ${hood}, not the season.`;
    case "shorter_duration":
      return `Add a shorter version of ${target.name}. The median window in those ${n} searches was ${formatMinutes(cells[0]?.availableMin ?? 0)}.`;
    case "capacity":
      return `Add capacity for groups above ${cells[0]?.partySize ?? 4} on ${target.name}. ${n} searches near ${hood} were turned away for want of seats.`;
    case "listing_metadata":
      return `Fill in ${group.field} on ${target.name}. ${n} searches in the last ${o.windowDays} days near ${hood} were filtered on it.`;
  }
}

function familyCta(group: Proposal, o: Required<BuildOptions>): string {
  const budget = group.cells.find((c) => c.budgetMinor !== null)?.budgetMinor ?? null;
  const n = group.cells.reduce((a, c) => a + c.n, 0);
  const price = budget === null ? "" : ` at ${formatInr(budget)}`;
  return `Set kidFriendly on ${group.target.name} and add a family slot${price}. ${n} searches in the last ${o.windowDays} days near ${group.cells[0]?.neighbourhood ?? "you"} involved a group of three or more.`;
}
