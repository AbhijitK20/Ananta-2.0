/**
 * The quest board.
 *
 * A quest is a goal plus a one-shot XP reward. Its progress is *evaluated* from
 * the stamp set rather than tracked, so a quest can never be half-credited and a
 * player cannot lose progress by closing the app. Claiming is the one piece of
 * state that has to be stored, and it lives in `Save.claimedQuests` because
 * "has this been paid out" is not a function of the stamps.
 *
 * City quests are generated from the dataset's own shape rather than
 * hand-listed, so the board always has a quest for wherever the data actually
 * has depth. A city with two places gets a two-place quest, which is an
 * achievable first win rather than a locked reward.
 */

import {
  CATEGORIES,
  CITIES,
  CATEGORY_LABELS,
  type Budget,
  type Category,
  type Place,
  PLACES,
} from "./content";
import type { Quest, QuestGoal, QuestState } from "./types";

/* -------------------------------------------------------------------------- *
 * Evaluation
 * -------------------------------------------------------------------------- */

/**
 * How far along a goal is, given the stamped places.
 *
 * Takes the already-filtered `Place[]` rather than the raw id set so that a
 * five-way category check does not re-parse the dataset five times. The caller
 * has the filtered list in hand anyway.
 */
function progressFor(goal: QuestGoal, stamped: readonly Place[]): number {
  switch (goal.kind) {
    case "count":
      return stamped.length;

    case "category":
      return stamped.filter((p) => p.categories.includes(goal.category)).length;

    case "city":
      return stamped.filter((p) => p.city === goal.city).length;

    case "budget":
      return stamped.filter((p) => p.budget === goal.budget).length;

    case "cities":
      return new Set(stamped.map((p) => p.city)).size;

    case "variety":
      return new Set(stamped.flatMap((p) => p.categories)).size;

    case "spread": {
      // One place can satisfy several of the required categories at once — a
      // restaurant that is also nightlife counts for both — so this counts
      // distinct required categories covered rather than places.
      const covered = new Set<Category>();
      for (const place of stamped) {
        for (const category of place.categories) {
          if (goal.categories.includes(category)) covered.add(category);
        }
      }
      return covered.size;
    }
  }
}

/**
 * Evaluate every quest against a stamp set.
 *
 * `claimed` is a set for lookup; the returned `QuestState.claimed` is a boolean
 * because every consumer wants to branch on it, not re-test membership.
 */
export function evaluateQuests(
  stamps: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
): QuestState[] {
  const stamped = PLACES.filter((p) => stamps.has(p.id));

  return QUESTS.map((quest) => {
    const progress = Math.min(progressFor(quest.goal, stamped), quest.goal.target);
    const complete = progress >= quest.goal.target;
    const isClaimed = claimed.has(quest.id);
    return {
      quest,
      progress,
      target: quest.goal.target,
      complete,
      claimable: complete && !isClaimed,
      claimed: isClaimed,
    };
  });
}

export function questById(id: string): Quest | undefined {
  return QUESTS.find((q) => q.id === id);
}

/* -------------------------------------------------------------------------- *
 * Definitions
 * -------------------------------------------------------------------------- */

const WARMUP: Quest[] = [
  {
    id: "warmup-first-stamp",
    title: "First Footfall",
    blurb: "Stamp your first place.",
    goal: { kind: "count", target: 1 },
    reward: 10,
    tier: "warmup",
  },
  {
    id: "warmup-five",
    title: "Getting Oriented",
    blurb: "Stamp five places, anywhere.",
    goal: { kind: "count", target: 5 },
    reward: 40,
    tier: "warmup",
  },
  {
    id: "warmup-variety",
    title: "Well Rounded",
    blurb: "Collect from four different categories.",
    goal: { kind: "variety", target: 4 },
    reward: 60,
    tier: "warmup",
  },
  {
    id: "warmup-spread-five",
    title: "Eat, Drink, Shop, See, Do",
    blurb: "One place in each of five categories.",
    goal: {
      kind: "spread",
      categories: ["restaurants", "shopping", "sightseeing", "tours", "nightlife"],
      target: 5,
    },
    reward: 120,
    tier: "warmup",
  },
  {
    id: "warmup-ten-cities",
    title: "Widely Travelled",
    blurb: "Collect in ten different cities.",
    goal: { kind: "cities", target: 10 },
    reward: 150,
    tier: "warmup",
  },
  {
    id: "warmup-unfiled",
    title: "Unmarked Map",
    blurb: "Stamp five places the dataset could not categorise.",
    goal: { kind: "category", category: "unfiled", target: 5 },
    reward: 80,
    tier: "warmup",
  },
];

const CATEGORY_QUESTS: Quest[] = CATEGORIES.map((category) => {
  const total = PLACES.filter((p) => p.categories.includes(category)).length;
  // A quarter of the category, rounded up, and never more than exists. For the
  // eight tagged categories this lands between 8 and 28; `unfiled` is the
  // outlier at 145, which is the point of that quest — it is the largest single
  // bucket in the data and the easiest to make progress in.
  const target = Math.max(1, Math.min(total, Math.ceil(total / 4)));
  return {
    id: `category-${category}`,
    title: `${CATEGORY_LABELS[category]} Habit`,
    blurb: `Stamp ${target} ${CATEGORY_LABELS[category].toLowerCase()} places.`,
    goal: { kind: "category", category, target } as QuestGoal,
    reward: 80 + target * 4,
    tier: "category" as const,
  };
});

const BUDGET_QUESTS: { budget: Budget; title: string; blurb: string }[] = [
  { budget: "budget", title: "Cheap Eats, Real Places", blurb: "Stamp ten budget places." },
  { budget: "mid-range", title: "The Comfortable Middle", blurb: "Stamp ten mid-range places." },
  { budget: "high-end", title: "Treating Yourself", blurb: "Stamp five high-end places." },
];

/**
 * One quest per city with at least two places, which is 168 of the 202 cities.
 *
 * Capped by target size rather than by a slice: every qualifying city gets a
 * quest, because a player who has collected in Reykjavík should find
 * Reykjavík on the board. Cities with a single place are skipped — a one-stamp
 * quest is a warmup wearing a city quest's clothes.
 */
const CITY_QUESTS: Quest[] = CITIES.filter((city) => city.places.length >= 2).map((city) => {
  const target = city.places.length;
  const pct = Math.round((target / PLACES.length) * 100);
  return {
    id: `city-${city.slug}`,
    title: `All of ${city.label}`,
    blurb: `Stamp all ${target} places in ${city.label} — ${pct}% of the dataset.`,
    goal: { kind: "city", city: city.slug, target },
    reward: 60 + target * 10,
    tier: "city" as const,
  };
});

const GRAND: Quest[] = [
  {
    id: "grand-fifty",
    title: "Half a Hundred",
    blurb: "Stamp fifty places.",
    goal: { kind: "count", target: 50 },
    reward: 250,
    tier: "grand",
  },
  {
    id: "grand-two-hundred",
    title: "Two Hundred Doors",
    blurb: "Stamp two hundred places.",
    goal: { kind: "count", target: 200 },
    reward: 800,
    tier: "grand",
  },
  {
    id: "grand-twenty-cities",
    title: "Twenty Cities Deep",
    blurb: "Collect in twenty different cities.",
    goal: { kind: "cities", target: 20 },
    reward: 600,
    tier: "grand",
  },
  {
    id: "grand-all-categories",
    title: "The Full Inventory",
    blurb: "Collect from all eight categories, unfiled included.",
    goal: { kind: "variety", target: CATEGORIES.length },
    reward: 400,
    tier: "grand",
  },
  {
    id: "grand-five-hundred",
    title: "Five Hundred Stamps",
    blurb: "Stamp five hundred of the eight hundred and ninety places.",
    goal: { kind: "count", target: 500 },
    reward: 2500,
    tier: "grand",
  },
];

export const QUESTS: readonly Quest[] = Object.freeze([
  ...WARMUP,
  ...BUDGET_QUESTS.map(
    (b): Quest => ({
      id: `budget-${b.budget}`,
      title: b.title,
      blurb: b.blurb,
      goal: { kind: "budget", budget: b.budget, target: b.budget === "high-end" ? 5 : 10 },
      reward: 120,
      tier: "warmup",
    }),
  ),
  ...CITY_QUESTS,
  ...CATEGORY_QUESTS,
  ...GRAND,
]);

export const TIER_LABELS: Record<Quest["tier"], string> = {
  warmup: "Getting started",
  city: "City clearance",
  category: "Category hunts",
  grand: "Long game",
};

export const TIER_ORDER: readonly Quest["tier"][] = ["warmup", "city", "category", "grand"];

/** The quests a player should look at first: claimable, then closest to done. */
export function sortForBoard(states: readonly QuestState[]): QuestState[] {
  return [...states].sort((a, b) => {
    // Unclaimed-and-complete always floats to the top, whatever else is going on.
    if (a.claimable !== b.claimable) return a.claimable ? -1 : 1;
    if (a.claimed !== b.claimed) return a.claimed ? 1 : -1;
    const ra = a.progress / a.target;
    const rb = b.progress / b.target;
    if (ra !== rb) return rb - ra;
    return a.quest.reward - b.quest.reward;
  });
}
