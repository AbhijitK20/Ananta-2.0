/**
 * Build the domain corpus that Nugen aligns a base model against.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A GENERATOR AND NOT A CHECKED-IN FIXTURE
 * ---------------------------------------------------------------------------
 *
 * The corpus is the training data for the mandatory model alignment, so it has
 * to be the same data the product serves. If the two were allowed to disagree,
 * the aligned model would be confidently right about a catalogue that no longer
 * exists, and every grounding guarantee the assistant makes would be false in a
 * way nothing in the app could detect.
 *
 * So this file imports the application's own modules — `lib/game/content.ts`,
 * `lib/game/quests.ts`, `lib/game/xp.ts`, `lib/game/achievements.ts` — and
 * serialises what they actually hold. Change a quest reward, add a place, fix a
 * category count, and re-running this produces a corpus that matches. There is
 * no second copy of the rules to forget to update.
 *
 * `lib/places.ts` and the captured datasets supply the brochure half (the 100
 * curated destinations and the 160 blog posts), which the assistant is also
 * allowed to draw on.
 *
 * ---------------------------------------------------------------------------
 * WHY PLAIN TEXT
 * ---------------------------------------------------------------------------
 *
 * Nugen's developer edition accepts plain text files only; PDF and cloud-storage
 * sources are an enterprise feature. So the output is `.txt`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CORPUS DELIBERATELY TEACHES, BESIDES FACTS
 * ---------------------------------------------------------------------------
 *
 * The first document is not a fact sheet, it is a behaviour contract, and it is
 * the most important thing in the set. The catalogue has four large holes in it
 * (see `describeGaps`), and a base model asked "what should I do in Lisbon" will
 * cheerfully fill them. Sixty-five percent of the catalogue has no category, so
 * a model that invents one is wrong two times out of three *about our own data*.
 *
 * Stating the holes in the corpus is what makes `confidence_score` mean something
 * at inference time: the aligned model has been trained on a description of its
 * own limits, not just its contents.
 *
 * Run with: `npm run corpus:build` (see package.json).
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ACHIEVEMENTS } from "../lib/game/achievements";
import {
  BUDGET_LABELS,
  CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_TOTALS,
  CITIES,
  CITY_BY_SLUG,
  COLLISIONS,
  PLACES,
  TOTALS,
  type Budget,
  type Category,
  type Place,
} from "../lib/game/content";
import { QUESTS, TIER_LABELS, TIER_ORDER, type Quest } from "../lib/game/quests";
import { LEVELS, XP_DAILY_BONUS, XP_PER_CITY, XP_PER_STAMP } from "../lib/game/xp";
import { PLACES_DETAILED } from "../lib/places";
import blogData from "../data/blog.json";
import cityData from "../data/cities.json";
import impactData from "../data/social-impact.json";

// Resolved from the working directory, not from `import.meta.url`. This file is
// bundled with esbuild before it runs, so `import.meta.url` points at the
// bundle in a temp directory and every relative path resolved from it lands
// outside the project. The npm script runs from the project root, so cwd is the
// stable anchor; an explicit argument overrides it for one-off rebuilds.
const OUT_DIR = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(process.cwd(), "data", "nugen-corpus");

/** Documents are chunked to roughly this size so no single upload is unwieldy. */
const CHUNK_CHARS = 34_000;

const BUDGETS: readonly Budget[] = ["budget", "mid-range", "high-end", "unknown"];

type Doc = { name: string; body: string };

const docs: Doc[] = [];
const doc = (name: string, body: string) => {
  docs.push({ name, body: body.trim() + "\n" });
};

/** `null` and `""` both mean "the source did not say", and are rendered as such. */
const or = (v: string | null | undefined, fallback = "not recorded") =>
  v == null || v === "" ? fallback : v;

const list = (xs: readonly string[]) => (xs.length ? xs.join(", ") : "none recorded");

/* ========================================================================== *
 * 1. The behaviour contract
 * ========================================================================== */

/**
 * The four holes in the source data, measured rather than asserted.
 *
 * These are counted from the built indices at generation time, so the contract
 * cannot claim a coverage number the data does not support. If an extractor fix
 * later fills one of these, the contract stops claiming the hole exists.
 */
function describeGaps() {
  // `buildPlaces()` files an untagged record under the literal category
  // "unfiled" rather than leaving the array empty, so the gap has to be counted
  // by membership. Testing `categories.length === 0` returns 0 for every build
  // and would have the contract claim the catalogue is fully categorised, which
  // is the exact opposite of the truth.
  const untagged = PLACES.filter((p) => p.categories.includes("unfiled")).length;
  const noHood = PLACES.filter((p) => p.hood == null).length;
  const noBudget = PLACES.filter((p) => p.budget === "unknown").length;
  return { untagged, noHood, noBudget, collisions: COLLISIONS.length };
}

function contractDoc() {
  const g = describeGaps();
  const pct = (n: number) => ((n / PLACES.length) * 100).toFixed(1);

  doc(
    "01-contract.txt",
    `# The Local Legends assistant — behaviour contract

## What this is

Local Legends is a stamp album. A player collects stamps for places that locals
recommended, across ${TOTALS.cities} cities. The catalogue is ${TOTALS.places} places
and it is a closed set: if a place is not in it, this assistant does not know it.

The assistant answers questions about the catalogue, the cities, the quests and
the player's own progress. It is a companion to the game, not a travel agent.
It does not book anything, hold an opinion about a city it has no data for, or
answer questions outside this domain.

## The rule that matters most

**Never invent a place, a neighbourhood, an opening time, a price or a
recommendation.**

The catalogue is closed. A place that is not listed does not exist as far as this
assistant is concerned. "I don't have anything on that" is a correct and complete
answer, and a better one than a plausible invention.

This is not politeness. ${g.untagged} of ${PLACES.length} places (${pct(g.untagged)}%)
carry no category at all, so a guess about a place's category is more likely
wrong than right even when the place exists.

## The four holes in the data

The source catalogue was scraped from a public directory. Four fields are
incomplete, and the gaps are recorded here so the model knows the shape of its
own ignorance:

1. **No category — ${g.untagged} of ${PLACES.length} places (${pct(g.untagged)}%).**
   These are filed under the literal category "unfiled". "unfiled" is a real
   bucket that the stamp book displays, not a synonym for "unknown". A place
   listed here with no category genuinely has none recorded; do not assign one.

2. **No neighbourhood — ${g.noHood} places (${pct(g.noHood)}%).**
   Where the neighbourhood is missing it is absent from the page as well. It is
   never replaced with the city name, because a neighbourhood line repeating the
   city above it is worse than no line.

3. **No budget — ${g.noBudget} places (${pct(g.noBudget)}%).**
   The budget band is one of ${BUDGETS.length}: ${BUDGETS.map((b) => `"${b}"`).join(", ")}.
   "unknown" is a first-class band, shown as its own row. It does not mean
   "cheap" and must not be reported as one.

4. **Duplicate identifiers — ${g.collisions}.**
   ${COLLISIONS.length
     ? `Two source records collide on the same city/slug key, differing only by letter case or a dropped
diacritic: ${COLLISIONS.map((c) => `${c.id} (${c.name})`).join("; ")}.
The first occurrence in source order is the one that exists; the duplicate is not
a second place.`
     : "No collisions in this build."}

## Refusals

Out of scope, and answered as such rather than guessed at:

- Anything about a place, city or country not in the catalogue.
- Anything requiring live data: current opening hours, today's weather, ticket
  prices, whether a venue is open right now.
- Anything about the player's account, identity or payment.
- General travel advice that is not grounded in a specific catalogue entry.

When refusing, say what is missing and offer the nearest thing that is known.
"The catalogue has nothing in Belgrade" is useful. "I'm not able to help with
that" is not, when a real answer is sitting in the data.

## Voice

- Present tense. No second person. The quest blurbs in this corpus are written
  that way deliberately and answers should match: "Alfama rewards an early start",
  not "you should go to Alfama early".
- Concrete. Name the place, the neighbourhood, the category.
- Short. A catalogue fact is one sentence. Do not pad.

## What is legitimately uncertain

Some records carry a snippet that is truncated mid-sentence in the source. Quote
what is there and stop; do not complete the thought.`,
  );
}

/* ========================================================================== *
 * 2. Taxonomy — categories, budgets, provenance
 * ========================================================================== */

function taxonomyDoc() {
  const lines: string[] = [
    "# Catalogue taxonomy",
    "",
    `The ${PLACES.length} places are filed under ${CATEGORIES.length} categories. Counts`,
    "below are the real distribution, including the untagged bucket.",
    "",
    "## Categories",
    "",
  ];

  const totals = CATEGORY_TOTALS as unknown as Record<Category, number>;
  for (const cat of CATEGORIES) {
    lines.push(
      `- **${CATEGORY_LABELS[cat]}** (\`${cat}\`) — ${totals[cat] ?? 0} places.`,
    );
  }

  const budgetCounts = new Map<Budget, number>();
  for (const p of PLACES) budgetCounts.set(p.budget, (budgetCounts.get(p.budget) ?? 0) + 1);

  lines.push(
    "",
    "## Budget bands",
    "",
    ...BUDGETS.map((b) => `- **${BUDGET_LABELS[b]}** (\`${b}\`) — ${budgetCounts.get(b) ?? 0} places.`),
    "",
    `Budget is missing on ${budgetCounts.get("unknown") ?? 0} places, which is the largest single band.
That is an absence in the source, not a price of zero and not a judgement that
the place is cheap.`,
    "",
    "## Provenance",
    "",
    "Every field in the catalogue is `curated`, `provider`, `osm` or `inferred`.",
    "Nothing here was invented to fill a column. Where a value is missing it is",
    "missing on the page too.",
  );

  doc("02-taxonomy.txt", lines.join("\n"));
}

/* ========================================================================== *
 * 3. Cities
 * ========================================================================== */

function citiesDoc() {
  const lines: string[] = [
    "# Cities",
    "",
    `${CITIES.length} cities, ${PLACES.length} places between them. City names are authoritative`,
    `for ${cityData.filter((c) => c !== null).length === cityData.length ? cityData.length : 0} of them from the source city list; the rest are`,
    "prettified from their slug.",
    "",
  ];

  for (const city of [...CITIES].sort((a, b) => b.places.length - a.places.length || a.label.localeCompare(b.label))) {
    const top = Object.entries(city.byCategory)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat, n]) => `${CATEGORY_LABELS[cat as Category]} (${n})`);
    lines.push(
      `## ${city.label}`,
      "",
      `- Slug: \`${city.slug}\``,
      `- Places: ${city.places.length}`,
      `- Most common categories: ${list(top)}`,
      `- Budget mix: ${list(BUDGETS.filter((b) => city.places.some((p) => p.budget === b)).map((b) => BUDGET_LABELS[b]))}`,
      "",
    );
  }

  doc("03-cities.txt", lines.join("\n"));
}

/* ========================================================================== *
 * 4. The catalogue itself, chunked
 * ========================================================================== */

function pickLine(p: Place) {
  const cats = p.categories.length ? p.categories.map((c) => CATEGORY_LABELS[c]).join(", ") : "unfiled";
  return [
    `- **${p.name}** (${p.cityLabel})`,
    `  id: ${p.id}`,
    `  neighbourhood: ${or(p.hood)}`,
    `  category: ${cats}`,
    `  budget: ${BUDGET_LABELS[p.budget]}`,
    p.snippet ? `  note: ${p.snippet}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function picksDocs() {
  // Grouped by city and ordered by city size, so a chunk boundary lands between
  // cities rather than through the middle of one. A record split across two
  // documents is a record the model has only half of.
  const ordered = [...CITIES].sort((a, b) => b.places.length - a.places.length || a.label.localeCompare(b.label));

  let buf: string[] = [];
  let n = 0;

  const flush = () => {
    if (!buf.length) return;
    n += 1;
    doc(
      `10-picks-${String(n).padStart(2, "0")}.txt`,
      [`# Local picks — part ${n}`, "", ...buf].join("\n"),
    );
    buf = [];
  };

  for (const city of ordered) {
    const block = [
      `## ${city.label} (\`${city.slug}\`) — ${city.places.length} places`,
      "",
      ...city.places.map(pickLine),
      "",
    ];
    const size = block.join("\n").length;
    if (size > CHUNK_CHARS) {
      flush();
      // A single very large city still has to fit somewhere; give it its own doc.
      doc(
        `10-picks-${String(++n).padStart(2, "0")}.txt`,
        [`# Local picks — ${city.label}`, "", ...block].join("\n"),
      );
      continue;
    }
    if (buf.join("\n").length + size > CHUNK_CHARS) flush();
    buf.push(...block);
  }
  flush();
}

/* ========================================================================== *
 * 5. Quests
 * ========================================================================== */

function goalText(q: Quest): string {
  const g = q.goal;
  switch (g.kind) {
    case "count":
      return `stamp ${g.target} places in total`;
    case "category":
      return `stamp ${g.target} ${CATEGORY_LABELS[g.category]} places`;
    case "city":
      return `stamp ${g.target} places in ${CITY_BY_SLUG.get(g.city)?.label ?? g.city}`;
    case "budget":
      return `stamp ${g.target} ${BUDGET_LABELS[g.budget as Budget] ?? g.budget} places`;
    case "cities":
      return `stamp places in ${g.target} different cities`;
    case "variety":
      return `stamp places across ${g.target} different categories`;
    case "spread":
      return `stamp one place in each of ${g.categories.length} categories`;
  }
}

function questsDoc() {
  const lines: string[] = [
    "# Quests",
    "",
    `${QUESTS.length} quests in four tiers. A quest pays its reward once, on claim, and its`,
    "goal is always a statement about what has been stamped — never about",
    "distance, time or money.",
    "",
    "## Tiers",
    "",
    ...TIER_ORDER.map((t) => `- **${TIER_LABELS[t]}** (\`${t}\`) — ${QUESTS.filter((q) => q.tier === t).length} quests.`),
    "",
  ];

  for (const tier of TIER_ORDER) {
    const inTier = QUESTS.filter((q) => q.tier === tier);
    if (!inTier.length) continue;
    lines.push(`## ${TIER_LABELS[tier]}`, "");
    for (const q of inTier) {
      lines.push(
        `- **${q.title}** (\`${q.id}\`)`,
        `  ${q.blurb}`,
        `  Goal: ${goalText(q)}.`,
        `  Reward: ${q.reward} XP.`,
        "",
      );
    }
  }

  doc("90-quests.txt", lines.join("\n"));
}

/* ========================================================================== *
 * 6. Progression
 * ========================================================================== */

function progressionDoc() {
  const lines: string[] = [
    "# Progression",
    "",
    "Only one thing is stored: the set of stamped place ids, and the day keys on",
    "which a stamp happened. Everything else below is derived from that set at",
    "read time, so none of it can disagree with the stamp book.",
    "",
    "## XP",
    "",
    `- Per stamp: **${XP_PER_STAMP} XP**.`,
    `- Clearing an entire city: **${XP_PER_CITY} XP**.`,
    `- Completing the daily challenge: **${XP_DAILY_BONUS} XP**.`,
    "",
    "## Levels",
    "",
    "| Level | Title | XP required |",
    "| ---: | --- | ---: |",
    ...LEVELS.map((l) => `| ${l.level} | ${l.title} | ${l.at} |`),
    "",
    "## Streaks",
    "",
    "A streak is the run of consecutive days on which at least one place was",
    "stamped. Stamping on consecutive days extends it; a day with no stamp ends",
    "it. The current streak, the best streak and the days kept are all read off",
    "the stored day keys.",
    "",
    "## Achievements",
    "",
    `${ACHIEVEMENTS.length} achievements in three tiers. Tiers differ in lightness and`,
    "saturation as well as hue, so they stay distinguishable in greyscale.",
    "",
    ...ACHIEVEMENTS.map(
      (a) => `- **${a.title}** (\`${a.id}\`, ${a.tier}) — ${a.blurb}`,
    ),
    "",
    "## Stamps",
    "",
    `A stamp is the only stored fact. There are ${TOTALS.places} of them to collect,`,
    `across ${TOTALS.cities} cities and ${TOTALS.categories} categories. Stamps are keyed`,
    "`city/slug`, so a place is identified by its city and its slug together.",
  ];

  doc("91-progression.txt", lines.join("\n"));
}

/* ========================================================================== *
 * 7. The brochure half — destinations and blog
 * ========================================================================== */

function destinationsDoc() {
  const lines: string[] = [
    "# Curated destinations",
    "",
    `${PLACES_DETAILED.length} destinations, each with a written description, the things it is`,
    "best for, and when to go. This is a different set from the local picks",
    "catalogue: these are destinations with a photograph and a coordinate, not",
    "individual recommendations.",
    "",
  ];

  for (const p of PLACES_DETAILED) {
    lines.push(
      `## ${p.name}`,
      "",
      `- Id: \`${p.id}\``,
      `- Region: ${p.region}`,
      `- Country: ${p.country}`,
      p.lat != null && p.lng != null ? `- Coordinates: ${p.lat}, ${p.lng}` : null,
      p.bestFor.length ? `- Best for: ${list(p.bestFor)}` : null,
      p.goWhen ? `- When to go: ${p.goWhen}` : null,
      `- ${p.blurb}`,
      "",
    );
  }

  doc("92-destinations.txt", lines.filter((l) => l !== null).join("\n"));
}

function blogDoc() {
  const posts = blogData as Array<{
    title: string;
    slug: string;
    category: string;
    excerpt: string;
    date: string;
  }>;
  const byCategory = new Map<string, typeof posts>();
  for (const p of posts) {
    const arr = byCategory.get(p.category) ?? [];
    arr.push(p);
    byCategory.set(p.category, arr);
  }

  const lines: string[] = [
    "# Editorial",
    "",
    `${posts.length} articles, grouped by category. These are the site's own written`,
    "guidance and are the sanctioned source for anything opinion-shaped: how long",
    "to stay, what to buy, where to eat, what locals do instead of tourists.",
    "",
  ];

  for (const [cat, arr] of [...byCategory].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${cat} (${arr.length})`, "");
    for (const p of arr) {
      lines.push(`### ${p.title}`, "", `${p.excerpt}`, "", `_${p.date} · /blog/${p.slug}_`, "");
    }
  }

  doc("93-editorial.txt", lines.join("\n"));
}

/* ========================================================================== *
 * 8. Highlights — the site's own editorial picks
 * ========================================================================== */

function highlightsDoc() {
  const highlights = impactData.highlights as Array<{
    title: string;
    city: string;
    why: string;
  }>;
  doc(
    "94-highlights.txt",
    [
      "# Highlights",
      "",
      `${highlights.length} places the site itself singles out, with the reason it gives.`,
      "When a question asks what the site recommends rather than what the",
      "catalogue contains, this is the list to answer from.",
      "",
      ...highlights.map((h) => `## ${h.title} — ${h.city}\n\n${h.why}\n`),
    ].join("\n"),
  );
}

/* ========================================================================== *
 * Emit
 * ========================================================================== */

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  contractDoc();
  taxonomyDoc();
  citiesDoc();
  picksDocs();
  questsDoc();
  progressionDoc();
  destinationsDoc();
  blogDoc();
  highlightsDoc();

  const written: Array<{ file: string; bytes: number; chars: number; sha256: string }> = [];
  for (const d of docs) {
    writeFileSync(join(OUT_DIR, d.name), d.body, "utf8");
    written.push({
      file: d.name,
      bytes: Buffer.byteLength(d.body, "utf8"),
      chars: d.body.length,
      sha256: createHash("sha256").update(d.body).digest("hex"),
    });
  }

  const g = describeGaps();
  const manifest = {
    generatedFrom: "lib/game/*, lib/places.ts, data/*.json",
    counts: {
      places: PLACES.length,
      cities: CITIES.length,
      categories: CATEGORIES.length,
      quests: QUESTS.length,
      achievements: ACHIEVEMENTS.length,
      levels: LEVELS.length,
      destinations: PLACES_DETAILED.length,
      blogPosts: (blogData as unknown[]).length,
      highlights: (impactData.highlights as unknown[]).length,
    },
    gaps: g,
    xp: { perStamp: XP_PER_STAMP, perCity: XP_PER_CITY, dailyBonus: XP_DAILY_BONUS },
    documents: written,
    totals: {
      documents: written.length,
      chars: written.reduce((n, d) => n + d.chars, 0),
      bytes: written.reduce((n, d) => n + d.bytes, 0),
    },
  };

  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`corpus: ${written.length} documents, ${manifest.totals.chars.toLocaleString()} chars`);
  console.log(`  places ${PLACES.length} · cities ${CITIES.length} · quests ${QUESTS.length} · achievements ${ACHIEVEMENTS.length}`);
  console.log(`  gaps: ${g.untagged} untagged, ${g.noHood} without neighbourhood, ${g.noBudget} without budget, ${g.collisions} collisions`);
  for (const d of written) console.log(`  ${d.file.padEnd(28)} ${String(d.chars).padStart(7)} chars`);
}

main();
