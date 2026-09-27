/**
 * verify.mjs — the half that tells you whether the rebuild is actually right.
 *
 * Eyeballing two screenshots side by side is how you ship a clone that is off
 * by 20px everywhere and never find out. This compares the measured box of each
 * named element, on the reference and on the local build, at a given viewport.
 *
 *   node tools/verify.mjs <refUrl> <localUrl> <pairsFile> [width]
 *
 * pairsFile is JSON: { "element name": [localSelector, referenceSelector], ... }
 * tools/pairs.json holds the set used to bring this clone to 0 deltas.
 *
 * Exit code is 1 if anything differs, so it can gate a build.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const [refUrl, localUrl, pairsFile, widthArg] = process.argv.slice(2);
const width = Number(widthArg ?? 1440);

if (!refUrl || !localUrl || !pairsFile) {
  console.error("usage: node tools/verify.mjs <refUrl> <localUrl> <pairs.json> [width]");
  process.exit(2);
}

const ALL_PAIRS = JSON.parse(readFileSync(pairsFile, "utf8"));

/* A pairs file is either a flat { name: [localSel, refSel] } map — the shape
   tools/pairs.json uses for the home page — or a map of route key to such a map,
   for the interior pages, which do not share selectors with each other. Select
   by whichever route the reference URL is on, falling back to the flat shape. */
const routeKey = (refUrl || "").replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "").split("/")[0] || "index";
const PAIRS =
  (ALL_PAIRS[routeKey] && typeof ALL_PAIRS[routeKey] === "object" ? ALL_PAIRS[routeKey] : ALL_PAIRS) || {};
const first = Object.values(PAIRS)[0];
if (first !== null && typeof first === "object" && !Array.isArray(first)) {
  console.error(
    `pairs file for "${routeKey}" is still nested one level too deep -`,
    Object.keys(PAIRS).join(", "),
  );
  process.exit(2);
}

const grab = (page, side) =>
  page.evaluate(
    ([pairs, s]) => {
      const o = {};
      for (const [name, sels] of Object.entries(pairs)) {
        const e = document.querySelector(sels[s]);
        if (!e) { o[name] = null; continue; }
        const r = e.getBoundingClientRect();
        o[name] = [Math.round(r.x), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)];
      }
      return o;
    },
    [PAIRS, side],
  );

/* LAL_CHROME=1 uses the system Chrome instead of playwright's bundled build,
   for hosts where `npx playwright install` cannot reach the CDN. */
const browser = await chromium.launch(process.env.LAL_CHROME ? { channel: "chrome" } : {});
const page = await (await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500 })).newPage();

/**
 * networkidle is not enough on its own. A page can reach it with a stylesheet
 * still pending, and then every measurement is taken against unstyled HTML —
 * which looks like a catastrophic layout regression rather than a broken load.
 * Wait for the sheets to actually exist, then for fonts, then for two frames.
 */
const settle = async (u) => {
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.styleSheets.length > 0, null, { timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(1500);
  await page.evaluate(() => new Promise((r) => { scrollTo(0, document.body.scrollHeight); setTimeout(r, 900); }));
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(800);
};

await settle(localUrl);
const mine = await grab(page, 0);
await settle(refUrl);
const ref = await grab(page, 1);
await browser.close();

const show = (v) => (v == null ? "MISSING".padEnd(20) : v.join(",").padEnd(20));

console.log(`${width}px  element`.padEnd(30) + "reference".padEnd(21) + "local".padEnd(21) + "dX   dY    dW   dH");
let bad = 0;
for (const name of Object.keys(PAIRS)) {
  const r = ref[name];
  const m = mine[name];
  if (!r || !m) {
    console.log(name.padEnd(30) + show(r) + show(m) + "  <== missing");
    bad++;
    continue;
  }
  const d = [m[0] - r[0], m[1] - r[1], m[2] - r[2], m[3] - r[3]];
  if (d.some(Boolean)) bad++;
  console.log(
    name.padEnd(30) + show(r) + show(m) + d.map((v) => (v > 0 ? "+" + v : String(v)).padStart(5)).join("") + (d.some(Boolean) ? "  <==" : ""),
  );
}

console.log(`\n${bad} of ${Object.keys(PAIRS).length} elements differ.`);
process.exit(bad ? 1 : 0);
