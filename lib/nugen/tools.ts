/**
 * The assistant's tools: deterministic reads of the game layer.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MODEL GETS TOOLS INSTEAD OF KNOWLEDGE
 * ---------------------------------------------------------------------------
 *
 * The aligned model knows the *catalogue* — 890 places, 202 cities, 222 quests,
 * the shape of the rules. It is aligned on that corpus and it can talk about it
 * in prose. What it must not do is decide anything.
 *
 * "How many XP have I got", "which quest am I closest to", "is this quest
 * claimable", "what have I not collected yet" are all questions with exactly one
 * right answer, and that answer is already computed by `lib/game/*`. If the model
 * answered them, the same question asked twice could give two different answers,
 * and the stamp book on screen would disagree with the chat panel beside it.
 *
 * So every number the assistant states comes from a call into this file, which
 * calls the same `evaluateQuests` / `levelState` / `satisfiedAchievements` the
 * UI calls. The model chooses which tool to call and narrates the result. It
 * cannot invent a number, because it never produces one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PLAYER'S SAVE IS AN INPUT RATHER THAN SERVER STATE
 * ---------------------------------------------------------------------------
 *
 * The save lives in the player's localStorage — there is no account, and that is
 * deliberate (see `lib/game/storage.ts`). So the client sends its own progress
 * with the request and these functions compute against it. That keeps the save
 * on the device, and it means a tool call is a pure function of its arguments:
 * the same inputs always give the same answer, which is what makes the assistant
 * reproducible.
 *
 * Nothing here trusts those inputs as *true* — they are the player's own save,
 * the same bytes the game already read — but nothing here writes to it either.
 * Stamping happens through the game's own reducer, never through the assistant.
 */

import {
  BUDGET_LABELS,
  CATEGORIES,
  CATEGORY_LABELS,
  CITIES,
  CITY_BY_SLUG,
  PLACES,
  PLACE_BY_ID,
  TOTALS,
  type Budget,
  type Category,
} from "../game/content";
import { satisfiedAchievements, ACHIEVEMENTS } from "../game/achievements";
import { streakState, type StreakState } from "../game/daily";
import { evaluateQuests, TIER_LABELS, sortForBoard } from "../game/quests";
import { levelState } from "../game/xp";
import { computeXp } from "../game/progress";
import type { ToolSpec } from "./client";

/** The player's save, as the client reports it. */
export type PlayerSave = {
  /** Place ids (`city/slug`) that have been stamped. */
  stamped: string[];
  /** Quest ids whose one-shot reward has been claimed. */
  claimed: string[];
  /** `YYYY-MM-DD` day keys on which at least one place was stamped. */
  activeDays: string[];
  /**
   * `YYYY-MM-DD` day keys on which the daily challenge was completed.
   *
   * Carried because XP is not derivable without it -- `computeXp` pays a daily
   * bonus per completed challenge. A player with claimed quests and finished
   * dailies would otherwise be quoted a total the stamp book does not show.
   */
  dailiesDone: string[];
};

export type ToolResult = Record<string, unknown>;

const asSet = (xs: string[] | undefined) => new Set(xs ?? []);

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

function isBudget(v: unknown): v is Budget {
  return typeof v === "string" && v in BUDGET_LABELS;
}

/** Trim an arbitrary argument object down to what a place actually has. */
function briefPlace(id: string) {
  const p = PLACE_BY_ID.get(id);
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    city: p.cityLabel,
    neighbourhood: p.hood,
    categories: p.categories.length ? p.categories.map((c) => CATEGORY_LABELS[c]) : ["unfiled"],
    budget: BUDGET_LABELS[p.budget],
    note: p.snippet || null,
  };
}

/* -------------------------------------------------------------------------- *
 * Tool specifications, in the shape the API expects
 * -------------------------------------------------------------------------- */

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "lookup_place",
      description:
        "Look up one place in the 890-place catalogue by its city and slug. Returns null if the " +
        "catalogue has no such place, which is the answer to give when a place is not in the index.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City slug, e.g. 'lisbon'." },
          slug: { type: "string", description: "Place slug, e.g. 'a-vida-portuguesa'." },
        },
        required: ["city", "slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_places",
      description:
        "Search the catalogue. All filters are optional and combine. Use this rather than " +
        "recalling names: the catalogue is closed and 65% of it has no category, so a name " +
        "produced from memory is very likely to be wrong.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "Restrict to one city slug." },
          category: { type: "string", enum: [...CATEGORIES], description: "Restrict to one category." },
          budget: { type: "string", enum: Object.keys(BUDGET_LABELS), description: "Restrict to one budget band." },
          nameContains: { type: "string", description: "Case-insensitive substring match on the place name." },
          limit: { type: "integer", minimum: 1, maximum: 25, description: "Max results, default 8." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "city_summary",
      description:
        "What the catalogue holds for one city: how many places, the category mix, the budget " +
        "mix, and a few examples. Use for 'what is there in X'.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City slug, e.g. 'porto'." } },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "player_progress",
      description:
        "The player's exact level, XP, totals, streak, quest completion and achievements, " +
        "computed from their save. This is the only correct source for any question about how " +
        "much the player has done. Never estimate it.",
      parameters: {
        type: "object",
        properties: {
          save: {
            type: "object",
            description: "The player's save, passed through from the client.",
            properties: {
              stamped: { type: "array", items: { type: "string" } },
              claimed: { type: "array", items: { type: "string" } },
              activeDays: { type: "array", items: { type: "string" } },
              dailiesDone: { type: "array", items: { type: "string" } },
            },
            required: ["stamped"],
          },
        },
        required: ["save"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quest_board",
      description:
        "Quests with the player's progress against each, ordered the way the quest board orders " +
        "them: claimable first, then closest to done. Use for 'what should I do next'.",
      parameters: {
        type: "object",
        properties: {
          save: {
            type: "object",
            properties: {
              stamped: { type: "array", items: { type: "string" } },
              claimed: { type: "array", items: { type: "string" } },
            },
            required: ["stamped"],
          },
          tier: { type: "string", enum: ["warmup", "city", "category", "grand"] },
          limit: { type: "integer", minimum: 1, maximum: 25, description: "Max quests, default 8." },
        },
        required: ["save"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "collection_gaps",
      description:
        "What the player has not collected yet, by city and by category, plus the cheapest " +
        "quest to finish next. Use for 'what am I missing'.",
      parameters: {
        type: "object",
        properties: {
          save: {
            type: "object",
            properties: { stamped: { type: "array", items: { type: "string" } } },
            required: ["stamped"],
          },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Max suggestions, default 6." },
        },
        required: ["save"],
      },
    },
  },
];

/* -------------------------------------------------------------------------- *
 * Dispatch
 * -------------------------------------------------------------------------- */

export type ToolName = (typeof TOOL_SPECS)[number]["function"]["name"];

export function runTool(name: string, rawArgs: string | undefined, save: PlayerSave): ToolResult {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return { error: "arguments were not valid JSON", name };
  }

  // The save rides along on every call rather than only on the ones that declare
  // it, so a model that omits it still gets the right answers.
  const stamped = asSet(args.save && typeof args.save === "object"
    ? ((args.save as Record<string, unknown>).stamped as string[] | undefined)
    : save.stamped);
  // The save rides along on every call, so a model that omits it from `args` or
  // drops `dailiesDone` from it still gets the player's real XP.
  if (args.save && typeof args.save === "object") {
    const s = args.save as Record<string, unknown>;
    if (Array.isArray(s.claimed)) save.claimed = s.claimed as string[];
    if (Array.isArray(s.activeDays)) save.activeDays = s.activeDays as string[];
    if (Array.isArray(s.dailiesDone)) save.dailiesDone = s.dailiesDone as string[];
  }

  switch (name) {
    case "lookup_place":
      return lookupPlace(args);
    case "search_places":
      return searchPlaces(args);
    case "city_summary":
      return citySummary(args);
    case "player_progress":
      return playerProgress(save, stamped);
    case "quest_board":
      return questBoard(args, save, stamped);
    case "collection_gaps":
      return collectionGaps(stamped, args);
    default:
      return { error: `unknown tool ${name}`, available: TOOL_SPECS.map((t) => t.function.name) };
  }
}

function lookupPlace(args: Record<string, unknown>): ToolResult {
  const id = `${String(args.city ?? "")}/${String(args.slug ?? "")}`;
  const place = briefPlace(id);
  if (!place) {
    return { found: false, id, note: "no such place in the catalogue — say so rather than guessing" };
  }
  return { found: true, ...place };
}

function searchPlaces(args: Record<string, unknown>): ToolResult {
  const city = args.city ? String(args.city) : null;
  const category = isCategory(args.category) ? args.category : null;
  const budget = isBudget(args.budget) ? args.budget : null;
  const nameContains = args.nameContains ? String(args.nameContains).toLowerCase() : null;
  const limit = Math.min(25, Math.max(1, Number(args.limit ?? 8)));

  const hits = PLACES.filter((p) => {
    if (city && p.city !== city) return false;
    if (category && !p.categories.includes(category)) return false;
    if (budget && p.budget !== budget) return false;
    if (nameContains && !p.name.toLowerCase().includes(nameContains)) return false;
    return true;
  });

  return {
    matched: hits.length,
    showing: Math.min(limit, hits.length),
    note: hits.length > limit ? `showing ${limit} of ${hits.length}` : null,
    places: hits.slice(0, limit).map((p) => briefPlace(p.id)).filter(Boolean),
  };
}

function citySummary(args: Record<string, unknown>): ToolResult {
  const slug = String(args.city ?? "");
  const city = CITY_BY_SLUG.get(slug);
  if (!city) return { found: false, city: slug, note: "not a city in the catalogue" };

  const budgetMix = new Map<Budget, number>();
  for (const p of city.places) budgetMix.set(p.budget, (budgetMix.get(p.budget) ?? 0) + 1);

  return {
    found: true,
    city: city.label,
    slug: city.slug,
    places: city.places.length,
    categoryMix: Object.fromEntries(
      Object.entries(city.byCategory).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]),
    ),
    budgetMix: Object.fromEntries(budgetMix),
    examples: city.places.slice(0, 5).map((p) => briefPlace(p.id)).filter(Boolean),
  };
}

function playerProgress(save: PlayerSave, stamped: Set<string>): ToolResult {
  const stampedPlaces = PLACES.filter((p) => stamped.has(p.id));
  const citiesDone = new Set(stampedPlaces.map((p) => p.city));
  const clearedCities = CITIES.filter((c) => c.places.every((p) => stamped.has(p.id)));

  // The shared derivation, not arithmetic redone here. The stamp book calls the
  // same function, so the two cannot disagree about a player's XP.
  const xpBreakdown = computeXp({
    stamps: stamped,
    claimedQuests: save.claimed,
    dailiesDone: save.dailiesDone,
  });
  const xp = xpBreakdown.total;
  const level = levelState(xp);
  const streak: StreakState = streakState(save.activeDays ?? []);
  const earned = satisfiedAchievements({ stamps: stamped, bestStreak: streak.best });

  const quests = evaluateQuests(stamped, asSet(save.claimed));

  return {
    // `stampedPlaces.length` would exclude stale ids, but the album header, the
    // progress bar and the XP figure all count every id in the save. Reported the
    // way the stamp book reports it, or the assistant contradicts the page.
    stamped: save.stamped.length,
    ofTotal: TOTALS.places,
    xp,
    xpBreakdown: {
      perStamp: xpBreakdown.fromStamps,
      questRewards: xpBreakdown.fromQuests,
      cityClearance: xpBreakdown.fromCities,
      dailyBonus: xpBreakdown.fromDailies,
    },
    level: {
      // `Level.index` is zero-based -- index 0 is level 1 -- so the number a
      // player reads is one more than the stored index.
      number: level.level.index + 1,
      title: level.level.title,
      xpToNext: level.xpToNext,
      maxed: level.maxed,
    },
    streak: {
      current: streak.current,
      best: streak.best,
      // True when the streak is alive but today has no stamp yet, which is the
      // state a player is in every morning.
      atRisk: streak.atRisk,
      lastActive: streak.lastActive,
    },
    citiesTouched: citiesDone.size,
    citiesCleared: xpBreakdown.citiesCleared,
    questsComplete: quests.filter((q) => q.complete).length,
    questsTotal: quests.length,
    questsClaimable: quests.filter((q) => q.claimable).map((q) => q.quest.title),
    achievementsEarned: [...earned],
    achievementsTotal: ACHIEVEMENTS.length,
  };
}

function questBoard(args: Record<string, unknown>, save: PlayerSave, stamped: Set<string>): ToolResult {
  const limit = Math.min(25, Math.max(1, Number(args.limit ?? 8)));
  const tier = typeof args.tier === "string" ? String(args.tier) : null;

  const claimed = asSet(
    save.claimed ?? (args.save && typeof args.save === "object"
      ? ((args.save as Record<string, unknown>).claimed as string[] | undefined)
      : undefined),
  );

  let states = evaluateQuests(stamped, claimed);
  if (tier) states = states.filter((s) => s.quest.tier === tier);
  const ordered = sortForBoard(states).slice(0, limit);

  return {
    total: states.length,
    showing: ordered.length,
    tier: tier ? TIER_LABELS[tier as keyof typeof TIER_LABELS] : "all tiers",
    quests: ordered.map((s) => ({
      id: s.quest.id,
      title: s.quest.title,
      tier: TIER_LABELS[s.quest.tier],
      progress: s.progress,
      target: s.target,
      complete: s.complete,
      claimable: s.claimable,
      reward: s.quest.reward,
    })),
  };
}

function collectionGaps(stamped: Set<string>, args: Record<string, unknown>): ToolResult {
  const limit = Math.min(20, Math.max(1, Number(args.limit ?? 6)));

  const byCity = CITIES.map((c) => ({
    city: c.label,
    slug: c.slug,
    total: c.places.length,
    done: c.places.filter((p) => stamped.has(p.id)).length,
  }))
    .filter((c) => c.done < c.total)
    .sort((a, b) => a.done - b.done || a.total - b.total);

  const byCategory = CATEGORIES.map((cat) => {
    const all = PLACES.filter((p) => p.categories.includes(cat));
    return {
      category: CATEGORY_LABELS[cat],
      total: all.length,
      done: all.filter((p) => stamped.has(p.id)).length,
    };
  })
    .filter((c) => c.done < c.total)
    .sort((a, b) => a.done - b.done || a.total - b.total);

  // Unstarted cities first, then the least-started: the shortest way to a
  // completion is whatever is closest to done, not whatever is biggest.
  const suggestions = byCity.slice(0, limit).map((c) => ({
    kind: "city",
    what: `${c.done} of ${c.total} in ${c.city}`,
    next: (() => {
      const city = CITY_BY_SLUG.get(c.slug);
      const next = city?.places.find((p) => !stamped.has(p.id));
      return next ? briefPlace(next.id) : null;
    })(),
  }));

  return {
    remaining: TOTALS.places - stamped.size,
    citiesInProgress: byCity.slice(0, 10),
    categoriesInProgress: byCategory,
    suggestions,
  };
}

/** The system prompt. Kept here so the corpus and the prompt cannot disagree. */
export const SYSTEM_PROMPT = `You are the assistant for Local Legends, a stamp album of 890 places that locals recommended across 202 cities.

Ground every factual claim in a tool call. The catalogue is closed: if a tool returns nothing for a place, that place is not in it, and the answer is to say so and name the nearest city that is. Do not produce a place name, a neighbourhood, a price or a recommendation from memory.

Never state a number the player earned. Level, XP, streak, quest completion and achievements all come from player_progress or quest_board. If the player asks how much they have done and you have not called a tool, call one.

Refuse cleanly when a question is outside the domain — anything needing live data such as today's opening hours or current prices, anything about the player's account, anything about a place not in the catalogue. Say what is missing, then offer the nearest thing that is known.

Write in the present tense and do not use the second person: "Alfama rewards an early start", not "you should go to Alfama early". Be concrete and brief.`;
