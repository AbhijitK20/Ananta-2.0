/**
 * extract-content.mjs — rebuilds the real datasets from a live URL.
 *
 * The interior pages of likealocalguide.com are not hand-written: /blog is a
 * 160-card archive and /social-impact is an 892-card directory across three
 * columns. Rebuilding those as three hard-coded sample cards would be a mock,
 * not a clone, so the listings are extracted from the real DOM.
 *
 *   node tools/extract-content.mjs <baseUrl> <outDir>
 *
 * The extraction runs INSIDE the page, walking each card's own subtree. Doing it
 * from the outside — matching a card's y-range against a flat list of probe
 * entries — silently merges the three cards in a row into one, because they
 * share a y-range and differ only in x. That produced 298 entries instead of
 * 892 and put every card in the last category. Ask the DOM for a card's
 * descendants and the question never arises.
 *
 * Emits JSON that lib/content.ts imports. Deterministic: cards are emitted in
 * document order, and nothing is keyed off a timestamp.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [, , base, outDir = "."] = process.argv;

if (!base) {
  console.error("usage: node tools/extract-content.mjs <baseUrl> [outDir]");
  process.exit(1);
}

const slug = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

/**
 * Runs in the page. Two constraints, both learned the hard way:
 *
 *   1. It must be a real function, not a string. A string is evaluated as a
 *      single expression, so the second argument is silently dropped.
 *   2. It must take exactly ONE argument. Playwright asserts on a second, so
 *      the selector and the field map arrive as a single object.
 *
 * And it must read each card's own subtree. Matching a card's y-range against a
 * flat list of entries merges the three cards in a row into one, because they
 * share a y-range and differ only in x — which is how 892 entries quietly
 * became 298, all filed under the last category.
 */
function EXTRACT({ cardSelector, fieldMap }) {
  const txt = (el, sel) => {
    const n = sel ? el.querySelector(sel) : el;
    return n ? (n.textContent || "").trim().replace(/\s+/g, " ") : "";
  };
  const attr = (el, sel, a) => {
    const n = sel ? el.querySelector(sel) : el;
    return n ? n.getAttribute(a) || "" : "";
  };
  const out = [];
  for (const card of document.querySelectorAll(cardSelector)) {
    const rec = {};
    for (const [key, sel] of Object.entries(fieldMap)) {
      if (key === "href") rec[key] = card.getAttribute("href") || "";
      else if (key === "src") {
        // `.lalg-hlimg` is a div painted with background-image, not an <img>,
        // so an attribute lookup returns nothing and the 42 highlight cards
        // come back with no image at all.
        const n = sel ? card.querySelector(sel) : card;
        rec[key] =
          attr(card, sel, "src") ||
          attr(card, sel, "data-src") ||
          (n ? (getComputedStyle(n).backgroundImage.match(/url\(["']?(.*?)["']?\)/) || [])[1] || "" : "");
      }
      else rec[key] = txt(card, sel);
    }
    out.push(rec);
  }
  return out;
}

/** Category for each card, by document position rather than by geometry. */
function CATEGORIES(cardSelector) {
  const heads = [...document.querySelectorAll("h2, h3")].filter((h) => (h.textContent || "").trim());
  const label = (h) => (h.textContent || "").trim();
  return [...document.querySelectorAll(cardSelector)].map((card) => {
    // Walk the headings and keep the last one that precedes the card in
    // document order. `cat === "Other" || true` would be silly; this is just
    // "last heading before this card".
    let cat = "Other";
    for (const h of heads) {
      if (h.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) cat = label(h);
    }
    return cat;
  });
}

function HEADINGS() {
  return [...document.querySelectorAll("h2, h3")]
    .filter((h) => (h.textContent || "").trim())
    .map((h) => (h.textContent || "").trim());
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

mkdirSync(outDir, { recursive: true });
const written = [];

/**
 * Retries, because hammering a small site across three long pages will get
 * some of those requests throttled, and a capture tool that dies on a 429 is
 * not a capture tool.
 */
const open = async (path, attempts = 4) => {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(base + path, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction(() => document.styleSheets.length > 0, null, { timeout: 25000 });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      // The directory is very long; walk it so lazy content mounts.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 800) {
          scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 90));
        }
        scrollTo(0, 0);
      });
      await page.waitForTimeout(1200);
      return;
    } catch (e) {
      last = e;
      console.warn("  retrying " + path + " (" + (i + 1) + "/" + attempts + "): " + e.name);
      await page.waitForTimeout(4000 * (i + 1));
    }
  }
  throw new Error("could not load " + path + ": " + last.message);
};

// ---------------------------------------------------------------- cities ----
await open("/cities/");
// The grid is injected by a shortcode, so it is absent from the initial HTML.
// Reading before it mounts yields zero cards, which looks like "no data"
// rather than "not ready yet".
await page.waitForSelector("a.lalg-citycard", { timeout: 30000 });
{
  const rows = await page.evaluate(EXTRACT, {
    cardSelector: "a.lalg-citycard",
    // `href` must be declared even though it maps to no selector: EXTRACT reads
    // it off the card element itself, and an undeclared key leaves it
    // undefined, which makes the dedup set collapse the page to one entry.
    fieldMap: { name: ".cn", text: "", href: "" },
  });
  const cities = [];
  const seen = new Set();
  for (const r of rows) {
    // The name span and the count span are adjacent with no whitespace between
    // them, so "Paris" + "117 local picks" reads as "Paris117 local picks".
    // Take the name from .cn and only the number from the flattened text.
    const m = r.text.match(/(\d+)\s+local picks/);
    if (!r.name || seen.has(r.href)) continue;
    seen.add(r.href);
    cities.push({ name: r.name, slug: slug(r.name), picks: m ? Number(m[1]) : null, href: r.href });
  }
  writeFileSync(join(outDir, "cities.json"), JSON.stringify(cities, null, 1) + "\n");
  written.push(`cities.json — ${cities.length}`);
}

// ------------------------------------------------------------------ blog ----
await open("/blog/");
{
  const rows = await page.evaluate(EXTRACT, {
    cardSelector: "a.lal-tip-card",
    fieldMap: {
      title: ".lal-tip-title",
      category: ".lal-tip-cat",
      excerpt: ".lal-tip-ex",
      date: ".lal-tip-meta",
      src: ".lal-tip-media img",
      href: "",
    },
  });
  const posts = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.title || seen.has(r.title)) continue;
    seen.add(r.title);
    posts.push({ ...r, slug: slug(r.title) });
  }
  writeFileSync(join(outDir, "blog.json"), JSON.stringify(posts, null, 1) + "\n");
  written.push(`blog.json — ${posts.length} of ${rows.length} cards (${rows.length - posts.length} duplicate titles)`);
}

// --------------------------------------------------------- social impact ----
await open("/social-impact/");
{
  await page.waitForSelector("a.lalg-card", { timeout: 30000 });

  /**
   * The category is a data attribute, not a heading.
   *
   * Two plausible-looking approaches are both wrong. Taking the nearest
   * preceding `h2`/`h3` fails because every card's own title is an
   * `h3.lalg-card-title` — 393 of the 900 headings on this page are business
   * names, so each card inherits the card before it. Iterating `.lalg-wrap`
   * fails because all seven categories share one wrap, yielding a single
   * category. And the seven visible `h3`s are the highlight-carousel headings,
   * not section boundaries for the grid at all.
   *
   * The grid below the carousels is one flat list of 892 cards, each tagged
   * `data-cats` (space-separated, since a business can be in two categories).
   */
  const CATEGORISED = `(() => {
    const clean = (s) => (s || "").trim().replace(/\\s+/g, " ");
    const q = (c, sel) => c.querySelector(sel);
    const t = (c, sel) => clean(q(c, sel) && q(c, sel).textContent);
    return [...document.querySelectorAll("a.lalg-card")].map((c) => ({
      name: t(c, ".lalg-card-title"),
      meta: t(c, ".lalg-card-meta"),
      hood: t(c, ".lalg-card-hood"),
      snippet: t(c, ".lalg-card-snip"),
      link: t(c, ".lalg-card-link"),
      href: c.getAttribute("href") || "",
      city: c.dataset.city || "",
      cats: c.dataset.cats || "",
      budget: c.dataset.budget || "",
    }));
  })()`;

  const rows = await page.evaluate(CATEGORISED);
  const sectionOf = [...new Set(rows.flatMap((r) => r.cats.split(" ").filter(Boolean)))].sort();

  const highlights = await page.evaluate(EXTRACT, {
    cardSelector: "a.lalg-hlcard",
    fieldMap: {
      title: ".lalg-hltitle",
      city: ".lalg-hlcity",
      why: ".lalg-hlwhy",
      src: ".lalg-hlimg",
      href: "",
    },
  });

  const entries = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.name) continue;
    const key = r.name + "|" + r.href;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ ...r, slug: slug(r.name), category: r.cats });
  }

  writeFileSync(
    join(outDir, "social-impact.json"),
    JSON.stringify({ categories: sectionOf, entries, highlights }, null, 1) + "\n",
  );
  const tagged = entries.filter((e) => e.cats).length;
  written.push(
    `social-impact.json — ${entries.length} entries (${tagged} categorised, ${sectionOf.length} category tags), ${highlights.length} highlights`,
  );
}

await browser.close();

for (const line of written) console.log("wrote", line);
