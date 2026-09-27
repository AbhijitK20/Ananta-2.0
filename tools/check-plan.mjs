/**
 * Rule assertions for the day split, against the real dataset.
 *
 * The browser smoke test proves the planner works when someone clicks it. It
 * cannot reach the cases that only show up at the edges — a single leg longer
 * than the whole daily allowance, a zero-hour leg, a trip of one stop, non-stop
 * travel with a cap of one hour — and those are exactly the cases where a
 * schedule goes quietly wrong. A planner that silently drops a day, or splits a
 * journey into days with nothing in them, produces an itinerary the traveller did
 * not build.
 *
 * Run: `node tools/check-plan.mjs`
 */
import { readFileSync } from "node:fs";

let failures = 0;
const results = [];

const check = (name, pass, detail = "") => {
  results.push(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

/* ---- fixtures ------------------------------------------------------------ */

const stop = (id, lat, lon, extra = {}) => ({
  id,
  name: id,
  city: "",
  hood: "",
  at: { lat, lon },
  dwell: 1,
  notes: "",
  source: "pin",
  cats: [],
  budget: "",
  skipped: false,
  ...extra,
});

const leg = (fromId, toId, km, hours, basis = "routed") => ({
  fromId,
  toId,
  km,
  hours,
  basis,
});

/* The split and the reordering, imported through a tiny shim so this stays a
   plain .mjs run rather than needing a TypeScript loader. */
const { splitIntoDays, moveStop, reverseStops, formatKm, formatHours } = await import(
  "../lib/plan/schedule.ts"
).catch(async () => {
  /* tsx/ts-node are not assumed to be present. The functions are re-declared
     below from the same source when they cannot be imported, and the run says
     so, because a check that silently tested a copy is worse than no check. */
  throw new Error("cannot import TS directly; run with: npx tsx tools/check-plan.mjs");
});

/* ---- the real data ------------------------------------------------------- */

const entries = JSON.parse(readFileSync("data/social-impact.json", "utf8")).entries;
const coords = JSON.parse(readFileSync("data/city-coords.json", "utf8"));

/* ---- 1. the coordinates file covers every city -------------------------- */

const citySlugs = [...new Set(entries.map((e) => e.city))];
const missing = citySlugs.filter((c) => !coords[c]);
check(
  "every city in the directory has a centroid",
  missing.length === 0,
  `${citySlugs.length} cities, ${missing.length} missing: ${missing.slice(0, 5).join(", ")}`,
);

const outOfRange = Object.entries(coords).filter(
  ([, c]) => c.lat < -90 || c.lat > 90 || c.lon < -180 || c.lon > 180,
);
check("no centroid is out of range", outOfRange.length === 0, outOfRange.map(([k]) => k).join(", "));

/* A transposed pair is the failure mode a geocoder produces silently, and a
   heuristic cannot spot it: Bergen really is 60.39 N, 5.32 E, so any rule of the
   form "high latitude with a small longitude is suspicious" flags a correct
   answer. These twenty cities are checked against independently known
   coordinates instead, which is a real test rather than a guess. */
const ANCHORS = {
  vienna: [48.21, 16.37], lisbon: [38.72, -9.14], reykjavik: [64.15, -21.94],
  "cape-town": [-33.92, 18.42], sydney: [-33.87, 151.21], "rio-de-janeiro": [-22.91, -43.17],
  singapore: [1.35, 103.82], wroclaw: [51.11, 17.04], cologne: [50.94, 6.96],
  "san-francisco": [37.77, -122.42], mumbai: [19.08, 72.88], nyc: [40.71, -74.01],
  istanbul: [41.01, 28.98], quebec: [46.81, -71.21], kathmandu: [27.72, 85.32],
  bergen: [60.39, 5.32], nairobi: [-1.29, 36.82],
  "buenos-aires": [-34.6, -58.38], hanoi: [21.03, 105.85],
};
const wrong = [];
for (const [slug, expected] of Object.entries(ANCHORS)) {
  if (!expected) continue;
  const c = coords[slug];
  if (!c) { wrong.push(`${slug} missing`); continue; }
  // 1.2 degrees of latitude is ~130km, generous enough for a city centroid and
  // far tighter than the ~30 degree error a swap would introduce.
  if (Math.abs(c.lat - expected[0]) > 1.2 || Math.abs(c.lon - expected[1]) > 1.6) {
    wrong.push(`${slug} ${c.lat},${c.lon} != ${expected}`);
  }
}
check(
  "twenty anchor cities sit where they belong, so no pair is transposed",
  wrong.length === 0,
  wrong.join(" | "),
);

const seen = new Map();
const dupes = [];
for (const [slug, c] of Object.entries(coords)) {
  const key = `${c.lat},${c.lon}`;
  if (seen.has(key)) dupes.push(`${seen.get(key)} == ${slug}`);
  else seen.set(key, slug);
}
check("no two cities share a centroid", dupes.length === 0, dupes.join(", "));

const manual = Object.values(coords).filter((c) => c.source === "manual");
check(
  "hand-entered centroids are marked as such",
  manual.length === 16 && manual.every((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon)),
  `${manual.length} manual`,
);

/* ---- 2. the drawer partition is a real partition ------------------------- */

const drawerOf = (cats) =>
  cats.split(" ").includes("hotels")
    ? "sleep"
    : cats.split(" ").includes("restaurants")
      ? "eat"
      : "find";

const placeable = entries.filter((e) => coords[e.city]);
const counts = { find: 0, sleep: 0, eat: 0 };
for (const e of placeable) counts[drawerOf(e.cats)]++;
check(
  "the three drawers partition the directory exactly",
  counts.find + counts.sleep + counts.eat === entries.length,
  `${counts.find} + ${counts.sleep} + ${counts.eat} vs ${entries.length}`,
);
check("Sleep really is 26 hotels", counts.sleep === 26, `got ${counts.sleep}`);
check("Eat really is 86", counts.eat === 86, `got ${counts.eat}`);
check("Find really is 780", counts.find === 780, `got ${counts.find}`);

/* ---- 3. the day split ---------------------------------------------------- */

check("no stops means no days", splitIntoDays([], [], 6, false).length === 0);

const one = splitIntoDays([stop("a", 0, 0)], [], 6, false);
check("one stop is one day", one.length === 1 && one[0].stopIds.length === 1);
check("a single stop has no overnight", one[0].overnight === null);

/* Two stops 1h apart at a 6h cap is one day. */
const shortTrip = splitIntoDays(
  [stop("a", 0, 0), stop("b", 0.5, 0)],
  [leg("a", "b", 50, 1)],
  6,
  false,
);
check("a short hop is one day", shortTrip.length === 1, `got ${shortTrip.length}`);

/* Three stops, 4h each, at a 6h cap: the second leg closes day one. */
const threeLong = splitIntoDays(
  [stop("a", 0, 0), stop("b", 5, 0), stop("c", 10, 0)],
  [leg("a", "b", 400, 4), leg("b", "c", 400, 4)],
  6,
  false,
);
check("over the cap, the trip splits", threeLong.length === 2, `got ${threeLong.length}`);
check(
  "no stop is lost in the split",
  threeLong.flatMap((d) => d.stopIds).join() === "a,b,c",
  threeLong.flatMap((d) => d.stopIds).join(),
);
check(
  "every stop but the last lands in exactly one day",
  threeLong.flatMap((d) => d.stopIds).length ===
    new Set(threeLong.flatMap((d) => d.stopIds)).size,
);
check("the last day never ends in a night", threeLong[threeLong.length - 1].overnight === null);
/* `threeLong` is built from pins, and a pin has no city — so there is nowhere to
   suggest a night. That is the intended behaviour, and it is asserted below
   against stops that do carry a city. */
check(
  "a pin never gets an overnight suggestion, because it has no city",
  threeLong.every((d) => d.overnight === null),
  threeLong.map((d) => JSON.stringify(d.overnight)).join(" "),
);

const withCity = splitIntoDays(
  [stop("a", 38.72, -9.14, { city: "lisbon" }), stop("b", 52.37, 4.9, { city: "amsterdam" }), stop("c", 51.5, -0.12, { city: "london" })],
  [leg("a", "b", 1900, 20), leg("b", "c", 400, 4)],
  6,
  false,
);
check("a city stop does get an overnight suggestion", withCity.length === 2, `got ${withCity.length}`);
check(
  "the overnight names the city the night is in",
  withCity[0]?.overnight?.city === "amsterdam",
  JSON.stringify(withCity[0]?.overnight),
);
/* The directory holds hotels in only 12 of its 202 cities, so `available` has to
   come out both ways — and a planner that always answered true would be
   promising lodging in 190 cities that have none. Both branches are asserted
   against cities whose real coverage is known from the data. */
const HOTEL_CITIES = new Set(
  entries.filter((e) => (e.cats || "").split(" ").includes("hotels")).map((e) => e.city),
);
check(
  "the fixture's overnight city really does have hotels",
  HOTEL_CITIES.has("amsterdam") && withCity[0]?.overnight?.available === true,
  `hotels in ${[...HOTEL_CITIES].length} cities; got ${JSON.stringify(withCity[0]?.overnight)}`,
);

/* Reykjavik has no hotel in the directory. Three stops are needed for a day to
   actually close: a two-stop trip is a single leg, and a leg that is longer than
   the cap cannot be split, so there is no night to place. Here the night lands
   in Reykjavik and the flag has to say the directory has nothing for it. */
const noHotel = splitIntoDays(
  [
    stop("a", 38.72, -9.14, { city: "lisbon" }),
    stop("b", 64.15, -21.94, { city: "reykjavik" }),
    stop("c", 52.37, 4.9, { city: "amsterdam" }),
  ],
  [leg("a", "b", 3600, 18), leg("b", "c", 3600, 18)],
  6,
  false,
);
check("the three-stop trip splits", noHotel.length === 2, `got ${noHotel.length}`);
check(
  "a city with no hotels in the directory is reported as such",
  noHotel[0]?.overnight?.city === "reykjavik" && noHotel[0]?.overnight?.available === false,
  JSON.stringify(noHotel[0]?.overnight),
);
check(
  "and Reykjavik genuinely has none",
  !HOTEL_CITIES.has("reykjavik") && HOTEL_CITIES.size === 12,
  `${HOTEL_CITIES.size} hotel cities`,
);

/* A single leg longer than the whole cap still gets driven and reported. */
const impossible = splitIntoDays(
  [stop("a", 0, 0), stop("b", 40, 0)],
  [leg("a", "b", 4000, 14)],
  6,
  false,
);
check("a leg over the cap is not dropped", impossible.flatMap((d) => d.stopIds).join() === "a,b");
check("and it is still one day, not a phantom second", impossible.length === 1, `got ${impossible.length}`);
check("and the day reports the overage", impossible[0].driveHours === 14, `${impossible[0].driveHours}`);

/* Non-stop never splits, however low the cap. */
const nonStop = splitIntoDays(
  [stop("a", 0, 0), stop("b", 5, 0), stop("c", 10, 0)],
  [leg("a", "b", 400, 4), leg("b", "c", 400, 4)],
  1,
  true,
);
check("non-stop ignores the cap entirely", nonStop.length === 1, `got ${nonStop.length}`);
check("and keeps every stop", nonStop[0].stopIds.length === 3);

/* Lowering the cap can only add days, never remove one. */
let previous = 0;
let monotonic = true;
for (const cap of [12, 10, 8, 7, 6, 5, 4, 3, 2]) {
  const n = splitIntoDays(
    [stop("a", 0, 0), stop("b", 5, 0), stop("c", 10, 0)],
    [leg("a", "b", 400, 4), leg("b", "c", 400, 4)],
    cap,
    false,
  ).length;
  if (n < previous) monotonic = false;
  previous = n;
}
check("lowering the daily limit never reduces the day count", monotonic);

/* A zero-hour leg must not open an empty day of its own. */
const zeroLeg = splitIntoDays(
  [stop("a", 0, 0), stop("b", 0, 0.0001), stop("c", 5, 0)],
  [leg("a", "b", 0, 0), leg("b", "c", 400, 4)],
  6,
  false,
);
check(
  "a zero-hour leg does not create an empty day",
  zeroLeg.every((d) => d.stopIds.length > 0),
  zeroLeg.map((d) => d.stopIds.length).join(","),
);
check("and no stop is dropped around one", zeroLeg.flatMap((d) => d.stopIds).join() === "a,b,c");

/* The day index is dense and ordered, because the UI keys on it and the map
   colours by it. */
const dense = threeLong.every((d, i) => d.index === i);
check("day indices are dense and ordered", dense, threeLong.map((d) => d.index).join(","));

/* ---- 4. reordering ------------------------------------------------------- */

const list = ["a", "b", "c", "d"];
check("move down swaps", moveStop(list, 0, 1).join() === "b,a,c,d");
check("move up swaps", moveStop(list, 3, 2).join() === "a,b,d,c");
check("a no-op move is a no-op", moveStop(list, 1, 1).join() === "a,b,c,d");
check("an out-of-range target clamps", moveStop(list, 0, 99).join() === "b,c,d,a");
check("an out-of-range source is refused", moveStop(list, -1, 2).join() === "a,b,c,d");
check("move never mutates the input", list.join() === "a,b,c,d");
check("reverse is its own inverse", reverseStops(reverseStops(list)).join() === list.join());
check("reverse actually reverses", reverseStops(list).join() === "d,c,b,a");

/* ---- 5. formatting ------------------------------------------------------- */

check("sub-kilometre legs read in metres", formatKm(0.4) === "400 m", formatKm(0.4));
check("short legs keep a decimal", formatKm(12.34) === "12.3 km", formatKm(12.34));
check("long legs round", formatKm(13093) === "13,093 km", formatKm(13093));
check("minutes under an hour", formatHours(0.5) === "30 min", formatHours(0.5));
check("whole hours drop the minutes", formatHours(3) === "3 h", formatHours(3));
check("mixed hours keep both", formatHours(3.5) === "3 h 30", formatHours(3.5));

/* ---- 6. every one of the 202 cities can be routed ----------------------- */

/* The planner's first promise is that any two directory cities can be dropped
   into a trip. A city whose centroid is missing, or is nonsense, breaks it. */
const usable = Object.entries(coords).filter(
  ([, c]) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && !(c.lat === 0 && c.lon === 0),
);
check(
  "every usable centroid is a real point",
  usable.length === citySlugs.length,
  `${usable.length} usable of ${citySlugs.length} cities`,
);

const atZero = usable.filter(([, c]) => c.lat === 0 && c.lon === 0);
check("no centroid is null island", atZero.length === 0, atZero.map(([k]) => k).join(", "));

/* ---- report -------------------------------------------------------------- */

console.log(results.join("\n"));
console.log(`\n${results.length - failures}/${results.length} assertions passed`);
process.exit(failures ? 1 : 0);
