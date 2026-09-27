/**
 * Achievements.
 *
 * Same contract as quests: qualified-ness is *evaluated* from the save, never
 * tracked as a counter. The only stored part is `Save.unlocked[id]`, which
 * records *when* — the unlock moment is shown in the UI and is not
 * re-derivable, because by the time you read the save the conditions that
 * earned it are satisfied and the date they were first satisfied on is gone.
 *
 * So there are two questions and two functions, deliberately kept apart:
 *
 *   `satisfiedAchievements` — does the current save meet the condition? Pure,
 *                             no dates, no storage. A save can satisfy an
 *                             achievement it has no record of.
 *   `selectAchievements`    — what does the UI render? Joins the above with the
 *                             recorded dates.
 *
 * A player who already had 50 stamps before the achievement shipped satisfies
 * "Regular" on day one and has no unlock date for it. The honest rendering is
 * "earned, date unknown" — not a fake epoch date, and not a locked badge
 * waiting for them to claim something they already did.
 *
 * Glyphs are plain text rather than an icon font. A badge that renders as a tofu
 * box on a machine without the font is worse than no badge.
 */

import { type Category, PLACES } from "./content";
import type { Achievement, AchievementState } from "./types";

const DEFINITIONS: readonly Achievement[] = Object.freeze([
  {
    id: "ach-first",
    title: "Doorway",
    blurb: "Stamped the first place.",
    glyph: "◔",
    tier: "bronze",
  },
  {
    id: "ach-ten",
    title: "Getting the Hang of It",
    blurb: "Ten places stamped.",
    glyph: "◑",
    tier: "bronze",
  },
  {
    id: "ach-fifty",
    title: "Regular",
    blurb: "Fifty places stamped.",
    glyph: "◕",
    tier: "silver",
  },
  {
    id: "ach-two-hundred",
    title: "Well Travelled",
    blurb: "Two hundred places stamped.",
    glyph: "●",
    tier: "gold",
  },
  {
    id: "ach-first-city",
    title: "Somewhere to Start",
    blurb: "Stamped a place in a new city.",
    glyph: "⌂",
    tier: "bronze",
  },
  {
    id: "ach-ten-cities",
    title: "Ten Cities",
    blurb: "Collected in ten cities.",
    glyph: "⌖",
    tier: "silver",
  },
  {
    id: "ach-thirty-cities",
    title: "Continental",
    blurb: "Collected in thirty cities.",
    glyph: "✵",
    tier: "gold",
  },
  {
    id: "ach-five-categories",
    title: "Eclectic",
    blurb: "Five categories collected in.",
    glyph: "◇",
    tier: "silver",
  },
  {
    id: "ach-every-category",
    title: "Full Inventory",
    blurb: "One place in every category, unfiled included.",
    glyph: "❖",
    tier: "gold",
  },
  {
    id: "ach-streak-three",
    title: "Three in a Row",
    blurb: "A three-day collecting streak.",
    glyph: "△",
    tier: "bronze",
  },
  {
    id: "ach-streak-seven",
    title: "A Full Week",
    blurb: "A seven-day collecting streak.",
    glyph: "▽",
    tier: "silver",
  },
  {
    id: "ach-streak-thirty",
    title: "Habit Formed",
    blurb: "A thirty-day collecting streak.",
    glyph: "◭",
    tier: "gold",
  },
  {
    id: "ach-unfiled-ten",
    title: "Unmarked Map",
    blurb: "Ten places the dataset could not categorise.",
    glyph: "◌",
    tier: "silver",
  },
  {
    id: "ach-mid-range",
    title: "Middle of the Road",
    blurb: "Fifteen mid-range places.",
    glyph: "◈",
    tier: "bronze",
  },
  {
    id: "ach-high-end",
    title: "Treating Yourself",
    blurb: "All five high-end places in the dataset.",
    glyph: "◉",
    tier: "silver",
  },
]);

export const ACHIEVEMENTS: readonly Achievement[] = DEFINITIONS;

export type AchievementInputs = {
  /** Stamped place ids. */
  stamps: ReadonlySet<string>;
  /** Longest run of consecutive active days, from `longestStreak` in daily.ts. */
  bestStreak: number;
};

/**
 * The ids of every achievement the current save satisfies.
 *
 * A `Set` rather than a map of booleans because the consumer only ever asks
 * membership, and 890 records get filtered exactly once.
 */
export function satisfiedAchievements({ stamps, bestStreak }: AchievementInputs): Set<string> {
  const places = PLACES.filter((p) => stamps.has(p.id));

  const cities = new Set<string>();
  const categories = new Set<Category>();
  let unfiled = 0;
  let midRange = 0;
  let highEnd = 0;

  for (const place of places) {
    cities.add(place.city);
    for (const category of place.categories) categories.add(category);
    if (place.categories.includes("unfiled")) unfiled += 1;
    if (place.budget === "mid-range") midRange += 1;
    if (place.budget === "high-end") highEnd += 1;
  }

  // 21 of the 890 places are high-end, so "all five" is a reachable ceiling
  // rather than a rounding of a bigger pool.
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ["ach-first", places.length >= 1],
    ["ach-ten", places.length >= 10],
    ["ach-fifty", places.length >= 50],
    ["ach-two-hundred", places.length >= 200],
    ["ach-first-city", cities.size >= 1],
    ["ach-ten-cities", cities.size >= 10],
    ["ach-thirty-cities", cities.size >= 30],
    ["ach-five-categories", categories.size >= 5],
    // Eight categories exist including `unfiled`, so this is "all of them".
    ["ach-every-category", categories.size >= 8],
    ["ach-streak-three", bestStreak >= 3],
    ["ach-streak-seven", bestStreak >= 7],
    ["ach-streak-thirty", bestStreak >= 30],
    ["ach-unfiled-ten", unfiled >= 10],
    ["ach-mid-range", midRange >= 15],
    ["ach-high-end", highEnd >= 21],
  ];

  const satisfied = new Set<string>();
  for (const [id, ok] of checks) {
    if (ok) satisfied.add(id);
  }
  return satisfied;
}

/**
 * What the achievements page renders: every badge, whether it is earned, and the
 * date it was recorded — which is null for an achievement satisfied before the
 * save ever saw it.
 */
export function selectAchievements(
  inputs: AchievementInputs,
  unlocked: Readonly<Record<string, string>>,
): AchievementState[] {
  const satisfied = satisfiedAchievements(inputs);
  return ACHIEVEMENTS.map((achievement) => ({
    ...achievement,
    earned: satisfied.has(achievement.id),
    unlockedAt: unlocked[achievement.id] ?? null,
  }));
}

/**
 * Ids to write an unlock date for: satisfied, but not yet recorded.
 *
 * Returned rather than written so the store owns the one write and the
 * "already recorded" check is visible at the call site.
 */
export function newlySatisfied(
  inputs: AchievementInputs,
  unlocked: Readonly<Record<string, string>>,
): string[] {
  const satisfied = satisfiedAchievements(inputs);
  return [...satisfied].filter((id) => !(id in unlocked));
}
