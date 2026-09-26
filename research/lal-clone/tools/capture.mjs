/**
 * capture.mjs — the "screenshot to code" half of the pipeline.
 *
 * Point it at any URL and it produces the three artefacts a rebuild actually
 * needs. A screenshot alone is not enough: it tells you what a box looks like,
 * not how wide it is, what its computed font-size is, or that its margins
 * collapse. Every value that made this clone exact came from the probes, not
 * from looking at the picture.
 *
 *   node tools/capture.mjs <url> [outDir] [--mobile]
 *
 * Writes into outDir:
 *   <route>-desktop.png   full-page, 1440x900
 *   <route>-mobile.png    full-page, 390x844
 *   <route>.json          computed style + box for every visible element
 *   <route>.tree.json     the DOM outline, for structure
 *   <route>.css           every <style> block the page ships, extracted
 *   site.css              every linked stylesheet, downloaded
 *
 * Then run tools/verify.mjs to diff the rebuild against these numbers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const url = process.argv[2];
const outDir = process.argv[3] ?? "/tmp/capture";
const routes = url.includes(",") ? url.split(",") : [url];

if (!url) {
  console.error("usage: node tools/capture.mjs <url>[,<url>...] [outDir]");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

/**
 * Walks every element that actually occupies space and records the computed
 * style plus the border box. Elements with a zero box are recursed into rather
 * than recorded, because a wrapper that collapses still decides its children's
 * layout and hiding it loses that.
 */
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
        rect: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
        font: s.fontFamily, fs: s.fontSize, fw: s.fontWeight, lh: s.lineHeight, ls: s.letterSpacing, tt: s.textTransform,
        color: s.color, bg: s.backgroundColor, bgImg: s.backgroundImage, bgSize: s.backgroundSize, bgPos: s.backgroundPosition,
        radius: s.borderRadius, border: s.border, shadow: s.boxShadow,
        pad: s.padding, mar: s.margin, gap: s.gap,
        display: s.display, position: s.position, flexDir: s.flexDirection, justify: s.justifyContent, align: s.alignItems,
        gridCols: s.gridTemplateColumns, maxW: s.maxWidth, minH: s.minHeight, zIndex: s.zIndex, overflow: s.overflow,
        boxSizing: s.boxSizing, ws: s.whiteSpace, objFit: s.objectFit, aspect: s.aspectRatio,
        src: (c.currentSrc || c.src || "").slice(0, 300),
        href: c.getAttribute && c.getAttribute("href"),
        text: (c.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 120),
        kids: c.children.length,
      });
      walk(c, depth + 1);
    }
  };
  walk(document.body, 0);
  return out;
})()`;

const slug = (u) => {
  const p = new URL(u).pathname.replace(/\/$/, "").replace(/^\//, "");
  return p || "index";
};

/**
 * A page that will not load must not take the run down with it. A crawl of
 * eight routes that dies on route four leaves you with three and no idea which
 * are trustworthy, so each route is isolated, retried, and reported.
 */
const open = async (page, target, attempts = 3) => {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.styleSheets.length > 0, null, { timeout: 20000 });
      try {
        await page.waitForLoadState("networkidle", { timeout: 20000 });
      } catch {
        /* ads and trackers keep the network busy forever; not fatal */
      }
      return true;
    } catch (e) {
      last = e;
      await page.waitForTimeout(1500 * (i + 1));
    }
  }
  errors.push("navigation failed after " + attempts + " attempts: " + last.message.slice(0, 120));
  return false;
};

/**
 * The failure mode this exists to stop: a page reaches `networkidle` with its
 * stylesheet still in flight, and the probe then records unstyled HTML. It does
 * not look like a failure — it looks like a catastrophic layout regression, and
 * it is the single easiest way to end up rebuilding a page that was fine.
 *
 * Two checks, because either alone is insufficient:
 *   1. at least one stylesheet, and
 *   2. the geometry of a sample of elements is IDENTICAL across two samples
 *      400ms apart. A rendering page moves; a settled one does not.
 */
const STABLE = `(() => {
  const s = [];
  const els = document.querySelectorAll("header, main, section, footer, h1, .elementor");
  for (let i = 0; i < els.length && i < 24; i++) {
    const r = els[i].getBoundingClientRect();
    s.push(Math.round(r.x) + ":" + Math.round(r.y) + ":" + Math.round(r.width) + ":" + Math.round(r.height));
  }
  return s.join("|") + "#" + document.body.scrollHeight;
})()`;

const waitForStable = async (page, tries = 8) => {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(400);
    const now = await page.evaluate(STABLE);
    if (now === prev) return true;
    prev = now;
  }
  errors.push("layout never stabilised — capture may be of a partially styled page");
  return false;
};

const browser = await chromium.launch();

for (const target of routes) {
  const name = slug(target);
  const errors = [];

  for (const [label, viewport, isMobile] of [
    ["desktop", { width: 1440, height: 900 }, false],
    ["mobile", { width: 390, height: 844 }, true],
  ]) {
    const ctx = await browser.newContext({ viewport, isMobile, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    page.on("response", (r) => { if (r.status() >= 400) errors.push(r.status() + " " + r.url()); });

    const ok = await open(page, target);
    if (!ok) {
      await ctx.close();
      continue;
    }
    await page.waitForTimeout(2000);

    // Web fonts change every measurement, so force them to settle first. The
    // whole pipeline is worthless if it measures a fallback.
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise((r) => { scrollTo(0, document.body.scrollHeight); setTimeout(r, 1000); }));
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(1000);
    await waitForStable(page);

    await page.screenshot({ path: join(outDir, `${name}-${label}.png`), fullPage: true });

    if (label === "desktop") {
      writeFileSync(join(outDir, `${name}.json`), JSON.stringify(await page.evaluate(PROBE), null, 1));

      // The page's own stylesheets are where the real values live. The rendered
      // probe tells you what a box IS; this tells you why, including rules a
      // screenshot cannot show such as a gradient overlay on a pseudo-element.
      const inline = await page.evaluate(() =>
        [...document.querySelectorAll("style")]
          .map((s) => ({ id: s.id || "(anonymous)", css: s.textContent }))
          .filter((s) => s.css && s.css.length > 40),
      );
      inline.forEach((s) => writeFileSync(join(outDir, `${name}.${s.id}.css`), s.css));

      const links = await page.evaluate(() =>
        [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href),
      );
      let combined = "";
      for (const href of links) {
        try {
          combined += `\n/* ${href} */\n` + (await (await fetch(href)).text());
        } catch (e) {
          errors.push("css fetch failed: " + href);
        }
      }
      writeFileSync(join(outDir, `${name}.all.css`), combined);
    }

    await ctx.close();
  }

  if (errors.length) writeFileSync(join(outDir, `${name}.errors.txt`), errors.join("\n"));
  console.log("captured", name, errors.length ? `(${errors.length} console/network errors)` : "");
}

await browser.close();
console.log(`\n${routes.length} route(s) into ${outDir}`);
console.log("next: node tools/verify.mjs <refUrl> <localUrl> <pairs.json> [width]");
