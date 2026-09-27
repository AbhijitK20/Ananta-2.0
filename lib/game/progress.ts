/**
 * The one place player XP is calculated.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * XP was derived inline inside `store.tsx`'s `xp` useMemo. That was fine while
 * the stamp book was the only thing that displayed it.
 *
 * It stopped being fine the moment a second consumer appeared. The assistant
 * answers "how much XP do I have", and if it recomputes the total with its own
 * arithmetic the two numbers drift — the chat panel says 10 while the level bar
 * beside it says 240, and the feature's central promise ("it reads the game, so
 * it cannot disagree with the stamp book") is false in the most visible way
 * possible.
 *
 * That is not hypothetical. The first version of the assistant's XP answer was
 * `stamps * XP_PER_STAMP + clearedCities * XP_PER_CITY`, which omits claimed
 * quest rewards and daily bonuses entirely, and counts only catalogue-valid ids
 * where the game counts every id in the save. It was wrong on any save with a
 * claimed quest, and the only symptom would have been a number that quietly
 * disagreed with the page next to it.
 *
 * So the derivation is here now, exported, pure, and called by both.
 *
 * ---------------------------------------------------------------------------
 * THE FORMULA, UNCHANGED
 * ---------------------------------------------------------------------------
 *
 * This is the original arithmetic moved verbatim, not a rewrite:
 *
 *     stamps.size * XP_PER_STAMP
 *   + one reward per distinct claimed quest
 *   + XP_PER_CITY for every city fully cleared (floor of two places)
 *   + XP_DAILY_BONUS per distinct completed daily challenge
 *
 * Note `stamps.size`, not the number of stamps that resolve to a catalogue
 * entry. A stale id in the save still counts, because that is what the stamp
 * book has always done and this is a move, not a change. Changing it here would
 * alter the score of every existing player.
 */

import { CITY_BY_SLUG } from "./content";
import { questById } from "./quests";
import { XP_DAILY_BONUS, XP_PER_CITY, XP_PER_STAMP } from "./xp";

/** The minimum a city needs before clearing it pays anything. */
export function cityBonusFor(total: number, have: number): number {
  if (total < 2) return 0;
  return have >= total ? XP_PER_CITY : 0;
}

/** The subset of a save that XP is derived from. */
export type XpInput = {
  /** Every place id in the save, valid or not. */
  stamps: Iterable<string>;
  /** Quest ids whose reward has been taken. */
  claimedQuests: readonly string[];
  /** Day keys on which the daily challenge was completed. */
  dailiesDone: readonly string[];
};

export type XpBreakdown = {
  total: number;
  fromStamps: number;
  fromQuests: number;
  fromCities: number;
  fromDailies: number;
  /** How many city bonuses were paid, for the explanation shown to a player. */
  citiesCleared: number;
};

export function computeXp({ stamps, claimedQuests, dailiesDone }: XpInput): XpBreakdown {
  // Deduplicated even though the reducer already prevents a double claim: the
  // reducer's guard is on the write path and this is the read path. Preserved
  // from the original so a hand-edited save cannot pay a quest twice.
  const stampIds = new Set(stamps);
  const fromStamps = stampIds.size * XP_PER_STAMP;

  let fromQuests = 0;
  for (const questId of new Set(claimedQuests)) {
    fromQuests += questById(questId)?.reward ?? 0;
  }

  let fromCities = 0;
  let citiesCleared = 0;
  for (const city of CITY_BY_SLUG.values()) {
    let have = 0;
    for (const place of city.places) {
      if (stampIds.has(place.id)) have += 1;
    }
    const bonus = cityBonusFor(city.places.length, have);
    fromCities += bonus;
    if (bonus > 0) citiesCleared += 1;
  }

  const fromDailies = new Set(dailiesDone).size * XP_DAILY_BONUS;

  return {
    total: fromStamps + fromQuests + fromCities + fromDailies,
    fromStamps,
    fromQuests,
    fromCities,
    fromDailies,
    citiesCleared,
  };
}
