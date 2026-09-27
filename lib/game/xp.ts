/**
 * XP and levels.
 *
 * Pure functions over a number. Nothing here reads or writes the save — the
 * caller passes the XP total it already has, which keeps the curve testable and
 * keeps this file free of any knowledge of where XP comes from.
 *
 * Two decisions worth stating:
 *
 *   **A stamp is worth 10 XP flat.** Not scaled by how obscure the place is.
 *     Weighting by obscurity would need a difficulty score the dataset does not
 *     have, and an invented one would make the reward for a stamped place
 *     depend on a number nobody can see or argue with.
 *
 *   **Level 10 is 6000 XP — 600 stamps — and the dataset holds 890.** So the
 *     curve is completable well before the collection is, and maxing the curve
 *     is a different thing from finishing the stamp book. Two end states, both
 *     reachable, neither a substitute for the other.
 */

import type { Level, LevelState } from "./types";

export const XP_PER_STAMP = 10;
export const XP_PER_CITY = 50;
export const XP_DAILY_BONUS = 15;

export const LEVELS: readonly Level[] = Object.freeze([
  { index: 0, at: 0, title: "Tourist" },
  { index: 1, at: 40, title: "Visitor" },
  { index: 2, at: 120, title: "Wayfinder" },
  { index: 3, at: 280, title: "Regular" },
  { index: 4, at: 520, title: "Local" },
  { index: 5, at: 860, title: "Insider" },
  { index: 6, at: 1320, title: "Native" },
  { index: 7, at: 2000, title: "Fixture" },
  { index: 8, at: 3000, title: "Legend" },
  { index: 9, at: 6000, title: "Local Legend" },
]);

/**
 * The level holding `xp`, plus how far into it the player is.
 *
 * Negative XP is clamped to zero rather than throwing. It cannot currently
 * happen — every award path is non-negative — but a level lookup that indexes
 * off the front of an array on a bad number is the kind of failure that only
 * shows up on a device that has been asleep for a month.
 */
export function levelState(xp: number): LevelState {
  const total = Math.max(0, Math.floor(xp) || 0);

  let index = 0;
  for (let i = LEVELS.length - 1; i >= 0; i -= 1) {
    if (total >= LEVELS[i].at) {
      index = i;
      break;
    }
  }

  const level = LEVELS[index];
  const next = index + 1 < LEVELS.length ? LEVELS[index + 1] : null;

  if (!next) {
    return { level, next: null, into: 0, span: 0, progress: 1, xpToNext: 0, maxed: true };
  }

  const span = next.at - level.at;
  const into = total - level.at;

  return {
    level,
    next,
    into,
    span,
    progress: span > 0 ? Math.min(1, Math.max(0, into / span)) : 1,
    xpToNext: Math.max(0, next.at - total),
    maxed: false,
  };
}

