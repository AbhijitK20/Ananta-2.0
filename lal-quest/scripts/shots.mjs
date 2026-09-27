/**
 * Screenshots the main screens, for a visual check without a browser open.
 *
 * Usage: node scripts/shots.mjs [outDir]
 * Requires a server already running on LQ_BASE (default :4311).
 */

import { mkdir } from "node:fs/promises";
import { chromium } from "../../research/lal-clone/node_modules/playwright/index.mjs";

const BASE = process.env.LQ_BASE ?? "http://localhost:4311";
const OUT = process.argv[2] ?? "/tmp/opencode/lq-shots";

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

/** Desktop and a phone, because the nav and the toast are the two things that
 *  have to survive being different widths. */
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

const PAGES = [
  { path: "/", name: "home" },
  { path: "/quests", name: "quests" },
  { path: "/cities", name: "cities" },
  { path: "/cities/lisbon", name: "city-lisbon" },
  { path: "/stamps", name: "stamps" },
  { path: "/nope", name: "not-found" },
];

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  for (const target of PAGES) {
    await page.goto(`${BASE}${target.path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${target.name}-${viewport.name}.png` });
  }

  // A played-in state, so the stamps and quests screens are not all zeros.
  //
  // The ids below are read out of the dataset rather than guessed. A wrong id
  // does not throw — it just silently drops the daily card and the stamps that
  // referenced it, which is a confusing way to lose a screenshot.
  await page.goto(BASE, { waitUntil: "networkidle" });
  const seeded = await page.evaluate(() => {
    const day = (n) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const iso = (n) => new Date(Date.now() - n * 86400000).toISOString();

    // Three real places, taken from the extracted dataset. A wrong id does not
    // throw here — it just silently drops the daily card and any stamps that
    // referenced it, which is a confusing way to lose a screenshot. The second
    // and third are both Lisbon, so its city ring is partially filled.
    const extra = ["lisbon/mercado-de-campo-de-ourique", "lisbon/cortico-netos"];

    const days = [0, 1, 2, 4, 5, 6, 8, 9, 11];
    const stamps = {};
    const dailyCounts = {};
    // A streak reaching back nine days, re-stamping the first place so the save
    // has the same shape a real one would.
    for (const n of days) {
      stamps["paris/artisans-du-monde"] = iso(n);
      dailyCounts[day(n)] = 1;
    }
    for (const id of extra) {
      stamps[id] = iso(3);
      dailyCounts[day(3)] = (dailyCounts[day(3)] ?? 0) + 1;
    }

    window.localStorage.setItem(
      "lal-quest/save/v1",
      JSON.stringify({
        version: 1,
        stamps,
        // Real quest ids, so the Claimed tab is not empty for the wrong reason.
        claimedQuests: ["warmup-first-stamp", "warmup-five"],
        unlocked: { "ach-first": iso(9), "ach-ten": iso(4) },
        activeDays: days.map(day),
        dailyCounts,
        dailiesDone: [day(0)],
        dailyPick: { day: day(0), placeId: "paris/artisans-du-monde" },
      }),
    );
    return Object.keys(stamps).length;
  });
  console.log(`  seeded ${seeded} stamps`);

  for (const target of PAGES) {
    await page.goto(`${BASE}${target.path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${target.name}-played-${viewport.name}.png` });
  }

  await context.close();
}

await browser.close();
console.log(`screenshots in ${OUT}`);
