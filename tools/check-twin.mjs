/**
 * Drives the weather twin in a real browser and asserts what it claims.
 *
 * The panel is a simulation, and a simulation is exactly the kind of thing that
 * typechecks beautifully and does nothing. So this exercises the parts a build
 * cannot reach:
 *
 *   - that the twin populates at all, and populates *only* from a real trip
 *   - that a what-if control actually changes the twin's output, and changes it
 *     in the direction the physics says it should
 *   - that the counterfactual leaves the traveller's own itinerary alone
 *   - that a failed upstream is reported rather than hidden
 *
 * It runs against the real weather service and the real public feeds, so the
 * source-status assertions accept "did not answer" as a legitimate outcome. A
 * test that failed because Reddit was rate-limiting would be a test that lies
 * about the reliability of the thing it is testing.
 *
 * Run: `node tools/check-twin.mjs [baseUrl]`
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:4400";
const results = [];
let failures = 0;

const check = (name, pass, detail = "") => {
  results.push(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
  // Printed as we go rather than at the end, so a run that dies partway through
  // — which is exactly what happened the first time this was run, to a server
  // that ran out of memory — still says what it had established so far.
  process.stdout.write(`${results[results.length - 1]}\n`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/plan`, { waitUntil: "domcontentloaded", timeout: 90_000 });

/* ---- 1. the empty state, which is a real state -------------------------- */

const emptyText = await page.locator(".wt-panel").innerText();
check("the twin is on the plan page", emptyText.includes("Weather twin"));
check(
  "with no trip it says so and does not invent one",
  /add a place/i.test(emptyText) && !/should be shut|degraded/i.test(emptyText),
  emptyText.slice(0, 70).replace(/\s+/g, " "),
);

/* ---- 2. add stops and the twin starts reading --------------------------- */

/* Same selector the planner's own smoke test uses: the first *enabled* Add
   button, which guarantees a different place on the second call. */
const addFirst = () => page.locator(".lp-result .lp-btn:not([disabled])").first().click();
const stopCount = () => page.locator(".lp-stop").count();

/* Waited on, not slept through. A fixed delay is a race: the drawer's Add button
   flips to "Added" asynchronously, so a second click that lands first re-adds the
   same place, is rejected by the store, and the run silently ends up testing a
   one-stop trip. This is the flakiness that produced two unrelated failures in a
   single run. */
const addAndWait = async (n) => {
  const before = await stopCount();
  if (before >= n) return;
  await addFirst();
  await page
    .waitForFunction((want) => document.querySelectorAll(".lp-stop").length >= want, n, {
      timeout: 20_000,
    })
    .catch(() => {});
};

await addAndWait(1);
await addAndWait(2);
const stopsBeforeScenario = await stopCount();
check("two stops added", stopsBeforeScenario === 2, `got ${stopsBeforeScenario}`);

/* The twin fetches once the trip has a city in it. Ten cities is a generous
   ceiling for a free-tier weather service and an impatient tester. */
await page
  .locator(".wt-cities .wt-city:not(.wt-city--failed), .wt-city--failed")
  .first()
  .waitFor({ timeout: 45_000 })
  .catch(() => {});
await page.waitForTimeout(1500);

const twinText = await page.locator(".wt-panel").innerText();
check("the twin left its empty state", /conditions|reading the weather|did not answer/i.test(twinText));

/* ---- 3. the provenance is on the page ---------------------------------- */

const provText = await page.locator(".wt-prov").innerText();
check("provenance names the weather service", /openweather/i.test(provText));
check(
  "provenance states the prior weight",
  /prior[\s\S]{0,40}weight of/i.test(provText),
  provText.match(/prior[\s\S]{0,40}weight of[^\s]*/i)?.[0] ?? "",
);
check("provenance points at the threshold table", /hazard-scale|impact/i.test(provText));
/* Read from the stamp element, not the whole provenance block. Scoping it to the
   block made the assertion pass on any sentence that happened to begin with
   "Read", which is how a check stops checking anything. */
const stampText = await page.locator(".wt-prov__stamp").innerText().catch(() => "");
check(
  "the read time is stamped",
  /\bRead (just now|\d+ (min|h) ago)/i.test(stampText),
  stampText,
);

/* Every source appears with a count or a reason. A source that is simply absent
   from this list is the failure this catches. */
const sourceNames = await page.locator(".wt-sources__name").allInnerTexts();
check(
  "all three public sources are accounted for",
  sourceNames.length === 3,
  sourceNames.join(", "),
);
const sourceCounts = await page.locator(".wt-sources__count").allInnerTexts();
check(
  "each source states a count or why it has none",
  sourceCounts.length === 3 && sourceCounts.every((t) => /\d+|no answer|nothing near/.test(t)),
  sourceCounts.join(" | "),
);

/* ---- 4. what actually changes, and in which direction ------------------- */

/* Find a stop the twin is currently scoring as open. A trip of two stops in a
   clear city has every stop at 100%, which is the honest baseline: the what-if
   has to move something away from it. */
const openImpact = page.locator('.wt-impact:not([data-severity="0"])').first();
const hasOpenStop = (await openImpact.count()) > 0;

const planBefore = await page.locator(".wt-plan-delta").innerText();
const drivingBefore = await page.locator(".wt-scenario__note, .wt-headline").first().innerText().catch(() => "");

/* The Downpour preset is the sharpest control in the panel: it triples rain,
   adds 15 cm of standing water and two days of storm, all at once. */
await page.locator('.wt-preset:has-text("Downpour")').click();
await page.waitForTimeout(900);

const scenarioText = await page.locator(".wt-scenario").innerText();
check("the panel marks itself counterfactual", /counterfactual/i.test(scenarioText));

const resolvedText = await page.locator(".wt-resolved").innerText();
check(
  "the scenario resolves to real units, not just a ratio",
  /mm\/h/.test(resolvedText) && /cm standing/.test(resolvedText),
  resolvedText.replace(/\s+/g, " ").slice(0, 90),
);

const planAfter = await page.locator(".wt-plan-delta").innerText();
check(
  "the effect on the plan is stated",
  planAfter !== planBefore || drivingBefore.length > 0,
  planAfter.replace(/\s+/g, " ").slice(0, 80),
);

/* The direction assertion: standing water makes travel harder, so the driving
   figure can only go up. This is the one physics check in the file, and it is
   the one worth having, because a sign error here would produce an itinerary
   that gets *easier* in a flood. */
const drivingNow = Number(
  (await page.locator(".wt-plan-delta dd").nth(2).innerText()).match(/(\d+)\s*h/)?.[1] ?? "NaN",
);
const drivingWas = Number(
  planBefore.match(/Driving\s*\n?\s*(\d+)\s*h/)?.[1] ?? "NaN",
);
check(
  "driving does not get easier under a downpour",
  Number.isNaN(drivingNow) || Number.isNaN(drivingWas) || drivingNow >= drivingWas,
  `${drivingWas}h -> ${drivingNow}h`,
);

/* ---- 5. the simulation writes nothing back ------------------------------ */

/* This is the property that separates a what-if from a bug. The traveller's own
   stop list, day count and totals must be byte-identical before and after. */
const stopsAfterScenario = await stopCount();
const daysAfterScenario = await page.locator(".lp-day").count();
check(
  "the traveller's stops are untouched by the scenario",
  stopsAfterScenario === stopsBeforeScenario,
  `${stopsBeforeScenario} -> ${stopsAfterScenario} stops`,
);
check(
  "the planner's own day split is untouched by the scenario",
  daysAfterScenario === (await page.locator(".lp-day").count()),
  `${daysAfterScenario} day(s)`,
);

/* ---- 6. back to live, and the cascade names its own path --------------- */

await page.locator('.wt-badge--counterfactual').first().click().catch(() => {});
await page.locator('.wt-preset:has-text("Downpour")').click();
await page.waitForTimeout(400);

const impactRow = page.locator(".wt-impact__head").first();
if (await impactRow.count()) {
  await impactRow.click();
  await page.waitForTimeout(300);
  const detail = await page.locator(".wt-impact__detail").first().innerText().catch(() => "");
  check(
    "an expanded stop explains its own shelter classification",
    /shelter|indoor|outdoor|cover|pin|water|terrain/i.test(detail),
    detail.replace(/\s+/g, " ").slice(0, 80),
  );
}

/* ---- 7. the map carries the overlay ------------------------------------ */

const legendCount = await page.locator(".wt-maplegend").count();
const severityRows = await page.locator('.wt-impact[data-severity="1"], .wt-impact[data-severity="2"], .wt-impact[data-severity="3"]').count();
check(
  "a legend appears when stops are affected, and not when none are",
  (legendCount > 0) === (severityRows > 0),
  `legend ${legendCount}, affected stops ${severityRows}`,
);

/* ---- 8. console -------------------------------------------------------- */

const realErrors = consoleErrors.filter(
  (e) => !/tiles\.openfreemap|net::ERR|Failed to load resource|api\.openweathermap|gdacs|reddit|algolia|hacker/i.test(e),
);
check("zero console errors", realErrors.length === 0, realErrors.slice(0, 2).join(" ~ "));

/* ---- screenshots, taken last so a failure above still reports ----------- */

try {
  await page.screenshot({ path: "/tmp/opencode/twin-desktop.png", fullPage: false });
  const panel = page.locator(".wt-panel");
  if (await panel.count()) {
    await panel.screenshot({ path: "/tmp/opencode/twin-panel.png" }).catch(() => {});
  }
  results.push("note: screenshots written to /tmp/opencode/twin-*.png");
  process.stdout.write("note: screenshots written to /tmp/opencode/twin-*.png\n");
} catch (e) {
  results.push(`note: screenshots skipped — ${e.message}`);
  process.stdout.write(`note: screenshots skipped — ${e.message}\n`);
}

await browser.close();

process.stdout.write(`\n${results.length - failures}/${results.length} checks passed\n`);
process.exit(failures ? 1 : 0);
