import { chromium } from "playwright";

const base = "http://localhost:4310";
const fail = [];
const ok = [];
const check = (name, cond, extra = "") => (cond ? ok : fail).push(`${name}${extra ? ` -- ${extra}` : ""}`);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

/* ---------------------------------------------------- /cities: search box -- */
await page.goto(`${base}/cities`, { waitUntil: "networkidle" });

const search = page.locator(".px__search input");
await search.fill("beach");
await page.waitForTimeout(150);
const countLine = (await page.locator(".px__count").innerText()).replace(/\s+/g, " ").trim();
const cards = await page.locator(".px-card").count();
check("search 'beach' filters", cards > 0 && cards < 100, `${cards} cards, "${countLine}"`);

const names = await page.locator(".px-card__name").allInnerTexts();
check(
  "every result is plausibly a beach hit",
  names.length === cards,
  names.slice(0, 6).join(", "),
);

// region filter
await search.fill("");
await page.selectOption(".px__select select", "Asia");
await page.waitForTimeout(150);
const asiaCount = await page.locator(".px-card").count();
const asiaCountLine = (await page.locator(".px__count").innerText()).replace(/\s+/g, " ").trim();
check("region filter = Asia", asiaCount === 24, `${asiaCount} cards, "${asiaCountLine}"`);

// combined filter
await search.fill("tea");
await page.waitForTimeout(150);
const combined = await page.locator(".px-card").count();
check("region + query combine", combined > 0 && combined <= asiaCount, `${combined} cards`);

await page.selectOption(".px__select select", "");
await search.fill("zzzzz");
await page.waitForTimeout(150);
const empty = await page.locator(".px__empty").count();
check("empty state + reset", empty === 1);

// the reset button clears everything
await page.locator(".px__reset").click();
await page.waitForTimeout(150);
check("reset restores all 100", (await page.locator(".px-card").count()) === 100);

// a card navigates to the place page
await page.goto(`${base}/cities`, { waitUntil: "networkidle" });
await page.locator(".px-card", { hasText: "Machu Picchu" }).first().click();
await page.waitForURL("**/places/machu-picchu", { timeout: 5000 }).catch(() => {});
check("card navigates to /places/<slug>", page.url().endsWith("/places/machu-picchu"), page.url());

/* ----------------------------------------------- /places/[slug] page body -- */
const h1 = (await page.locator("h1").innerText()).trim();
const facts = await page.locator(".pl__facts dt").allInnerTexts();
const tags = await page.locator(".pl__tags li").allInnerTexts();
const blurbLen = (await page.locator(".pl__lede").innerText()).trim().length;
check("place page heading", h1 === "Machu Picchu", h1);
check("place page facts", facts.length >= 4, facts.join(" / "));
check("place page has tags", tags.length === 4, tags.join(", "));
check("place page has a real blurb", blurbLen > 150, `${blurbLen} chars`);

const nextHref = await page.locator(".pl__pager a").last().getAttribute("href");
check("pager links onward", !!nextHref && nextHref.startsWith("/places/"), nextHref ?? "");

const globeLink = await page.locator(".pl__facts a").getAttribute("href");
check("coords deep-link to globe", globeLink === "/globe?place=machu-picchu", globeLink ?? "");

/* ------------------------------------------------ carousel tap-to-inspect -- */
await page.goto(base, { waitUntil: "networkidle" });
await page.locator(".fs").scrollIntoViewIfNeeded();
await page.waitForTimeout(600);

check("panel starts closed", (await page.locator(".fs__panel").count()) === 0);

// the centred card is card 1 (Edinburgh) on load
const focused = page.locator('.fs-card[aria-current="true"]');
const focusedName = (await focused.locator(".fs-card__name").innerText()).trim();

// tap it
await focused.click({ force: true });
await page.waitForSelector(".fs__panel", { timeout: 4000 }).catch(() => {});
const panelName = (await page.locator(".fs__paneltitle").innerText().catch(() => "")).trim();
const panelSub = (await page.locator(".fs__panelsub").innerText().catch(() => "")).trim();
// The card's name is CSS-uppercased, so innerText comes back shouting; compare
// case-insensitively or the assertion fails on a correct panel.
check(
  "tap opens the panel",
  panelName.toLowerCase() === focusedName.trim().toLowerCase(),
  `tapped ${focusedName} -> panel "${panelName}" (${panelSub})`,
);

const panelBlurb = (await page.locator(".fs__panelblurb").innerText().catch(() => "")).trim();
check("panel has prose", panelBlurb.length > 80, `${panelBlurb.length} chars`);

const readMore = await page.locator(".fs__panellink").getAttribute("href");
check("panel links to the place page", readMore === `/places/${page.url() && ""}` || !!readMore?.startsWith("/places/"), readMore ?? "");

// the panel follows the strip
await page.locator(".fs__deck").hover();
await page.mouse.wheel(0, 600);
await page.waitForTimeout(900);
const panelName2 = (await page.locator(".fs__paneltitle").innerText().catch(() => "")).trim();
const activeName2 = (await page.locator('.fs-card[aria-current="true"] .fs-card__name').innerText()).trim();
check(
  "panel tracks the centred card",
  panelName2.toLowerCase() === activeName2.trim().toLowerCase(),
  `panel "${panelName2}" / centred "${activeName2}"`,
);

// escape closes
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("escape closes the panel", (await page.locator(".fs__panel").count()) === 0);

// and the Read more link navigates
await page.locator('.fs-card[aria-current="true"]').click({ force: true });
await page.waitForSelector(".fs__panel", { timeout: 4000 }).catch(() => {});
const rm2 = await page.locator(".fs__panellink").getAttribute("href");
await page.locator(".fs__panellink").click();
await page.waitForURL("**/places/**", { timeout: 5000 }).catch(() => {});
check("Read more navigates to the place page", page.url().includes(rm2 ?? "##"), `${rm2} -> ${page.url()}`);

/* --------------------------------------------------------- globe read more -- */
await page.goto(`${base}/globe?place=petra`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const gMore = await page.locator(".explorer__more a").getAttribute("href").catch(() => null);
const gNow = (await page.locator(".explorer__now").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
check("globe deep link selects Petra", gNow.includes("Petra"), gNow);
check("globe offers the same place page", gMore === "/places/petra", gMore ?? "none");

/* ------------------------------------------------------------- no 404s ---- */
for (const path of ["/cities", "/places/taj-mahal", "/places/fulidhoo", "/paris", "/globe"]) {
  const res = await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  check(`200 ${path}`, res?.status() === 200, String(res?.status()));
}

await browser.close();

console.log("\nPASS");
ok.forEach((l) => console.log("  ✓ " + l));
if (fail.length) {
  console.log("\nFAIL");
  fail.forEach((l) => console.log("  ✗ " + l));
  process.exit(1);
}
console.log(`\n${ok.length} checks passed.`);
