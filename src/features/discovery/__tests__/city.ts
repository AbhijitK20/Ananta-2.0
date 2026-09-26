/**
 * One small, walkable city, shared by the tests that need a plan to exist.
 *
 * Every row is here because it makes a specific check fire, so all twelve of
 * `docs/FEATURES.md` §3 are reachable from one catalogue. Distances are chosen, not
 * random: `chai` is 246 m from the origin and `market` is 350 m from `chai`, so a
 * `prefers_no_walks` (500 m) plan is exactly [chai, market]. That is what gives the
 * walking test a real before and a real after rather than two vague shapes.
 *
 * The calendar is `ASSUMED_CALENDAR`, a Wednesday in February, and two rows are built
 * against it: `gallery` is shut midweek and `seasonal` is a festival-season place.
 * Change the calendar and those two rows mean something different, which is exactly
 * why the assumption is a parameter and not a constant baked into a verdict.
 */
import { expect } from "vitest";

import { type DiscoveryContext, type Experience, type Plan, type Slot } from "../../../contracts";
import { type ContextSeed, createContext } from "../context";
import { type RepairEvent, repair } from "../repair";
import { createSession, discover, type DiscoverySession } from "../replanner";
import {
  ASSUMED_CALENDAR,
  type Facts,
  check,
  deterministicEngine,
  metresBetween,
} from "./engine";
import { WEIGHTS, exp } from "./fixtures";

export const ORIGIN = { lat: 19.0, lon: 72.87 };
export const PARTY = 2;

const price = (minor: number) => ({ minor, currency: "INR" as const });
const open = (raw: string | null, status: Experience["hours"]["status"] = "ok") => ({
  raw,
  status,
  lastVerified: raw === null ? null : "2026-01-20",
});

const ACCESS = {
  stepFree: null,
  strollerOk: null,
  lowStairs: null,
  seatingAvailable: null,
  hearingLoop: null,
  restroomOnSite: null,
} as const;

export const SEED: ContextSeed = {
  id: "ctx-repair",
  origin: { label: "Colaba", point: ORIGIN },
  availableMin: 180,
  nowMin: 600,
  budgetMinor: 200000,
  partySize: PARTY,
  interests: ["market", "cafe", "street_food"],
};

export const CATALOGUE: Experience[] = [
  // ~246 m out. 20 min, cheap, outdoors, weather-sensitive. Packs first.
  exp({ id: "chai", name: "Chai stall", category: "street_food", indoorOutdoor: "outdoor", durationMin: 20, pricePerPerson: price(10000), location: { lat: 19.002, lon: 72.871 }, keywords: ["street_food"], weatherSensitive: "rain", hours: open("Mo-Su 08:00-23:00") }),

  // ~350 m from chai, ~590 m from the origin. The second walking stop.
  exp({ id: "market", name: "Colaba Market", category: "market", indoorOutdoor: "outdoor", durationMin: 45, pricePerPerson: price(20000), location: { lat: 19.005, lon: 72.872 }, keywords: ["market", "local"], weatherSensitive: "rain", hours: open("Mo-Su 09:00-14:00,16:00-20:00") }),

  // ~1.1 km. The first thing the walking limit throws out.
  exp({ id: "cafe", name: "Cafe with a courtyard", category: "cafe", indoorOutdoor: "covered", durationMin: 40, pricePerPerson: price(25000), location: { lat: 19.012, lon: 72.878 }, keywords: ["cafe"], hours: open("Mo-Su 08:00-22:00") }),

  exp({ id: "mosque", name: "Neighbourhood mosque", category: "mosque", indoorOutdoor: "indoor", durationMin: 25, pricePerPerson: price(0), location: { lat: 19.008, lon: 72.882 }, keywords: ["heritage"], hours: open("Mo-Fr 05:00-20:00") }),

  // Fails three access checks, so one row covers check 6 three times over.
  exp({ id: "steps", name: "Stairs up to the terrace", category: "hidden_place", indoorOutdoor: "outdoor", durationMin: 30, pricePerPerson: price(15000), location: { lat: 19.004, lon: 72.874 }, keywords: ["nature"], accessibility: { ...ACCESS, stepFree: false, lowStairs: false, restroomOnSite: false }, hours: open("Mo-Su 07:00-19:00") }),

  // Vegetables only, so a jain or halal party cannot go. Check 7.
  exp({ id: "tiffin", name: "Tiffin room", category: "restaurant", indoorOutdoor: "indoor", durationMin: 50, pricePerPerson: price(30000), location: { lat: 19.02, lon: 72.884 }, keywords: ["street_food", "food"], diets: ["vegetarian", "vegan"], hours: open("Mo-Su 12:00-23:00") }),

  // Sa-Su only, so shut on the assumed Wednesday. Check 3, hard.
  exp({ id: "gallery", name: "Art gallery", category: "gallery", indoorOutdoor: "indoor", durationMin: 60, pricePerPerson: price(40000), location: { lat: 19.03, lon: 72.892 }, keywords: ["gallery", "heritage"], hours: open("Sa-Su 10:00-18:00") }),

  // Booking-only, 4 hours' notice, 2 hours on site. Checks 9 and 2.
  exp({ id: "photowalk", name: "Photography walk", category: "adventure", indoorOutdoor: "outdoor", durationMin: 120, pricePerPerson: price(15000), location: { lat: 19.0085, lon: 72.8825 }, keywords: ["nature"], booking: { required: true, leadTimeMin: 240, walkIn: false }, hours: open("Mo-Su 06:00-18:00") }),

  // A festival-season place, and February is not it. Check 12.
  exp({ id: "seasonal", name: "Mask festival ground", category: "festival", indoorOutdoor: "outdoor", durationMin: 40, pricePerPerson: price(10000), location: { lat: 19.006, lon: 72.870 }, keywords: ["local"], bestMonths: [11, 12, 1], hours: open("Mo-Su 10:00-20:00") }),

  // Never surveyed. Soft: recorded, still packable.
  exp({ id: "unverified", name: "The place with no hours on file", category: "hidden_place", indoorOutdoor: "indoor", durationMin: 25, pricePerPerson: price(10000), location: { lat: 19.003, lon: 72.873 }, hours: open(null, "absent") }),

  // An OSM expression the adapter cannot read. Also soft, also packable.
  exp({ id: "garbled", name: "The place with unreadable hours", category: "hidden_place", indoorOutdoor: "indoor", durationMin: 25, pricePerPerson: price(10000), location: { lat: 19.0035, lon: 72.8735 }, hours: open("PH off", "unparsable") }),

  // Seats one. We are two. Check 5, from the listing.
  exp({ id: "tiny", name: "Two-seat counter", category: "restaurant", indoorOutdoor: "indoor", durationMin: 30, pricePerPerson: price(50000), capacity: 1, location: { lat: 19.0032, lon: 72.8732 }, hours: open("Mo-Su 11:00-23:00") }),

  // Slot-tracked. The slot below is gone, so this starts unavailable and becomes
  // available when the slot is released. Check 8, and the source of a real swap.
  exp({ id: "pottery", name: "Pottery studio", category: "craft_workshop", indoorOutdoor: "indoor", durationMin: 55, pricePerPerson: price(45000), capacity: 4, location: { lat: 19.006, lon: 72.876 }, keywords: ["craft"], booking: { required: true, leadTimeMin: 30, walkIn: false }, hours: open("Mo-Su 10:00-19:00") }),
];

export const CATALOGUE_MAP = new Map(CATALOGUE.map((item) => [item.id, item]));
export const at = (id: string) => CATALOGUE_MAP.get(id)?.location ?? ORIGIN;

/** The 10:30 slot at the pottery studio, with both seats already committed. */
export const POTTERY_SLOT: Slot = {
  id: "slot-pottery-1030",
  providerId: "provider-pottery",
  experienceId: "pottery",
  startMin: 630,
  endMin: 720,
  capacity: 2,
  pricePerPerson: price(45000),
  held: { pendingOrders: 0, confirmedOrders: 2, carts: 0 },
  status: "ok",
};

/** The same slot with one seat free, which is not enough for two people. */
export const POTTERY_SLOT_HALF: Slot = {
  ...POTTERY_SLOT,
  held: { pendingOrders: 0, confirmedOrders: 1, carts: 0 },
};

/** The same slot released, which is enough for two and swaps a real stop back in. */
export const POTTERY_SLOT_FREE: Slot = {
  ...POTTERY_SLOT,
  held: { pendingOrders: 0, confirmedOrders: 0, carts: 0 },
};

export const FACTS: Facts = { slots: [POTTERY_SLOT], calendar: ASSUMED_CALENDAR };

// ---------------------------------------------------------------------------
// The app's own path
// ---------------------------------------------------------------------------

export type City = {
  engine: ReturnType<typeof deterministicEngine>;
  session: DiscoverySession;
  initial: Plan;
  ctx: DiscoveryContext;
};

export function city(options: { slots?: Slot[]; facts?: Facts } = {}): City {
  const engine = deterministicEngine({
    catalogue: CATALOGUE,
    weights: WEIGHTS,
    facts: options.facts ?? FACTS,
  });
  const session = createSession({ engine, seed: SEED, catalogue: CATALOGUE, weights: WEIGHTS });
  const first = discover(engine, session);
  if (!first.ok) throw new Error(`the catalogue produced no plan: ${first.reason}`);
  return { engine, session: first.session, initial: first.plan, ctx: first.session.state.ctx };
}

/** A context with one field changed, for isolating a single check. */
export const ctxWith = (patch: Partial<ContextSeed> = {}): DiscoveryContext =>
  createContext({ ...SEED, ...patch }).ctx;

export const ids = (plan: Plan): string[] => plan.stops.map((stop) => stop.experienceId);
export const codes = (plan: Plan): [string, string][] =>
  plan.rejected.map((entry) => [entry.experienceId, entry.code] as [string, string]);

/** The first stop the traveller has not reached yet. */
export function nextUp(plan: Plan, nowMin: number): string {
  const stop = plan.stops.find((item) => item.departMin > nowMin);
  if (!stop) throw new Error("the plan has no upcoming stop");
  return stop.experienceId;
}

/**
 * The largest hop between consecutive stops, in metres, through the same great-circle
 * the router fixture uses. "How far apart is this plan" is a property of the plan, so
 * a test measures it rather than reading a claim.
 */
export function spreadOf(plan: Plan, ctx: DiscoveryContext): number {
  let worst = 0;
  let here = ctx.origin.point ?? ORIGIN;
  for (const stop of plan.stops) {
    worst = Math.max(worst, metresBetween(here, at(stop.experienceId)));
    here = at(stop.experienceId);
  }
  return worst;
}

/** Every hop, so a test can assert each one rather than only the worst. */
export function hopsOf(
  plan: Plan,
  ctx: DiscoveryContext,
): { from: string; to: string; metres: number }[] {
  const out: { from: string; to: string; metres: number }[] = [];
  let here = ctx.origin.point ?? ORIGIN;
  let from = "origin";
  for (const stop of plan.stops) {
    const there = at(stop.experienceId);
    out.push({ from, to: stop.experienceId, metres: metresBetween(here, there) });
    here = there;
    from = stop.experienceId;
  }
  return out;
}

/** Runs a repair and fails loudly, so a later assertion cannot drift past it. */
export function repaired(run: City, event: RepairEvent) {
  const outcome = repair(run.engine, run.session, event);
  expect(
    outcome.ok,
    outcome.ok ? "" : `${outcome.reason} ${JSON.stringify(outcome.violations)}`,
  ).toBe(true);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome;
}

/**
 * Re-check a plan's stops against the same gate the engine applied, walking the chain
 * the way the gate does. A stop that cannot survive this was never a feasible stop.
 */
export function hardFailures(plan: Plan, ctx: DiscoveryContext, facts: Facts = FACTS): string[] {
  const out: string[] = [];
  let here = ctx.origin.point ?? ORIGIN;
  for (const stop of plan.stops) {
    const item = CATALOGUE_MAP.get(stop.experienceId);
    if (!item) {
      out.push(`${stop.experienceId}: not in the catalogue`);
      continue;
    }
    // A pinned id is in the plan ON PURPOSE, so `already_planned` is the gate doing
    // its job rather than a stop that should not be there. Skip those, and do not move
    // the chain anchor: the next stop is still reached from this one.
    if (!ctx.pinnedIds.includes(stop.experienceId)) {
      for (const entry of check(ctx, item, facts, here)) {
        if (entry.code !== "hours_unverified") out.push(`${stop.experienceId}: ${entry.code}`);
      }
    }
    here = item.location;
  }
  return out;
}
