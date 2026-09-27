/**
 * tools/check-trip.mjs — the one runnable check for the planner's logic.
 *
 * The clone has no test runner and this is reference material, so rather than
 * add vitest to a project that has none, this asserts the parts that are easy to
 * get quietly wrong: the drag reorder, the loop/end-point swap, the filter, the
 * daily-limit split, the finder ordering and the scale bar. Everything it imports
 * is pure.
 *
 * Node strips the types off lib/trip.ts on import, so nothing is installed. That
 * only works because lib/trip.ts imports nothing itself, which is a constraint
 * worth keeping: the moment it reaches for the place catalogue, this check needs
 * a bundler and stops being free.
 *
 *   node tools/check-trip.mjs
 */
import assert from "node:assert/strict";

import {
  addStop,
  dayCount,
  endpointFieldFor,
  endpointHintFor,
  endpointPlaceholderFor,
  filterPlaces,
  formatDms,
  haversineKm,
  moveStop,
  nudgeStop,
  orderPlaces,
  planDays,
  removeStop,
  routeCoordinates,
  routeLength,
  scaleBarFor,
  stopAt,
  trimToDays,
  tripReadiness,
  updateStop,
} from "../lib/trip.ts";

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const LONDON = stopAt("London", 51.5074, -0.1278);
const PARIS = stopAt("Paris", 48.8566, 2.3522);
const BERLIN = stopAt("Berlin", 52.52, 13.405);
const TRIP = [LONDON, PARIS, BERLIN];

console.log("moveStop");

check("moves a stop down and reports the gap it landed in", () => {
  const r = moveStop(TRIP, 0, 2);
  assert.deepEqual(r.items.map((s) => s.name), ["Paris", "Berlin", "London"]);
  assert.equal(r.from, 0);
  assert.equal(r.to, 2);
  assert.equal(r.moved, true);
});

check("moves a stop up", () => {
  assert.deepEqual(
    moveStop(TRIP, 2, 0).items.map((s) => s.name),
    ["Berlin", "London", "Paris"],
  );
});

check("parks a drag past the last row at the last row", () => {
  const r = moveStop(TRIP, 0, 99);
  assert.deepEqual(r.items.map((s) => s.name), ["Paris", "Berlin", "London"]);
  assert.equal(r.to, 2, "clamped to the last index, not 99");
});

check("clamps a negative drag to the first row", () => {
  const r = moveStop(TRIP, 2, -5);
  assert.deepEqual(r.items.map((s) => s.name), ["Berlin", "London", "Paris"]);
  assert.equal(r.to, 0);
});

check("is a no-op on a same-index drag and on a short list", () => {
  assert.equal(moveStop(TRIP, 1, 1).moved, false);
  assert.equal(moveStop([LONDON], 0, 0).moved, false);
  assert.equal(moveStop([], 0, 0).moved, false);
});

check("nudge is moveStop by one, and stops at the edges", () => {
  assert.deepEqual(nudgeStop(TRIP, 0, -1).map((s) => s.name), ["London", "Paris", "Berlin"]);
  assert.deepEqual(nudgeStop(TRIP, 2, 1).map((s) => s.name), ["London", "Paris", "Berlin"]);
  assert.deepEqual(nudgeStop(TRIP, 0, 1).map((s) => s.name), ["Paris", "London", "Berlin"]);
});

check("does not mutate the input", () => {
  const before = TRIP.map((s) => s.name);
  moveStop(TRIP, 0, 2);
  assert.deepEqual(TRIP.map((s) => s.name), before);
});

console.log("loop / drop-and-pickup");

check("a loop swaps the End point input for a Mid point one", () => {
  // Furkot's own class for the one-way input is `last`; this module calls the
  // field `end`, and endpointFieldFor is the single place that maps between them.
  assert.equal(endpointFieldFor(false), "end");
  assert.equal(endpointFieldFor(true), "mid");
  assert.equal(endpointPlaceholderFor(false), "End point");
  assert.equal(endpointPlaceholderFor(true), "Mid point");
  assert.match(endpointHintFor(true), /half way down the road/);
  assert.match(endpointHintFor(false), /where the trip ends/);
});

check("a loop closes the route line back on the first stop", () => {
  const open = routeCoordinates(TRIP, false);
  assert.equal(open.length, 3);
  assert.equal(closesOn(TRIP, false), false);

  const loop = routeCoordinates(TRIP, true);
  assert.equal(loop.length, 4, "three stops plus the closing leg");
  assert.deepEqual(loop[0], loop[3]);
});

check("a one-way trip does not close the line", () => {
  assert.equal(closesOn(TRIP, false), false);
  assert.equal(closesOn(TRIP, true), true);
});

function closesOn(stops, loop) {
  const c = routeCoordinates(stops, loop);
  return c.length > 1 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
}

check("a two-stop loop is not a loop", () => {
  // There is no middle to come back from, so the closing leg would double the
  // route back over itself for nothing.
  assert.equal(closesOn([LONDON, PARIS], true), false);
});

check("readiness names what is missing rather than just refusing", () => {
  assert.equal(tripReadiness({ start: "", mid: "", end: "", loop: false, name: "" }, []).canDraw, false);
  const oneway = tripReadiness({ start: "London", mid: "", end: "Berlin", loop: false, name: "" }, TRIP);
  assert.equal(oneway.canDraw, true);
  assert.deepEqual(oneway.missing, []);

  // The loop swap has to reach readiness too, or Done stays dead on a round trip.
  const looped = tripReadiness({ start: "London", mid: "", end: "", loop: true, name: "" }, TRIP);
  assert.deepEqual(looped.missing, ["Mid point"], "a loop asks for a mid point, not an end point");

  assert.deepEqual(
    tripReadiness({ start: "London", mid: "Paris", end: "", loop: true, name: "" }, [LONDON]).missing,
    ["at least two stops"],
  );
});

console.log("route");

check("haversine matches the published London-Paris distance", () => {
  const km = haversineKm(LONDON, PARIS);
  assert.ok(Math.abs(km - 343) < 5, `expected about 343km, got ${km}`);
});

check("route length sums the legs rather than collapsing to a straight line", () => {
  const { totalKm, legs } = routeLength(TRIP);
  assert.equal(legs.length, 2);
  assert.equal(totalKm, legs[0].km + legs[1].km);
  // London-Paris 343.6km + Paris-Berlin 877.5km. The straight line from London
  // to Berlin is about 930km, so this also proves the route detours through
  // Paris rather than joining the dots. City centres are a couple of km off any
  // published figure, hence the tolerance.
  assert.ok(Math.abs(legs[0].km - 344) <= 2, `London-Paris leg was ${legs[0].km}km`);
  assert.ok(Math.abs(legs[1].km - 877) <= 2, `Paris-Berlin leg was ${legs[1].km}km`);
  assert.equal(totalKm, 1221);
});

check("an empty or single-stop route has no legs", () => {
  assert.deepEqual(routeLength([]), { totalKm: 0, legs: [] });
  assert.equal(routeLength([LONDON]).legs.length, 0);
});

console.log("stops");

check("adding a place twice is ignored", () => {
  const once = addStop([], LONDON);
  assert.equal(addStop(once, LONDON).length, 1);
});

check("remove and update target by id", () => {
  assert.deepEqual(removeStop(TRIP, PARIS.id).map((s) => s.name), ["London", "Berlin"]);
  assert.equal(updateStop(TRIP, PARIS.id, { minutes: 120 })[1].minutes, 120);
  assert.equal(updateStop(TRIP, PARIS.id, { minutes: 120 })[0].minutes, 60, "others untouched");
});

console.log("filters");

const PLACES = [
  { name: "Paris", country: "France", code: "FR", region: "Europe", query: "", lat: 48.85, lng: 2.35 },
  { name: "Lyon", country: "France", code: "FR", region: "Europe", query: "", lat: 45.76, lng: 4.83 },
  { name: "Kyoto", country: "Japan", code: "JP", region: "Asia", query: "", lat: 35.01, lng: 135.76 },
  { name: "Nowhere", country: "France", code: "FR", region: "Europe", query: "", lat: undefined, lng: undefined },
];

check("drops places with no coordinates, which cannot be dropped on the map", () => {
  assert.equal(filterPlaces(PLACES, { query: "", region: "", country: "", tab: "none" }).length, 3);
});

check("filters by region, by country and by free text", () => {
  const f = (o) => filterPlaces(PLACES, { query: "", region: "", country: "", tab: "none", ...o });
  assert.deepEqual(f({ region: "Asia" }).map((p) => p.name), ["Kyoto"]);
  assert.deepEqual(f({ country: "FR" }).map((p) => p.name), ["Paris", "Lyon"]);
  assert.deepEqual(f({ query: "lyo" }).map((p) => p.name), ["Lyon"]);
  assert.deepEqual(f({ query: "france" }).map((p) => p.name), ["Paris", "Lyon"], "searches country too");
  assert.equal(f({ query: "   " }).length, 3, "a blank query is not a filter");
  assert.equal(f({ region: "Asia", country: "FR" }).length, 0, "filters combine");
});

console.log("finder ordering");

const ORDERED = [
  { name: "Kyoto", country: "Japan", code: "JP", region: "Asia", query: "", lat: 35.01, lng: 135.76 },
  { name: "Lyon", country: "France", code: "FR", region: "Europe", query: "", lat: 45.76, lng: 4.83 },
  { name: "Paris", country: "France", code: "FR", region: "Europe", query: "", lat: 48.86, lng: 2.35 },
];

check("catalogue order is passed through untouched", () => {
  assert.deepEqual(orderPlaces(ORDERED, "catalogue").map((p) => p.name), ["Kyoto", "Lyon", "Paris"]);
});

check("country order sorts by country, then by name within it", () => {
  assert.deepEqual(
    orderPlaces(ORDERED, "country").map((p) => p.name),
    ["Lyon", "Paris", "Kyoto"],
    "France before Japan, and Lyon before Paris because L sorts first",
  );
});

check("nearest order measures from the given origin", () => {
  const fromLondon = { lat: 51.5, lng: -0.12 };
  assert.deepEqual(
    orderPlaces(ORDERED, "nearest", fromLondon).map((p) => p.name),
    ["Paris", "Lyon", "Kyoto"],
  );
  // Measured from Kyoto the order has to invert, or nothing was sorted at all.
  assert.deepEqual(
    orderPlaces(ORDERED, "nearest", { lat: 35, lng: 135.7 }).map((p) => p.name),
    ["Kyoto", "Paris", "Lyon"],
  );
});

check("nearest with no origin falls back to catalogue order, not to a guess", () => {
  assert.deepEqual(orderPlaces(ORDERED, "nearest").map((p) => p.name), ["Kyoto", "Lyon", "Paris"]);
  assert.deepEqual(
    orderPlaces(ORDERED, "nearest", undefined).map((p) => p.name),
    ["Kyoto", "Lyon", "Paris"],
  );
});

check("ordering copies rather than sorting the caller's array in place", () => {
  // results is memoised and handed to the map layer as well, so an in-place sort
  // would reorder the dots too and fight the map's own ordering.
  const before = ORDERED.map((p) => p.name);
  const out = orderPlaces(ORDERED, "country");
  assert.deepEqual(ORDERED.map((p) => p.name), before, "input untouched");
  assert.notEqual(out, ORDERED, "returns a new array");
});

console.log("daily limits");

check("no cap means every leg is day one", () => {
  const plans = planDays(TRIP, 0, 0);
  assert.equal(dayCount(plans), 1);
  assert.ok(plans.every((p) => p.day === 1));
});

check("a 400km daily cap splits London-Paris-Berlin into two days", () => {
  const plans = planDays(TRIP, 400, 0);
  assert.deepEqual(plans.map((p) => p.day), [1, 2]);
  assert.equal(dayCount(plans), 2);
});

check("a daily cap that a single leg breaches still counts that day", () => {
  // 930km in one hop cannot fit in any day, so it must not loop or vanish.
  const plans = planDays(TRIP, 100, 0);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].breachesKm, true);
  assert.equal(plans[1].breachesKm, true);
});

check("a driving-hours cap splits on hours as well as distance", () => {
  // 344km at 60km/h is 5.7h, so a 6h cap holds the first leg but not the 14.6h
  // hop from Paris to Berlin, which is what puts Berlin on day two.
  const plans = planDays(TRIP, 0, 6);
  assert.deepEqual(plans.map((p) => p.day), [1, 2]);
  assert.equal(plans[0].breachesHours, false, "the first leg fits inside six hours");
  assert.equal(plans[1].breachesHours, true, "Paris to Berlin does not");
});

check("a first leg longer than the whole cap is still day one, and is flagged", () => {
  // London-Paris alone is 5.7h, so a 5h cap cannot hold it. The leg must not
  // loop back on day zero or be dropped; it lands on day one and says so.
  const plans = planDays(TRIP, 0, 5);
  assert.deepEqual(plans.map((p) => p.day), [1, 2]);
  assert.equal(plans[0].breachesHours, true);
});

check("trimming to N days cuts mid-route and keeps the stop that starts it", () => {
  const plans = planDays(TRIP, 400, 0);
  assert.deepEqual(trimToDays(TRIP, plans, 1).map((s) => s.name), ["London", "Paris"]);
  assert.deepEqual(trimToDays(TRIP, plans, 2).map((s) => s.name), ["London", "Paris", "Berlin"]);
  assert.deepEqual(
    trimToDays(TRIP, plans, 0).map((s) => s.name),
    ["London", "Paris", "Berlin"],
    "0 means no cap",
  );
});

console.log("map furniture");

check("the scale bar is round, fits its budget, and shrinks as you zoom in", () => {
  const NICE = new Set([
    0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
    2000, 5000,
  ]);
  let previous = Infinity;
  for (const z of [0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]) {
    const { miles, px, label } = scaleBarFor(z);
    assert.ok(NICE.has(miles), `zoom ${z} gave ${miles}, not a round number`);
    assert.ok(px > 0 && px <= 90, `zoom ${z} gave ${px}px, outside 1..90`);
    assert.match(label, /^\d+(\.\d+)?(mi|ft)$/, `zoom ${z} label was "${label}"`);
    // A scale bar spans a roughly fixed number of pixels of an increasingly
    // small patch of ground, so the distance it names must not increase.
    assert.ok(miles <= previous, `zoom ${z} bar grew to ${miles} from ${previous}`);
    previous = miles;
  }
});

check("the scale bar measures the real world", () => {
  // At zoom 0 the whole equator is 256px, so one pixel is about 97.3 miles and a
  // 90px budget buys about 8760 miles. The largest round rung under that is
  // 5000, which draws at about 51px. An upwards search would have picked 10000,
  // which is off the end of the ladder, or stopped at 50 miles -- half a pixel.
  const { miles, px, label } = scaleBarFor(0);
  assert.equal(miles, 5000);
  assert.equal(label, "5000mi");
  assert.ok(px > 45 && px < 55, `expected about 51px, got ${px}`);

  // At zoom 1 a pixel is half that, so 5000 miles would be 103px and the bar has
  // to drop a rung. This is the case that an upwards search gets wrong.
  assert.equal(scaleBarFor(1).miles, 2000);
  assert.ok(scaleBarFor(1).px <= 90);
});

check("the scale bar drops to feet at street zoom rather than overflowing", () => {
  // A mile is a couple of thousand pixels at zoom 18 and 0.02 of a mile is still
  // 430px, so the only honest bar down there is measured in feet.
  const at18 = scaleBarFor(18);
  assert.ok(at18.miles < 0.1, `expected a sub-tenth-mile bar, got ${at18.miles}`);
  assert.ok(at18.px > 0 && at18.px <= 90, `${at18.px}px`);
  assert.match(at18.label, /ft$/, `zoom 18 label was "${at18.label}"`);

  const at22 = scaleBarFor(22);
  assert.ok(at22.px > 0 && at22.px <= 90, `zoom 22 gave ${at22.px}px`);
  assert.match(at22.label, /ft$/);
});

check("coordinates print as Furkot prints them, in the right hemisphere", () => {
  assert.equal(formatDms(53.6967, "lat"), "53°41'48.1\"N");
  assert.equal(formatDms(-16.51, "lng"), "16°30'36.0\"W");
  assert.equal(formatDms(0, "lat"), "0°00'00.0\"N");
});

console.log(`\n${checks} checks passed`);
