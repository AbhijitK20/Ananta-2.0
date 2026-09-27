/**
 * Answer a question from the deterministic game layer, with no model involved.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Nugen completed the alignment and the model deploys, but their inference
 * service answers maybe one request in forty. When it is down, `/api/chat`
 * currently returns an error and the panel is dead — even though the questions
 * it was being asked are answerable, exactly, without a language model at all.
 *
 * That is the actual shape of this feature. The engine already knows the
 * player's level, their XP, which quests are claimable, what is left to collect
 * and what a city holds. None of that was ever the model's job; the model was
 * there to phrase it. Losing the phrasing should cost the phrasing, not the
 * answer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not a fallback model, and it is not a base model wearing the aligned
 * model's name. It is a rule-based router into the same functions the game
 * already runs, and everything it says is a true statement about the save or the
 * catalogue.
 *
 * The caller is required to label it. Every answer produced here carries
 * `engine: true`, the UI renders a visible "the model did not respond" marker,
 * and no confidence score is shown — because no model ran, and inventing a
 * number for it would be the exact thing this project exists to avoid.
 *
 * The upside is that this path cannot hallucinate, so when the vendor is down
 * the product is *more* trustworthy, not less. The downside is that intent
 * matching is keyword-based, so it handles the questions it has rules for and
 * says so plainly when it does not.
 */

import {
  CITIES,
  CITY_BY_SLUG,
  CATEGORY_LABELS,
  BUDGET_LABELS,
  type Budget,
  type Category,
} from "../game/content";
import { evaluateQuests, sortForBoard, TIER_LABELS } from "../game/quests";
import { levelState } from "../game/xp";
import { computeXp } from "../game/progress";
import { streakState } from "../game/daily";
import { satisfiedAchievements, ACHIEVEMENTS } from "../game/achievements";
import { PLACES } from "../game/content";
import { runTool, type PlayerSave } from "./tools";

export type EngineAnswer = {
  /** Always true. The UI must render this as "the model did not answer". */
  engine: true;
  /** The tool that produced the answer, for display. */
  via: string;
  text: string;
  /** True when no rule matched, so the answer is a refusal rather than a fact. */
  unmatched: boolean;
};

/** Lowercased question text, punctuation flattened to single spaces. */
// Apostrophes are dropped rather than replaced with a space, so "haven't
// collected" normalises to "havent collected" and can match itself. Substituting
// a space produced "haven t collected", which made the contraction needles
// below unreachable -- the branch silently stopped firing.
const normalise = (q: string) =>
  ` ${q.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9\s/.-]/g, " ").replace(/\s+/g, " ")} `;

const has = (q: string, ...needles: string[]) => needles.some((n) => q.includes(n));

/** Slugify a phrase the way the catalogue's city slugs are built. */
const toSlug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Find a city mentioned in the question, by label or slug, longest first. */
function mentionedCity(q: string): string | null {
  const byLength = [...CITIES].sort((a, b) => b.label.length - a.label.length);
  for (const city of byLength) {
    if (q.includes(` ${city.label.toLowerCase()} `)) return city.slug;
    if (q.includes(` ${city.slug} `)) return city.slug;
  }
  // "in lisbon" / "belgrade" with no surrounding spaces at either end.
  for (const city of byLength) {
    const slug = city.slug;
    if (q.includes(` ${slug}`) || q.includes(`${slug} `)) return slug;
  }
  return null;
}

/** Find a category mentioned in the question. */
function mentionedCategory(q: string): Category | null {
  for (const cat of Object.keys(CATEGORY_LABELS) as Category[]) {
    if (q.includes(` ${cat} `) || q.includes(` ${cat}`)) return cat;
    const words = CATEGORY_LABELS[cat].toLowerCase();
    if (q.includes(` ${words} `) || q.includes(` ${words}`)) return cat;
  }
  return null;
}

function mentionedBudget(q: string): Budget | null {
  for (const b of Object.keys(BUDGET_LABELS) as Budget[]) {
    if (q.includes(` ${b} `) || q.includes(` ${b}`)) return b;
    if (q.includes(` ${BUDGET_LABELS[b].toLowerCase()} `)) return b;
  }
  return null;
}

const pct = (n: number, of: number) => (of === 0 ? "0" : String(Math.round((n / of) * 100)));

/* -------------------------------------------------------------------------- *
 * The rules, most specific first
 * -------------------------------------------------------------------------- */

export function answerFromEngine(question: string, save: PlayerSave): EngineAnswer {
  const q = normalise(question);
  const stamped = new Set(save.stamped ?? []);
  const stampedPlaces = PLACES.filter((p) => stamped.has(p.id));

  /* -- progress ---------------------------------------------------------- */
  if (
    has(q, "how many stamp", "how much xp", "my progress", "my xp", "my level",
        "how many quest", "quests complete",
        "my streak", "how am i doing", "what have i collected", "my collection",
        "my score", "how far am i")
  ) {
    const citiesTouched = new Set(stampedPlaces.map((p) => p.city));
    // The album header, the progress bar, the erase confirmation and the sidebar
    // badge all read `stamps.size`, and XP is paid on it too. Counting only
    // catalogue-valid ids here would make the chat contradict all four -- and
    // contradict the XP figure printed two lines below it -- the moment a save
    // held a stale id.
    const stampCount = save.stamped?.length ?? 0;
    // The shared derivation. Recomputing this here is exactly how the chat panel
    // and the level bar would end up showing different numbers, which is the one
    // thing this panel promises it cannot do.
    const xpParts = computeXp({
      stamps: save.stamped ?? [],
      claimedQuests: save.claimed ?? [],
      dailiesDone: save.dailiesDone ?? [],
    });
    const xp = xpParts.total;
    const level = levelState(xp);
    const streak = streakState(save.activeDays ?? []);
    const quests = evaluateQuests(stamped, new Set(save.claimed ?? []));
    const claimable = quests.filter((q2) => q2.claimable);
    const earned = satisfiedAchievements({ stamps: stamped, bestStreak: streak.best });

    const lines = [
      `${stampCount} of ${PLACES.length} places stamped (${pct(stampCount, PLACES.length)}%).`,
      `${xp} XP — level ${level.level.index + 1}, ${level.level.title}` +
        (level.maxed ? ", maxed." : `, ${level.xpToNext} XP to level ${level.level.index + 2}.`) +
        ` (+${xpParts.fromStamps} from stamps, +${xpParts.fromQuests} from quest rewards, +${xpParts.fromCities} from city clears, +${xpParts.fromDailies} from dailies).`,
      `${citiesTouched.size} of ${CITIES.length} cities touched; ${xpParts.citiesCleared} cleared outright.`,
      `Streak: ${streak.current} day${streak.current === 1 ? "" : "s"} now, best ${streak.best}.`,
      `Quests: ${quests.filter((q2) => q2.complete).length} of ${quests.length} complete` +
        (claimable.length ? `, ${claimable.length} claimable now.` : ", none claimable yet."),
      `Achievements: ${earned.size} of ${ACHIEVEMENTS.length} earned.`,
    ];
    return { engine: true, via: "player_progress", unmatched: false, text: lines.join("\n") };
  }

  /* -- a named city ------------------------------------------------------ */
  const city = mentionedCity(q);
  const category = mentionedCategory(q);
  const budget = mentionedBudget(q);

  if (city) {
    const c = CITY_BY_SLUG.get(city);
    if (!c) {
      return {
        engine: true,
        via: "city_summary",
        unmatched: false,
        text: `The catalogue has no city called "${city}". The ${CITIES.length} cities it does hold start with ${CITIES.slice(0, 6).map((x) => x.label).join(", ")}.`,
      };
    }
    const done = c.places.filter((p) => stamped.has(p.id)).length;
    const mix = Object.entries(c.byCategory)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([cat, n]) => `${CATEGORY_LABELS[cat as Category]} (${n})`);

    const lines = [
      `${c.label} — ${c.places.length} places in the catalogue.` +
        (done ? ` ${done} stamped.` : " None stamped yet."),
      `Most common categories: ${mix.join(", ")}.`,
    ];
    if (c.places.length) {
      lines.push("A few of them:");
      for (const p of c.places.slice(0, 5)) {
        const bits = [
          `  - ${p.name}`,
          p.hood ? `(${p.hood})` : null,
          `— ${p.categories.length ? p.categories.map((x) => CATEGORY_LABELS[x]).join(", ") : "no category recorded"}`,
          p.budget !== "unknown" ? `, ${BUDGET_LABELS[p.budget]}` : null,
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(bits);
      }
    }
    if (category) {
      const inCat = c.places.filter((p) => p.categories.includes(category));
      lines.push(
        inCat.length
          ? `In ${CATEGORY_LABELS[category]}: ${inCat.map((p) => p.name).join(", ")}.`
          : `${CATEGORY_LABELS[category]} has no entry in ${c.label}.`,
      );
    }
    return { engine: true, via: "city_summary", unmatched: false, text: lines.join("\n") };
  }

  /* -- a category or budget on its own ------------------------------------ */
  if (category || budget) {
    let hits = PLACES;
    if (category) hits = hits.filter((p) => p.categories.includes(category as Category));
    if (budget) hits = hits.filter((p) => p.budget === budget);
    const label = [
      category ? CATEGORY_LABELS[category] : null,
      budget ? BUDGET_LABELS[budget] : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      engine: true,
      via: "search_places",
      unmatched: false,
      text: hits.length
        ? `${hits.length} places are ${label}. A few: ${hits.slice(0, 10).map((p) => `${p.name} (${p.cityLabel})`).join(", ")}.`
        : `Nothing in the catalogue is filed under ${label}.`,
    };
  }

  /* -- a place name ------------------------------------------------------ */
  const cleaned = question.replace(/[^a-zA-Z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.split(" ").length <= 6 && cleaned.length > 2) {
    const slug = toSlug(cleaned);
    const hit = PLACES.find(
      (p) => p.slug === slug || toSlug(p.name) === slug || p.id === `${slug}`,
    );
    if (hit) {
      const done = stamped.has(hit.id);
      return {
        engine: true,
        via: "lookup_place",
        unmatched: false,
        text: [
          `${hit.name} — ${hit.cityLabel}${hit.hood ? `, ${hit.hood}` : ""}.`,
          `Filed under: ${hit.categories.length ? hit.categories.map((c) => CATEGORY_LABELS[c]).join(", ") : "no category recorded"}.`,
          `Budget: ${BUDGET_LABELS[hit.budget]}.`,
          hit.snippet ? hit.snippet : null,
          done ? "Already stamped." : `Not stamped yet.`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
  }

  /* -- what next --------------------------------------------------------- */
  if (has(q, "what should i", "what next", "next quest", "what to do", "where to start",
          "help me choose", "quest", "claim", "reward")) {
    const states = sortForBoard(evaluateQuests(stamped, new Set(save.claimed ?? [])));
    const claimable = states.filter((s) => s.claimable);
    const lines: string[] = [];

    if (claimable.length) {
      lines.push(`${claimable.length} quest${claimable.length === 1 ? " is" : "s are"} ready to claim:`);
      for (const s of claimable.slice(0, 4)) {
        lines.push(`- ${s.quest.title} — ${TIER_LABELS[s.quest.tier]}, ${s.quest.reward} XP. ${s.quest.blurb}`);
      }
    } else {
      const closest = states.filter((s) => !s.complete).slice(0, 4);
      if (closest.length) {
        lines.push("Nothing claimable yet. Closest to done:");
        for (const s of closest) {
          lines.push(`- ${s.quest.title} — ${s.progress} of ${s.target}. ${s.quest.blurb}`);
        }
      } else {
        lines.push("Every quest is complete and claimed. The album is finished.");
      }
    }
    return { engine: true, via: "quest_board", unmatched: false, text: lines.join("\n") };
  }

  /* -- what is missing --------------------------------------------------- */
  if (has(q, "what am i missing", "havent collected", "havent i collected", "havent got",
    "have not collected", "what am i missing", "left to collect", "still need", "what's left", "whats left")) {
    const byCity = CITIES.map((c) => ({
      label: c.label,
      slug: c.slug,
      total: c.places.length,
      done: c.places.filter((p) => stamped.has(p.id)).length,
    }))
      .filter((c) => c.done < c.total)
      .sort((a, b) => a.done - b.done || a.total - b.total);

    const lines = [
      `${PLACES.length - stamped.size} places still unstamped.`,
      "Least-started cities:",
      ...byCity.slice(0, 6).map((c) => `- ${c.label}: ${c.done} of ${c.total}`),
    ];
    return { engine: true, via: "collection_gaps", unmatched: false, text: lines.join("\n") };
  }

  /* -- nothing matched --------------------------------------------------- */
  return {
    engine: true,
    via: "none",
    unmatched: true,
    text:
      "No rule here covers that, and the aligned model is not responding, so there is nothing " +
      "truthful to answer with. The questions this can answer on its own are: how many stamps or " +
      "how much XP, what to collect next, what is still missing, what a given city holds, and " +
      "anything about one named place.",
  };
}
