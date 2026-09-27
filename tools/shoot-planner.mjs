/**
 * tools/shoot-planner.mjs — screenshot the planner in each of its states, and
 * check the dialog against the numbers tools/capture.mjs measured.
 *
 * This is the planner's stand-in for tools/verify.mjs, and it has to be a
 * different tool because verify.mjs cannot reach the thing it would be
 * comparing against. The planner UI lives behind two walls: /ui needs a click on
 * the "PLAN A TRIP" anchor before the dialog exists, and /trip -- the map -- is
 * behind a login, answering an anonymous request with the same 43KB shell as
 * /ui. verify.mjs does not click and has no session, so pointed at the live site
 * it measures the anonymous marketing page instead. That page is 76px tall where
 * the planner's chrome is 34px and it has no MY TRIPS tab at all, so a pairs file
 * for it reports differences that are not defects. Measured, then deleted.
 *
 * So: the dialog, which is reachable, is asserted here against the captured
 * boxes. The map, which is not reachable, is not asserted at all -- it is
 * screenshots and an honest note in app/planner.css.
 *
 * The behaviour section is the other half. A pixel-accurate dialog that steals
 * focus while you type is worse than a slightly wrong one, and no amount of
 * measuring boxes would have caught that.
 *
 *   node tools/shoot-planner.mjs [localUrl] [outDir]
 *
 * Exits 1 if any dialog box has drifted from the capture, if any behaviour check
 * fails, or if the page logged a console error, so it can gate a build the way
 * verify.mjs does.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:4310/social-impact";
const outDir = process.argv[3] ?? "/tmp/furkot-mine";
mkdirSync(outDir, { recursive: true });

/**
 * From tools/capture.mjs against https://trips.furkot.com/ui at 1440x900, after
 * clicking a.guest. The dialog is 750 wide and its content column is 750 minus
 * 2 x 9.8px of body padding, which is 730. The loop state is captured too: the
 * Mid point input occupies exactly the box the End point one did.
 */
const CAPTURED = {
  oneway: {
    dialog: [750, 509],
    title: [750, 40],
    start: [698, 28],
    endOrMid: [730, 28],
    tripName: [730, 31],
  },
  loop: {
    dialog: [750, 509],
    title: [750, 40],
    start: [698, 28],
    endOrMid: [730, 28],
    tripName: [730, 31],
  },
};

/**
 * Widths and the input and title heights are held to a pixel: they come straight
 * off the capture and there is no reason for them to move.
 *
 * The dialog's TOTAL height is held to 8px and no tighter, and the reason is
 * written down rather than buried in a tolerance number. The reference reaches
 * 509 by wrapping its own paragraphs, and it reaches it with a disabled DONE
 * button and no explanation of why. This build has one extra line -- the "Still
 * needed" note -- which is worth about 29px, and paragraphs that come out
 * correspondingly tighter, netting +4px. Closing that to the pixel would mean
 * either dropping the note, which is the more useful half of the pair, or
 * reproducing the reference's exact paragraph wrapping, which depends on its
 * font metrics rather than ours. So the total is reported, not asserted, and
 * app/planner.css records the same gap.
 */
const TOLERANCE = 1;
const TOTAL_HEIGHT_TOLERANCE = 8;

let failures = 0;
const assertBox = (label, got, want, tolerance = TOLERANCE) => {
  const okW = Math.abs(got[0] - want[0]) <= tolerance;
  const okH = Math.abs(got[1] - want[1]) <= tolerance;
  if (okW && okH) {
    console.log(`  ok   ${label} ${got[0]}x${got[1]}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label} got ${got[0]}x${got[1]}, captured ${want[0]}x${want[1]}`);
  }
};

const reportHeight = (label, got, want) => {
  const delta = got - want;
  const within = Math.abs(delta) <= TOTAL_HEIGHT_TOLERANCE;
  if (!within) failures += 1;
  console.log(
    `  ${within ? "ok  " : "FAIL"} ${label} ${got}px vs captured ${want}px (${delta > 0 ? "+" : ""}${delta}, ceiling ${TOTAL_HEIGHT_TOLERANCE})`,
  );
};

/** Reads the boxes the capture pinned down, in whichever loop state is showing. */
const readDialog = () => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  };
  const inputs = [...document.querySelectorAll(".fk-dialog input")];
  const byPlaceholder = (p) => {
    const el = inputs.find((i) => i.getAttribute("placeholder") === p);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  };
  return {
    dialog: box(".fk-dialog"),
    title: box(".fk-dialog__title"),
    start: byPlaceholder("Start point"),
    endOrMid: byPlaceholder("End point") ?? byPlaceholder("Mid point"),
    tripName: byPlaceholder("Trip name"),
    hasEnd: Boolean(inputs.find((i) => i.getAttribute("placeholder") === "End point")),
    hasMid: Boolean(inputs.find((i) => i.getAttribute("placeholder") === "Mid point")),
    wideParagraphs: [...document.querySelectorAll(".fk-dialog .fk-wide")].filter(
      (p) => getComputedStyle(p).display !== "none",
    ).length,
  };
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".fk-page", { timeout: 20000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${outDir}/01-idle.png` });

// The dialog, and then the loop swap -- the measured behaviour.
await page.click(".fk-ibtn[title='New trip']");
await page.waitForSelector(".fk-dialog", { timeout: 5000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/02-dialog-oneway.png` });

console.log("\ndialog vs capture, one-way (End point)");
const oneway = await page.evaluate(readDialog);
assertBox("title", oneway.title ?? [0, 0], CAPTURED.oneway.title);
assertBox("start", oneway.start ?? [0, 0], CAPTURED.oneway.start);
assertBox("endOrMid", oneway.endOrMid ?? [0, 0], CAPTURED.oneway.endOrMid);
assertBox("tripName", oneway.tripName ?? [0, 0], CAPTURED.oneway.tripName);
assertBox("dialog width", [oneway.dialog?.[0] ?? 0, 0], [CAPTURED.oneway.dialog[0], 0]);
reportHeight("dialog height", oneway.dialog?.[1] ?? 0, CAPTURED.oneway.dialog[1]);
if (oneway.hasEnd && !oneway.hasMid) console.log("  ok   one-way shows End point and no Mid point");
else {
  failures += 1;
  console.log(`  FAIL one-way inputs: hasEnd=${oneway.hasEnd} hasMid=${oneway.hasMid}`);
}

await page.click(".fk-dialog .fk-check input");
await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/03-dialog-loop.png` });

console.log("\ndialog vs capture, looped (Mid point)");
const loop = await page.evaluate(readDialog);
assertBox("title", loop.title ?? [0, 0], CAPTURED.loop.title);
assertBox("start", loop.start ?? [0, 0], CAPTURED.loop.start);
assertBox("endOrMid", loop.endOrMid ?? [0, 0], CAPTURED.loop.endOrMid);
assertBox("tripName", loop.tripName ?? [0, 0], CAPTURED.loop.tripName);
assertBox("dialog width", [loop.dialog?.[0] ?? 0, 0], [CAPTURED.loop.dialog[0], 0]);
reportHeight("dialog height", loop.dialog?.[1] ?? 0, CAPTURED.loop.dialog[1]);
if (loop.hasMid && !loop.hasEnd) console.log("  ok   loop swaps in Mid point and drops End point");
else {
  failures += 1;
  console.log(`  FAIL loop inputs: hasMid=${loop.hasMid} hasEnd=${loop.hasEnd}`);
}
// The swap is a swap, not an addition: the dialog must not have grown.
if (loop.dialog && oneway.dialog && loop.dialog[1] === oneway.dialog[1]) {
  console.log("  ok   looping does not change the dialog height");
} else {
  failures += 1;
  console.log(`  FAIL dialog height changed on loop: ${oneway.dialog?.[1]} -> ${loop.dialog?.[1]}`);
}

// Escape closes it and hands focus back to the thing that opened it.
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const afterClose = await page.evaluate(() => ({
  gone: !document.querySelector(".fk-dialog"),
  focusTag: document.activeElement?.tagName,
  focusTitle: document.activeElement?.getAttribute("title"),
}));
if (afterClose.gone) console.log("  ok   escape closes the dialog");
else {
  failures += 1;
  console.log("  FAIL escape did not close the dialog");
}
if (afterClose.focusTitle === "New trip") console.log("  ok   focus returns to the New trip button");
else {
  failures += 1;
  console.log(`  FAIL focus after close is on ${afterClose.focusTag} "${afterClose.focusTitle}"`);
}

/*
 * Focus management. aria-modal was a promise the dialog was not keeping: focus
 * stayed on the toolbar button behind it, so the first Tab escaped the dialog
 * entirely, and the effect that moved focus in had `onClose` -- an inline arrow
 * from the parent -- in its dependency list, so it re-ran on every keystroke and
 * yanked you out of whatever field you were typing in.
 */
await page.click(".fk-ibtn[title='New trip']");
await page.waitForSelector(".fk-dialog", { timeout: 5000 });
await page.waitForTimeout(400);
const focusOnOpen = await page.evaluate(() => {
  const d = document.querySelector(".fk-dialog");
  return { insideDialog: !!d?.contains(document.activeElement), tag: document.activeElement?.tagName };
});
if (focusOnOpen.insideDialog) console.log(`  ok   focus moves into the dialog (${focusOnOpen.tag})`);
else {
  failures += 1;
  console.log(`  FAIL focus was on ${focusOnOpen.tag}, outside the dialog`);
}

let escaped = false;
for (let i = 0; i < 20; i++) {
  await page.keyboard.press("Tab");
  const inside = await page.evaluate(
    () => !!document.querySelector(".fk-dialog")?.contains(document.activeElement),
  );
  if (!inside) {
    escaped = true;
    break;
  }
}
if (!escaped) console.log("  ok   tabbing 20 times stays inside the dialog");
else {
  failures += 1;
  console.log("  FAIL tab escaped the dialog");
}

// Type into the endpoint field, whichever one the loop state is currently
// showing. Hard-coding "End point" would be wrong: the assertions above left the
// loop ticked, so the reopened dialog is in its Mid point state. The point of the
// test is that focus is not stolen from a non-first field, and either field is
// non-first.
const endField = page
  .locator('.fk-dialog input[aria-label="End point"], .fk-dialog input[aria-label="Mid point"]')
  .first();
const endLabel = await endField.getAttribute("aria-label");
await endField.click();
await page.keyboard.type("Reykjavik", { delay: 40 });
await page.waitForTimeout(300);
const typed = await page.evaluate((label) => {
  const el = document.querySelector(`.fk-dialog input[aria-label="${label}"]`);
  return {
    value: el?.value ?? "",
    focusedLabel: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
  };
}, endLabel);
if (typed.value === "Reykjavik" && typed.focusedLabel === endLabel) {
  console.log(`  ok   typing in the ${endLabel} field keeps focus there and every character`);
} else {
  failures += 1;
  console.log(
    `  FAIL typing was interrupted in ${endLabel}: value="${typed.value}" focus="${typed.focusedLabel}"`,
  );
}
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Drop stops by clicking the map, then open the itinerary.
for (const [x, y] of [
  [560, 330],
  [700, 300],
  [860, 360],
  [980, 250],
]) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(250);
}
await page.click(".fk-tabs--left-wrap .fk-tab");
await page.waitForTimeout(700);
await page.screenshot({ path: `${outDir}/04-itinerary.png` });

// The finder and its filters.
await page.click(".fk-tabs:not(.fk-tabs--left-wrap) .fk-tab >> text=find");
await page.waitForTimeout(700);
await page.screenshot({ path: `${outDir}/05-finder.png` });

// A region filter applied.
await page.selectOption(".fk-panel select >> nth=0", "Europe");
await page.waitForTimeout(900);
await page.screenshot({ path: `${outDir}/06-filtered.png` });

// The plan tab with the daily limits.
await page.click(".fk-tabs:not(.fk-tabs--left-wrap) .fk-tab >> text=plan");
await page.waitForTimeout(500);
await page.locator(".fk-panel input[type=number]").first().fill("400");
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/07-daily-limit.png` });

// Mobile: the dialog is full-bleed and bottom-anchored, and every
// .wide-screen-only paragraph is gone, which is why it is so much shorter.
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  deviceScaleFactor: 1,
});
const mp = await mobile.newPage();
await mp.goto(BASE, { waitUntil: "domcontentloaded" });
await mp.waitForSelector(".fk-page", { timeout: 20000 });
await mp.waitForTimeout(3000);
await mp.click(".fk-ibtn[title='New trip']");
await mp.waitForTimeout(700);
await mp.screenshot({ path: `${outDir}/08-mobile-dialog.png` });

const mob = await mp.evaluate(readDialog);
console.log("\ndialog at 390 wide");
if (mob.wideParagraphs === 0) console.log("  ok   the wide-screen-only paragraphs are hidden");
else {
  failures += 1;
  console.log(`  FAIL ${mob.wideParagraphs} wide paragraphs still showing at 390`);
}
const mobH = await mp.evaluate(() =>
  Math.round(document.querySelector(".fk-dialog").getBoundingClientRect().height),
);
// The 327 the capture recorded was against a body that wrapped differently from
// ours, so the height is reported rather than asserted. The count above is the
// part that is a real behavioural rule rather than a number we inherited.
console.log(`  --   mobile dialog height ${mobH}px (capture recorded 327px)`);

console.log("\nbehaviour the fixes were for");
/*
 * The yellow hint used to fall back to 0,0 -- a real place in the Gulf of Guinea
 * -- when the pointer had never been over the map. Tested on a fresh load,
 * because by this point the pointer has been over the map many times and the
 * panel state decides whether the hint is showing at all.
 */
const fresh = await ctx.newPage();
await fresh.goto(BASE, { waitUntil: "domcontentloaded" });
await fresh.waitForSelector(".fk-page", { timeout: 20000 });
await fresh.waitForTimeout(3000);

if (!(await fresh.evaluate(() => !!document.querySelector(".fk-hint")))) {
  console.log("  ok   the add-stop hint is absent on a fresh load, before any pointer move");
} else {
  failures += 1;
  console.log("  FAIL the add-stop hint is showing with no cursor position");
}

await fresh.mouse.move(500, 400);
await fresh.waitForTimeout(400);
if (await fresh.evaluate(() => !!document.querySelector(".fk-hint"))) {
  console.log("  ok   the hint appears once the pointer is over the map");
} else {
  failures += 1;
  console.log("  FAIL the hint never appeared");
}

// And clicking it must drop a stop where the pointer is, not at the origin.
const before = await fresh.evaluate(() => document.querySelectorAll(".fk-pin").length);
await fresh.click(".fk-hint");
await fresh.waitForTimeout(500);
const dropped = await fresh.evaluate(() => {
  const pins = [...document.querySelectorAll(".fk-pin")];
  return { count: pins.length, lat: pins[0]?.getAttribute("title") };
});
const notNullIsland = dropped.lat && !/^0°00'00\.0"N 0°00'00\.0"E/.test(dropped.lat);
if (dropped.count === before + 1 && notNullIsland) {
  console.log(`  ok   the hint drops a stop at the pointer (${dropped.lat})`);
} else {
  failures += 1;
  console.log(`  FAIL hint drop: ${before} -> ${dropped.count} stops, at "${dropped.lat}"`);
}
await fresh.close();

// The LAL header and footer sit behind a fixed overlay. Hidden, not just
// covered: otherwise they stay in the tab order with nothing on screen.
const chrome = await page.evaluate(() => {
  const h = document.querySelector(".lal-header");
  const f = document.querySelector(".lal-footer");
  return {
    header: h ? getComputedStyle(h).display : "absent",
    footer: f ? getComputedStyle(f).display : "absent",
    focusableLinks: [...document.querySelectorAll(".lal-header a, .lal-footer a")].filter(
      (a) => a.offsetParent !== null,
    ).length,
  };
});
if (chrome.header === "none" && chrome.footer === "none" && chrome.focusableLinks === 0) {
  console.log("  ok   the site header and footer are display:none, so nothing focusable is left behind");
} else {
  failures += 1;
  console.log(
    `  FAIL chrome still focusable: header=${chrome.header} footer=${chrome.footer} links=${chrome.focusableLinks}`,
  );
}

// The three finder tabs claim different orderings. Check they really differ, so
// the copy cannot drift away from the behaviour again.
await page.click(".fk-tabs:not(.fk-tabs--left-wrap) .fk-tab >> text=find");
await page.waitForTimeout(500);
const findOrder = await page.evaluate(() =>
  [...document.querySelectorAll(".fk-result__name")].slice(0, 4).map((e) => e.textContent),
);
await page.click(".fk-tabs:not(.fk-tabs--left-wrap) .fk-tab >> text=eat");
await page.waitForTimeout(500);
const eatOrder = await page.evaluate(() =>
  [...document.querySelectorAll(".fk-result__name")].slice(0, 4).map((e) => e.textContent),
);
if (JSON.stringify(findOrder) !== JSON.stringify(eatOrder)) {
  console.log(`  ok   find and eat list differently (${findOrder[0]} vs ${eatOrder[0]})`);
} else {
  failures += 1;
  console.log(`  FAIL find and eat list identically: ${JSON.stringify(findOrder)}`);
}
const eatCopy = await page.evaluate(() => document.querySelector(".fk-count")?.textContent ?? "");
if (/by country/.test(eatCopy)) console.log("  ok   the eat tab's copy matches what it does");
else {
  failures += 1;
  console.log(`  FAIL eat copy does not mention its ordering: "${eatCopy}"`);
}

console.log("");
if (errors.length) {
  failures += errors.length;
  console.log("CONSOLE ERRORS:\n" + [...new Set(errors)].join("\n"));
} else {
  console.log("no console errors");
}
await browser.close();
console.log(failures === 0 ? "\nshoot-planner: PASS" : `\nshoot-planner: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
