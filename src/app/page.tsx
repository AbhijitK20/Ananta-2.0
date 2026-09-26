import type { Metadata } from "next";

import {
  DiscoveryContext as DiscoveryContextSchema,
  type DiscoveryContext,
  type Experience,
  type Fit,
  type Plan,
  type Rejection,
  type ScoreBreakdown,
} from "@/contracts";

import { DiscoverySurface } from "./_components/DiscoverySurface";
import { loadCatalogue } from "./_lib/catalogue";
import { loadEngine } from "./_lib/engine";

/*
  Imported from the barrel, `@/engine`, which is now safe to do.

  This used to import by module path and carry a comment explaining why: an
  ambient `engine-seam.d.ts` declared `module "@/engine"` and gave the barrel
  fictional signatures that `computeFit`'s real third argument did not fit
  through. That declaration is deleted. The barrel types are the real ones now,
  so a signature change in the engine is a compile error on this page instead of
  a runtime surprise in production.
*/
import { DEFAULT_PROFILE, computeFit, planItinerary, score } from "@/engine";
import { weekdayOf } from "@/lib/time";

import {
  FIXTURE_EXPERIENCES,
  FIXTURE_FITS,
  FIXTURE_PLAN,
  FIXTURE_REJECTIONS,
  FIXTURE_SCORES,
  FIXTURE_WEIGHTS,
  FIXTURE_CONTEXT,
} from "./_fixtures";

export const metadata: Metadata = {
  title: "Plans that actually fit",
  description:
    "Three hours, four people, one a toddler, and someone who cannot manage stairs. Here is what fits, and here is what does not.",
};

/*
  Dynamic on purpose. This page reads the catalogue from disk and runs the real
  engine over it, so a build that prerendered it would freeze one catalogue and
  one plan into the HTML. The cost is a server render per request, which is the
  right trade for a page whose entire value is "here is what fits, right now".
*/
export const dynamic = "force-dynamic";

/**
 * The traveller situation this page opens on.
 *
 * Parsed through the frozen schema rather than typed by hand, so a field the
 * contract requires cannot be quietly missing here and blow up three modules
 * downstream. The numbers are a real scenario rather than placeholders: three
 * hours in the afternoon, two adults, a budget, and one step-free access need,
 * because that is the case the product is actually about and an empty budget
 * would make every card pass for the wrong reason.
 */
const OPENING_CONTEXT = DiscoveryContextSchema.parse({
  id: "mumbai-opening",
  // The label was wrong and said "Colaba". Real Colaba is near 18.92N; this
  // point is in Bandra West. Verified against the harvested catalogue: the eight
  // nearest rows are Wings Sports Centre - Bandra (149 m), Bombay Daak (188 m),
  // Love in Langos, Ganpati Mandir, Candies, The C Spot Cafe, The Bombay Art
  // Society and Long Garden — all Bandra West landmarks. A wrong label here is
  // not cosmetic: it is what the map centres on and what the user is told they
  // are standing in.
  origin: { label: "Bandra West, Mumbai", point: { lat: 19.0495, lon: 72.832 } },
  availableMin: 180,
  nowMin: 840, // 14:00
  budget: { minor: 300000, currency: "INR" }, // ₹3,000
  budgetPerPerson: null,
  partySize: 2,
  partyType: "couple",
  childAges: [],
  accessNeeds: ["lowStairs"],
  diets: [],
  interests: ["street_food", "market", "heritage", "art"],
  avoid: [],
  weather: { condition: "clear", tempC: 29, source: "live" },
  travelMode: "walk",
  requests: [],
  excludedIds: [],
  pinnedIds: [],
  original: {
    availableMin: 180,
    budget: { minor: 300000, currency: "INR" },
    partySize: 2,
    accessNeeds: ["lowStairs"],
  },
} satisfies DiscoveryContext);

export default async function Page() {
  const [engine, catalogue] = await Promise.all([loadEngine(), loadCatalogue()]);

  /*
    Production path: the real engine over the real catalogue.

    Both must be present. The engine alone is not enough, because a plan built
    from six hardcoded rows is not a plan, and the catalogue alone is not enough
    either, because without the engine there is nothing to rank it or decide what
    fits. When either is missing we fall back to the fixtures AND say so, in the
    badge, because a page that looks live while serving invented rows is the one
    failure mode this whole seam was built to prevent.
  */
  if (engine.ready && catalogue.experiences.length > 0) {
    /*
      `weekdayOf` rather than a literal. The old value here was `6` with the
      comment "Saturday", but `lib/time` numbers weekdays 0 = Monday, so 6 is
      SUNDAY — the gate was evaluating Sunday's opening hours for a plan whose
      own comment claimed Saturday. `lib/time` warns about exactly this
      conflation, and it is invisible because both are small integers.

      Derived from the clock for the same reason `month` already was: the
      catalogue's hours are real OSM hours, so they should be checked against
      the real day rather than a hard-coded one that silently rots.
    */
    const now = new Date();
    const weekday = weekdayOf(now);

    const result = planItinerary(OPENING_CONTEXT, catalogue.experiences, {
      weekday,
      month: now.getMonth() + 1,
      mode: "walk",
      planId: "mumbai-opening",
    });

    /*
      The shortlist, and why it is bounded.

      This used to loop all 4,982 rows computing a `Fit` and a `ScoreBreakdown`
      for each, then hand `catalogue.experiences`, `fits` and `scores` to a
      client component. The deployed response was 48.9 MB of HTML and 22 seconds
      to first byte, because every row — provenance, perception, booking and all
      — was serialised into the RSC flight payload and then turned into ~4,900
      live `ResultCard`s on arrival.

      Retrieval already ranked the catalogue down to 120 rows by BM25 and geo
      reach, and `PlanResult.candidateIds` now hands that ranking back instead of
      discarding it. Anything the gate rejected is force-included, because the
      "why not that" ledger is the product and a rejection with no card is
      invisible. Everything else is a scored fallback below the retrieved set, so
      the list can still fill out when the gate is strict.
    */
    const shortlisted = shortlist(
      catalogue.experiences,
      result.candidateIds,
      result.plan,
      result.rejected,
    );

    const fits: Record<string, Fit> = {};
    const scores: Record<string, ScoreBreakdown> = {};
    for (const experience of shortlisted) {
      const travelMin = travelEstimate(OPENING_CONTEXT, experience);
      // The visit window is the card's own slot, placed as early as the
      // traveller could reach it. It is a per-card estimate, not the plan's
      // schedule, so the only thing it has to be right about is the HOURS: a
      // card whose window falls outside its opening hours must read closed.
      const visitFrom = OPENING_CONTEXT.nowMin + travelMin + 10;
      fits[experience.id] = computeFit(OPENING_CONTEXT, experience, {
        travelMin,
        bufferMin: 10,
        visitFrom,
        visitTo: visitFrom + experience.durationMin,
        cost:
          experience.pricePerPerson === null
            ? { minor: 0, currency: "INR" }
            : experience.pricePerPerson,
        weekday,
      });
      scores[experience.id] = score(OPENING_CONTEXT, experience, DEFAULT_PROFILE, {
        travelMin,
      });
    }

    return (
      <DiscoverySurface
        initialPlan={result.plan}
        context={OPENING_CONTEXT}
        experiences={shortlisted}
        fits={fits}
        scores={scores}
        rejections={result.rejected}
        weights={DEFAULT_PROFILE}
        source="engine"
        catalogueSize={catalogue.experiences.length}
      />
    );
  }

  return (
    <DiscoverySurface
      initialPlan={FIXTURE_PLAN}
      context={FIXTURE_CONTEXT}
      experiences={FIXTURE_EXPERIENCES}
      fits={FIXTURE_FITS}
      scores={FIXTURE_SCORES}
      rejections={FIXTURE_REJECTIONS}
      weights={FIXTURE_WEIGHTS}
      source="fixtures"
    />
  );
}

/**
 * How many ranked candidates the list may show beyond the planned and rejected
 * rows.
 *
 * ponytail: ceiling — there is no "load more" and no search over the long tail.
 * A discovery list of forty options is longer than anyone reads, and the map is
 * built from this same array, so raising this raises the map's point count too.
 * Add server-side pagination when a user asks to see past the fortieth.
 */
const MAX_CANDIDATES = 40;

/**
 * The rows that cross the server/client boundary.
 *
 * Three groups, in priority order:
 *  1. what the plan actually stops at — omitting these breaks the timeline
 *  2. what the gate rejected — the "why not that" ledger is the product, and a
 *     rejection with no card behind it renders as nothing
 *  3. the top of the retrieval ranking — the near-misses and the maybes
 *
 * Order is preserved from the inputs so the list reads planned-first, which is
 * what `DiscoverySurface` expects when it filters candidates itself.
 */
function shortlist(
  catalogue: ReadonlyArray<Experience>,
  candidateIds: ReadonlyArray<string>,
  plan: Plan,
  rejected: ReadonlyArray<Rejection>,
): Experience[] {
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const chosen = new Set<string>();

  const take = (id: string): void => {
    if (byId.has(id)) chosen.add(id);
  };

  for (const stop of plan.stops) take(stop.experienceId);
  for (const rejection of rejected) take(rejection.experienceId);
  for (const id of candidateIds) {
    if (chosen.size >= plan.stops.length + rejected.length + MAX_CANDIDATES) break;
    take(id);
  }

  // Returned in catalogue order rather than the order they were added, so the
  // sequence is stable between renders instead of depending on set iteration.
  return catalogue.filter((item) => chosen.has(item.id));
}

/**
 * Straight-line travel estimate from the traveller's origin, in minutes.
 *
 * Deliberately duplicated rather than imported: the engine already has one
 * inside `planItinerary`, but it is not exported, and this page needs the same
 * number to label each card. A page-level approximation is fine for a card
 * badge as long as it is the same approximation the plan used, which is why
 * this mirrors the engine's method rather than inventing another one.
 */
function travelEstimate(ctx: DiscoveryContext, experience: Experience): number {
  const from = ctx.origin.point;
  if (!from) return 0;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (experience.location.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((experience.location.lon - from.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const metres = 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  // 1.3 detour factor, walking at 80 m/min: the same pessimistic estimate the
  // engine uses, so a card's travel time matches the plan's.
  return Math.max(1, Math.round((metres * 1.3) / 80));
}
