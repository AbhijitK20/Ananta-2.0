/**
 * The shape of a player's save file.
 *
 * One design decision governs this whole file and everything that reads it:
 *
 *   **`stamps` is the only thing that is stored. Everything else is derived.**
 *
 * XP, levels, quest progress, achievement unlocks, collection counts and the
 * city passport are all computed from the set of stamped place ids at read
 * time. Storing them alongside would mean four representations of "how many
 * places has this person collected" that can disagree, and every one of them
 * needs a migration when the rules change. Deriving them costs a `filter` over
 * 890 records, which is nothing, and it makes it structurally impossible for
 * the XP bar to disagree with the stamp book.
 *
 * The only fields that are stored but not derivable are the ones that record
 * *when* something happened rather than *what* is true: which quests have been
 * claimed (a claim is a one-shot reward, and re-deriving "has this been claimed"
 * from progress would pay out twice the moment a rule changed), and the day
 * keys a streak has been kept alive on.
 */

import type { Category } from "../content";

/** ISO 8601, UTC. Stamped places sort and de-duplicate against this. */
type Timestamp = string;

/** `YYYY-MM-DD` in the player's own timezone. See `dayKey` in daily.ts. */
export type DayKey = string;

export type Save = {
  /**
   * Bumped whenever the shape changes. `migrate` in storage.ts refuses to
   * interpret a save from a future version rather than guessing, because a
   * wrong guess here silently discards somebody's collection.
   */
  version: number;
  /** Place id (`city/slug`) -> when it was stamped. Absent means not stamped. */
  stamps: Record<string, Timestamp>;
  /** Quest ids whose one-shot reward has been taken. */
  claimedQuests: string[];
  /** Achievement id -> ISO timestamp of the unlock. */
  unlocked: Record<string, Timestamp>;
  /** Day keys on which at least one place was stamped. Drives the streak. */
  activeDays: DayKey[];
  /** Day key -> how many places were stamped that day. */
  dailyCounts: Record<DayKey, number>;
  /**
   * Day keys on which the daily challenge's nominated place was stamped.
   *
   * Stored rather than derived because the day's nomination changes and only
   * the current one is kept — the derivation has no way to know what Tuesday's
   * pick *was*. Without this the daily bonus could only ever be reported in a
   * toast, never counted in the total, and the two would disagree by 15 XP
   * every time a player played.
   */
  dailiesDone: DayKey[];
  /** The most recent daily-challenge target, so a reload cannot reroll it. */
  dailyPick: { day: DayKey; placeId: string } | null;
};

/**
 * An empty save. A fresh object every call rather than a shared constant:
 * `migrate` and the reducer both hand this out, and a shared mutable default is
 * a cross-contamination bug waiting for its first test.
 */
export function emptySave(): Save {
  return {
    version: SAVE_VERSION,
    stamps: {},
    claimedQuests: [],
    unlocked: {},
    activeDays: [],
    dailyCounts: {},
    dailiesDone: [],
    dailyPick: null,
  };
}

export const SAVE_VERSION = 1;

/* -------------------------------------------------------------------------- *
 * Quests
 * -------------------------------------------------------------------------- */

export type QuestGoal =
  /** Total places stamped. */
  | { kind: "count"; target: number }
  /** Places stamped inside one category. */
  | { kind: "category"; category: Category; target: number }
  /** Places stamped inside one city. */
  | { kind: "city"; city: string; target: number }
  /** Places stamped at one budget band. */
  | { kind: "budget"; budget: string; target: number }
  /** Distinct cities stamped. */
  | { kind: "cities"; target: number }
  /** Distinct categories stamped. */
  | { kind: "variety"; target: number }
  /** One place in each of several categories. */
  | { kind: "spread"; categories: Category[]; target: number };

export type Quest = {
  id: string;
  title: string;
  /** One line, present tense, no second person. Shown under the title. */
  blurb: string;
  goal: QuestGoal;
  /** XP paid once, on claim. */
  reward: number;
  /** Shown as a grouping header on the quest board. */
  tier: "warmup" | "city" | "category" | "grand";
};

export type QuestState = {
  quest: Quest;
  progress: number;
  target: number;
  /** `progress >= target`. Kept as a field so a consumer never recomputes it. */
  complete: boolean;
  /** Complete and not yet paid out. The only state the claim button enables on. */
  claimable: boolean;
  claimed: boolean;
};

/* -------------------------------------------------------------------------- *
 * Achievements
 * -------------------------------------------------------------------------- */

export type Achievement = {
  id: string;
  title: string;
  blurb: string;
  /** Glyph shown on the badge. Text, not an icon font, so it renders anywhere. */
  glyph: string;
  tier: "bronze" | "silver" | "gold";
};

export type AchievementState = Achievement & {
  /**
   * The save currently satisfies the condition. May be true with a null
   * `unlockedAt` — see the note in achievements.ts about achievements that
   * were already earned before the save started recording them.
   */
  earned: boolean;
  /** When the unlock was recorded, or null if it never was. */
  unlockedAt: Timestamp | null;
};

/* -------------------------------------------------------------------------- *
 * Levels
 * -------------------------------------------------------------------------- */

export type Level = {
  /** Zero-based. Level 1 is `index` 0. */
  index: number;
  /** Cumulative XP required to hold this level. */
  at: number;
  title: string;
};

export type LevelState = {
  level: Level;
  next: Level | null;
  /** XP earned inside the current level. */
  into: number;
  /** XP the current level spans. Equals the level's width, not the total. */
  span: number;
  /** 0..1 across the current level. 1 when there is no next level. */
  progress: number;
  xpToNext: number;
  /** True once every level is exhausted — the bar should read "maxed". */
  maxed: boolean;
};
