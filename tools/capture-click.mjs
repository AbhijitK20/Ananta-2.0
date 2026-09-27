/**
 * tools/capture-click.mjs — the gap in tools/capture.mjs, which cannot click.
 *
 * Furkot's "Plan new trip" dialog does not exist until you click something, so
 * capture.mjs measures the anonymous marketing page and never sees it. This does
 * the same job as capture.mjs, with one interaction: open the dialog, then probe.
 *
 *   node tools/capture-click.mjs [url] [outDir]
 *
 * It captures TWICE per viewport, because the dialog has a state that a
 * screenshot alone would have hidden. Ticking "Loop back to the starting point"
 * swaps the End point input for a Mid point one *in the same 730x28 box* and
 * rewrites the sentence above it, so the dialog does not grow. The two inputs
 * never coexist on screen, and the only way to know that is to measure both
 * states -- which is how lib/trip.ts's endpointFieldFor ended up returning "mid"
 * rather than "last".
 *
 * Writes, per viewport and per state: a PNG, a JSON of computed style + box for
 * every visible element, and once per viewport the full body HTML.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://trips.furkot.com/ui";
const outDir = process.argv[3] ?? "/tmp/furkot-ref";
mkdirSync(outDir, { recursive: true });

/** The same probe capture.mjs uses, plus the form attributes a dialog needs. */
const PROBE = `(() => {
  const out = [];
  const skip = /SCRIPT|STYLE|LINK|META|NOSCRIPT/;
  const walk = (el, depth) => {
    if (depth > 16) return;
    for (const c of el.children) {
      if (skip.test(c.tagName)) continue;
      const r = c.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { walk(c, depth + 1); continue; }
      const s = getComputedStyle(c);
      out.push({
        depth,
        tag: c.tagName.toLowerCase(),
        cls: typeof c.className === "string" ? c.className : "",
        id: c.id || "",
        type: c.getAttribute && c.getAttribute("type"),
        name: c.getAttribute && c.getAttribute("name"),
        placeholder: c.getAttribute && c.getAttribute("placeholder"),
        rect: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
        font: s.fontFamily, fs: s.fontSize, fw: s.fontWeight, lh: s.lineHeight, ls: s.letterSpacing, tt: s.textTransform,
        color: s.color, bg: s.backgroundColor, bgImg: s.backgroundImage,
        radius: s.borderRadius, border: s.border, shadow: s.boxShadow,
        pad: s.padding, mar: s.margin, gap: s.gap,
        display: s.display, position: s.position, flexDir: s.flexDirection, justify: s.justifyContent, align: s.alignItems,
        gridCols: s.gridTemplateColumns, maxW: s.maxWidth, minH: s.minHeight, zIndex: s.zIndex, overflow: s.overflow,
        boxSizing: s.boxSizing, ws: s.whiteSpace, objFit: s.objectFit, aspect: s.aspectRatio,
        href: c.getAttribute && c.getAttribute("href"),
        text: (c.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 200),
        kids: c.children.length,
      });
      walk(c, depth + 1);
    }
  };
  walk(document.body, 0);
  return out;
})()`;

const browser = await chromium.launch();
for (const [label, viewport, isMobile] of [
  ["desktop", { width: 1440, height: 900 }, false],
  ["mobile", { width: 390, height: 844 }, true],
]) {
  const ctx = await browser.newContext({ viewport, isMobile, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => document.styleSheets.length > 0, null, { timeout: 20000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    /* trackers keep the network busy forever; not fatal */
  }

  // The trigger is an <a class="guest">, not a <button>. getByRole("button")
  // times out on it, which is the first thing this script gets wrong.
  await page.locator("a.guest").first().click();
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.fonts.ready);

  for (const [state, act] of [
    ["oneway", async () => {}],
    [
      "loop",
      async () => {
        await page.locator("input.trip-type").first().click({ force: true });
        await page.waitForTimeout(1200);
      },
    ],
  ]) {
    await act();
    await page.screenshot({ path: `${outDir}/ui-modal-${label}-${state}.png` });
    const nodes = await page.evaluate(PROBE);
    writeFileSync(`${outDir}/ui-modal-${label}-${state}.json`, JSON.stringify(nodes, null, 2));
    console.log(`modal ${label} ${state}: ${nodes.length} nodes`);
  }
  writeFileSync(`${outDir}/ui-modal-${label}.html`, await page.evaluate(() => document.body.outerHTML));
  await ctx.close();
}
await browser.close();
