/**
 * Drives the built app in a real browser and asserts the game loop works.
 *
 * The unit checks in check.ts prove the rules are right. This proves the rules
 * are *reachable* — that a click on a stamp button moves the XP rail, fills the
 * ring, lights the streak chip and writes something to localStorage, and that a
 * reload comes back with the same numbers.
 *
 * Run against `npm start` on port 4311. Not part of the build: it needs a
 * running server and a browser, so it stays out of `next build` and CI's way.
 *
 * Usage: node scripts/smoke.mjs
 */

import { chromium } from "../../research/lal-clone/node_modules/playwright/index.mjs";

const BASE = process.env.LQ_BASE ?? "http://localhost:4311";

let failures = 0;
let checks = 0;

function ok(condition, label, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

/** Console errors and page exceptions, collected across the whole run. */
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

try {
  /* ---------------------------------------------------------------- home -- */

  console.log("\nhome");
  await page.goto(BASE, { waitUntil: "networkidle" });

  ok((await page.title()).includes("Local Legends"), "the page has a title");

  // A fresh profile must read as empty, not as a player with a wiped save.
  await page.waitForSelector(".lq-xp__num");
  ok(
    (await page.textContent(".lq-xp__num"))?.trim() === "0 XP",
    "a fresh profile starts at 0 XP",
    await page.textContent(".lq-xp__num"),
  );
  ok(
    (await page.textContent(".lq-streak__label"))?.trim() === "No streak",
    "and with no streak",
  );

  // The eyebrow is the album count once hydrated, not the quest count — the
  // quest count lives on /quests. Asserting on it here by accident was the
  // point: it proved the two pages report different facts under the same class.
  const eyebrow = await page.textContent(".lq-head__eyebrow");
  ok(/stamped/.test(eyebrow ?? ""), "the home eyebrow reports album progress", eyebrow ?? "");
  ok(
    /of 890/.test(eyebrow ?? ""),
    "and states the full album size",
    eyebrow ?? "",
  );

  /* ------------------------------------------------------------- stamping -- */

  console.log("\nstamping");
  const dailyButton = page.locator(".lq-daily .lq-btn").first();
  await dailyButton.click();

  // The toast is the reward receipt, so its presence is the assertion that a
  // stamp actually paid out.
  await page.waitForSelector(".lq-toast", { timeout: 5000 });
  const toast = (await page.textContent(".lq-toast")) ?? "";
  ok(toast.includes("Daily challenge"), "the toast names the daily reward", toast);
  ok(toast.includes("+15"), "and itemises the +15 daily bonus", toast);
  ok(toast.includes("+10"), "and the +10 base stamp", toast);
  ok(
    toast.includes("Achievement:") || toast.includes("achievements"),
    "and reports the achievements the stamp earned",
    toast,
  );

  ok((await page.textContent(".lq-xp__num"))?.trim() === "25 XP", "XP is 25 after one daily stamp");
  // The number the toast promised (+10 stamp, +15 daily) has to be the number
  // the rail shows. These drifted by 15 the first time this was run, because
  // the daily bonus was reported in the toast but absent from the derivation.
  const toastTotal = [10, 15].reduce((sum, xp) => sum + xp, 0);
  ok(
    (await page.textContent(".lq-xp__num"))?.trim() === `${toastTotal} XP`,
    "the XP total equals the sum the toast itemised",
  );

  const saveNow = JSON.parse(
    (await page.evaluate(() => window.localStorage.getItem("lal-quest/save/v1"))) ?? "{}",
  );
  ok(
    Array.isArray(saveNow.dailiesDone) && saveNow.dailiesDone.length === 1,
    "the completed daily is recorded so its bonus survives a reload",
    JSON.stringify(saveNow.dailiesDone),
  );

  const levelTitle = (await page.textContent(".lq-xp__title"))?.trim();
  ok(levelTitle === "Tourist", "level 1 is Tourist", String(levelTitle));

  const streak = (await page.textContent(".lq-streak__n"))?.trim();
  ok(streak === "1", "the streak chip reads 1", String(streak));
  ok(
    (await page.textContent(".lq-streak__label"))?.trim() === "Day streak",
    "and is not 'at risk' on the day it was earned",
  );

  // Once the day's place is stamped the card stops offering the button and
  // shows what was collected instead. Asserting on the button surviving would
  // be asserting a control the player no longer needs.
  ok(
    (await page.locator(".lq-daily .lq-btn").count()) === 0,
    "the daily button is withdrawn once the day is done",
  );
  const dailyReward = (await page.textContent(".lq-daily__reward")) ?? "";
  ok(dailyReward.includes("collected"), "and the card states what was collected", dailyReward);
  ok(
    await page.locator(".lq-daily--done").count() === 1,
    "the daily card switches to its done state",
  );

  // XP must actually be written, not just held in React state.
  const stored = await page.evaluate(() => window.localStorage.getItem("lal-quest/save/v1"));
  ok(stored !== null, "a save was written to localStorage");
  const save = JSON.parse(stored ?? "{}");
  ok(Object.keys(save.stamps ?? {}).length === 1, "it contains exactly one stamp");
  ok(
    Array.isArray(save.activeDays) && save.activeDays.length === 1,
    "and one active day",
    JSON.stringify(save.activeDays),
  );
  ok(save.dailyPick?.day != null, "and the day’s pick is recorded");

  /* -------------------------------------------------------------- reload -- */

  console.log("\nreload");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".lq-xp__num");

  ok(
    (await page.textContent(".lq-xp__num"))?.trim() === "25 XP",
    "XP survives a reload — the save was read back, not just held",
  );
  ok(
    await page.locator(".lq-daily--done").count() === 1,
    "and the daily card is still done",
  );

  /* ------------------------------------------------------------- unstamp -- */

  console.log("\nunstamp");
  // Undoing the day's place must take the bonus back with it, or a player could
  // farm 15 XP a day by stamping and unstamping. Go via the city page, because
  // the daily card deliberately withdraws its button once the day is done and
  // so cannot be used to undo itself.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  ok(
    (await page.textContent(".lq-xp__num"))?.trim() === "25 XP",
    "XP is still 25 after the reload",
  );

  const dailyPlaceHref = await page.getAttribute(".lq-daily__name a", "href");
  ok(dailyPlaceHref?.startsWith("/place/") === true, "the daily card links to its place", dailyPlaceHref ?? "");

  await page.goto(`${BASE}${dailyPlaceHref}`, { waitUntil: "networkidle" });
  await page.locator(".lq-place__actions .lq-btn").click();
  await page.waitForTimeout(300);
  ok(
    (await page.textContent(".lq-xp__num"))?.trim() === "0 XP",
    "unstamping the daily returns the bonus",
    await page.textContent(".lq-xp__num"),
  );
  ok(
    (await page.textContent(".lq-streak__n"))?.trim() === "0",
    "and breaks the streak, since the day has nothing left in it",
  );

  // Put it back so the rest of the run continues from a played state.
  await page.locator(".lq-place__actions .lq-btn").click();
  await page.waitForTimeout(300);
  ok(
    (await page.textContent(".lq-xp__num"))?.trim() === "25 XP",
    "and stamping it again restores both",
  );
  ok((await page.textContent(".lq-streak__n"))?.trim() === "1", "including the streak");

  /* -------------------------------------------------------------- quests -- */

  console.log("\nquests");
  await page.goto(`${BASE}/quests`, { waitUntil: "networkidle" });

  // The board opens on "In progress", which by design excludes claimable and
  // claimed quests — so the Ready tab has to be opened before looking for them.
  await page.locator("button", { hasText: "Ready" }).click();
  await page.waitForTimeout(200);
  const claimable = page.locator(".lq-quest--claimable");
  ok((await claimable.count()) > 0, "at least one quest became claimable");

  // Captured *before* the click. A Playwright locator is live, so reading
  // `.count()` again at assertion time returns the post-click number and the
  // comparison silently becomes "0 -> 0", which passes for the wrong reason.
  const readyBefore = await claimable.count();

  const before = (await page.textContent(".lq-xp__num"))?.trim();
  await claimable.first().locator("button").click();
  await page.waitForTimeout(300);
  const after = (await page.textContent(".lq-xp__num"))?.trim();
  ok(before !== after, `claiming changes the XP total (${before} -> ${after})`);

  // Claiming must be one-shot. Re-deriving "is this claimable" from progress
  // instead of from the claim list would let a reload pay it again.
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("button", { hasText: "Ready" }).click();
  await page.waitForTimeout(200);
  const readyAfterReload = await page.locator(".lq-quest--claimable").count();
  ok(
    readyAfterReload === readyBefore - 1,
    `a claimed quest stays claimed after a reload (${readyBefore} -> ${readyAfterReload} ready)`,
  );

  await page.locator("button", { hasText: "Claimed" }).click();
  await page.waitForTimeout(200);
  ok(
    (await page.locator(".lq-quest--claimed").count()) > 0,
    "and it appears under the Claimed tab",
  );

  /* -------------------------------------------------------------- cities -- */

  console.log("\ncities");
  await page.goto(`${BASE}/cities`, { waitUntil: "networkidle" });
  const cityRows = await page.locator(".lq-city").count();
  ok(cityRows === 202, `all 202 cities are listed (saw ${cityRows})`);

  await page.fill("#lq-city-q", "lisbon");
  await page.waitForTimeout(200);
  ok(
    (await page.locator(".lq-city").count()) === 1,
    "search narrows the list to Lisbon",
  );
  ok(
    ((await page.textContent(".lq-city__name")) ?? "").includes("Lisbon"),
    "and it is the right Lisbon",
  );

  /* ----------------------------------------------------------- city page -- */

  console.log("\ncity page");
  await page.goto(`${BASE}/cities/lisbon`, { waitUntil: "networkidle" });
  const lisbonCards = await page.locator(".lq-stamp").count();
  ok(lisbonCards === 14, `Lisbon has 14 places (saw ${lisbonCards})`);
  ok((await page.textContent(".lq-head__title"))?.trim() === "Lisbon", "and the right name");

  // Stamp all 14 and the city should clear, which pays the city bonus and
  // flips the row green. This is the one interaction that exercises the
  // derived-city-bonus path.
  const xpBefore = Number((await page.textContent(".lq-xp__num"))?.replace(/[^\d]/g, "") ?? 0);
  const buttons = page.locator(".lq-stamp .lq-btn");
  const count = await buttons.count();
  for (let i = 0; i < count; i += 1) await buttons.nth(i).click();
  await page.waitForTimeout(400);

  const xpAfter = Number((await page.textContent(".lq-xp__num"))?.replace(/[^\d]/g, "") ?? 0);
  ok(xpAfter > xpBefore, `stamping the rest of Lisbon raises XP (${xpBefore} -> ${xpAfter})`);
  ok(
    ((await page.textContent(".lq-head__sub")) ?? "").includes("cleared"),
    "and the header reports the city cleared",
  );

  /* -------------------------------------------------------------- stamps -- */

  console.log("\nstamps");
  await page.goto(`${BASE}/stamps`, { waitUntil: "networkidle" });
  ok(
    ((await page.textContent(".lq-head__title")) ?? "").includes("stamped"),
    "the album counts what was collected",
  );

  await page.locator("button", { hasText: "Badges" }).click();
  await page.waitForTimeout(200);
  const earnedBadges = await page.locator(".lq-ach--on").count();
  ok(earnedBadges > 0, `badges are earned (${earnedBadges} on)`);

  await page.locator("button", { hasText: "Categories" }).click();
  await page.waitForTimeout(200);
  // Scoped to the grid, because the page header carries its own ring for album
  // completion. Counting `.lq-ring` globally finds that one too.
  const categoryRows = await page.locator(".lq-grid > .lq-card").count();
  ok(categoryRows === 8, `all eight category rows are shown, unfiled included (saw ${categoryRows})`);
  const unfiledRow = await page.locator(".lq-grid > .lq-card", { hasText: "Unfiled" }).count();
  ok(unfiledRow === 1, "and Unfiled has its own row rather than being folded away");

  await page.locator("button", { hasText: "Levels" }).click();
  await page.waitForTimeout(200);
  ok((await page.locator(".lq-card").count()) >= 10, "all ten levels are listed");

  /* --------------------------------------------------------------- reset -- */

  console.log("\nreset");
  await page.locator("button", { hasText: "Reset the album" }).click();
  await page.waitForSelector("button", { hasText: "Yes, erase" });
  await page.locator("button", { hasText: "Yes, erase" }).click();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".lq-xp__num");
  ok(
    (await page.textContent(".lq-xp__num"))?.trim() === "0 XP",
    "reset clears the save and it stays cleared after a reload",
  );

  /* ------------------------------------------------------------- console -- */

  console.log("\nconsole");
  // Hydration mismatches and render crashes both surface here and nowhere else.
  const real = errors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
  ok(real.length === 0, "no console errors or page exceptions", real.join(" | "));
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
