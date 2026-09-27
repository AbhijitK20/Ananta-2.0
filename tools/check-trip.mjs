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
  MAX_ROUTED_STOPS,
  OSRM_BASE,
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
  osrmUrl,
  parseOsrmRoute,
  planDays,
  removeStop,
  routeCoordinates,
  routeLength,
  scaleBarFor,
  simplifyPath,
  stopAt,
  stopCountForDays,
  straightLineRoute,
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

console.log("on the road");

// A real OSRM response for London -> Paris -> Berlin, trimmed to the fields the
// parser reads. The numbers are the ones the demo server returns, and they are
// the whole argument for this section: 620km and 1051km by road, against 344 and
// 877 as the crow flies.
const OSRM = {
  code: "Ok",
  routes: [
    {
      geometry: {
        type: "LineString",
        coordinates: [
          [-0.1278, 51.5074],
          [-0.12, 51.5],
          [0.5, 51.2],
          [1.9, 50.9],
          [2.3522, 48.8566],
          [4.0, 49.5],
          [8.0, 50.2],
          [13.405, 52.52],
        ],
      },
      legs: [
        { distance: 620400, duration: 43200 },
        { distance: 1051200, duration: 38880 },
      ],
    },
  ],
  waypoints: [
    { location: [-0.12796, 51.50747] },
    { location: [2.35231, 48.85724] },
    { location: [13.405, 52.52] },
  ],
};

check("a driving route is longer than the crow flies, which is the point", () => {
  const road = parseOsrmRoute(OSRM, TRIP, false);
  const straight = straightLineRoute(TRIP, false);
  assert.equal(road.fallback, false);
  assert.deepEqual(road.legKm, [620, 1051], "read from the response, in km");
  assert.equal(road.totalKm, 1671);
  assert.equal(straight.totalKm, 1221, "the straight line it replaces");
  assert.ok(road.totalKm > straight.totalKm * 1.3, "at least 30% longer by road");
});

check("driving hours are read per leg", () => {
  assert.deepEqual(parseOsrmRoute(OSRM, TRIP, false).legHours, [12, 10.8], "43200s is 12h");
});

check("stops are snapped onto the network, so markers sit on the road", () => {
  const road = parseOsrmRoute(OSRM, TRIP, false);
  assert.deepEqual(road.snapped[0], { lat: 51.50747, lng: -0.12796 });
  assert.notDeepEqual(road.snapped[0], { lat: LONDON.lat, lng: LONDON.lng });
});

check("a loop repeats the first stop, which is how a circuit is described", () => {
  const flat = osrmUrl(TRIP, false);
  const looped = osrmUrl(TRIP, true);
  assert.ok(flat.startsWith(`${OSRM_BASE}/route/v1/driving/`));
  assert.equal((flat.match(/;/g) ?? []).length, 2, "three stops is two separators");
  assert.equal((looped.match(/;/g) ?? []).length, 3, "a loop adds the closing waypoint");
  assert.ok(looped.endsWith("?overview=full&geometries=geojson"), "full geometry, not simplified");
  // lon,lat order, not lat,lon: getting this backwards is the classic OSRM mistake.
  assert.ok(flat.includes("-0.1278,51.5074"), "coordinates are lon,lat");
});

check("the waypoint list is capped so the URL stays sane", () => {
  const many = Array.from({ length: 30 }, (_, i) => stopAt(`s${i}`, 50 + i * 0.1, 4 + i * 0.1));
  const count = osrmUrl(many, false).split("?")[0].split("/").pop().split(";").length;
  assert.ok(count <= MAX_ROUTED_STOPS, `${count} waypoints, cap is ${MAX_ROUTED_STOPS}`);
});

check("a refused or empty response falls back instead of rendering nothing", () => {
  for (const bad of [
    { code: "NoRoute" },
    { code: "Ok", routes: [] },
    { code: "Ok", routes: [{ geometry: { coordinates: [[0, 0]] }, legs: [] }] },
    { code: "Ok", routes: [{ legs: [{ distance: 1 }] }] },
    {},
  ]) {
    const r = parseOsrmRoute(bad, TRIP, false);
    assert.equal(r.fallback, true, `expected fallback for ${JSON.stringify(bad).slice(0, 40)}`);
    assert.deepEqual(r.legKm, [344, 877], "falls back to haversine, so the numbers still add up");
    assert.equal(r.totalKm, 1221);
    assert.equal(r.coordinates.length, 3, "still draws the straight line");
  }
});

check("the fallback reports no driving times rather than inventing them", () => {
  assert.deepEqual(straightLineRoute(TRIP, false).legHours, []);
  assert.deepEqual(parseOsrmRoute(OSRM, TRIP, false).legHours.length, 2);
});

check("simplifyPath drops points but keeps the shape and both ends", () => {
  // A straight run of collinear points must reduce to its two endpoints.
  const line = Array.from({ length: 200 }, (_, i) => [i * 0.001, 51.5]);
  const simple = simplifyPath(line, 10);
  assert.equal(simple.length, 2, "200 collinear points collapse to 2");
  assert.deepEqual(simple[0], line[0]);
  assert.deepEqual(simple[1], line[line.length - 1]);

  // A corner has to survive, or the route stops following roads.
  const corner = simplifyPath(
    [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0.002, 0.001],
    ],
    10,
  );
  assert.ok(corner.length >= 3, `expected the corner kept, got ${JSON.stringify(corner)}`);

  // And it must actually shrink a dense path, or it is not doing its job. Eight
  // hand-written points prove nothing: every one of them is more than 10m off the
  // chord, so the right answer is to keep all eight. The real input is OSRM's
  // 18,500 points, so build something of that shape.
  const dense = Array.from({ length: 5000 }, (_, i) => {
    const t = i / 4999;
    return [4 + t * 8, 46 + t * 3 + Math.sin(t * 40) * 0.02];
  });
  const pruned = simplifyPath(dense, 10);
  assert.ok(pruned.length < dense.length / 10, `5000 points reduced to only ${pruned.length}`);
  assert.ok(pruned.length > 2, `over-pruned to ${pruned.length}, the curve is gone`);
  assert.deepEqual(pruned[0], dense[0], "keeps the first point exactly");
  assert.deepEqual(pruned[pruned.length - 1], dense[dense.length - 1], "keeps the last exactly");

  // Whatever it dropped, every original point must still sit within tolerance of
  // the simplified line. Nearest segment per point, then the worst of those --
  // measuring each point against every segment would report the distance from one
  // end of the route to the other and mean nothing.
  const near = (p, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
    return Math.hypot((p[0] - (a[0] + t * dx)) * 74000, (p[1] - (a[1] + t * dy)) * 111000);
  };
  let worst = 0;
  for (const p of dense) {
    let best = Infinity;
    for (let i = 1; i < pruned.length; i++) {
      const d = near(p, pruned[i - 1], pruned[i]);
      if (d < best) best = d;
    }
    worst = Math.max(worst, best);
  }
  assert.ok(worst < 60, `simplified path strays ${Math.round(worst)}m from the original`);
});

check("simplifyPath leaves a degenerate input alone", () => {
  assert.deepEqual(simplifyPath([]), []);
  assert.equal(simplifyPath([[0, 0]]).length, 1);
  assert.equal(
    simplifyPath([
      [0, 0],
      [1, 1],
    ]).length,
    2,
  );
  // A duplicated point must not divide by zero.
  assert.equal(
    simplifyPath([
      [0, 0],
      [0, 0],
      [0, 0],
    ]).length,
    2,
  );
});

console.log("daily limits");

// Legs are now distances, not stops, so the planner works off whatever the router
// said. The real London-Paris-Berlin figures make the point that the old
// haversine-based version was planning days against the wrong numbers.
const ROAD_LEGS = [620, 1051];
const FLY_LEGS = [344, 877];

check("no cap means every leg is day one", () => {
  const plans = planDays(ROAD_LEGS, 0, 0);
  assert.equal(dayCount(plans), 1);
  assert.ok(plans.every((p) => p.day === 1));
});

check("a 400km daily cap splits London-Paris-Berlin into two days", () => {
  // On the road figures, 620km cannot fit in a 400km day, so the first leg is
  // already over. On the crow-flies figures it looks like it fits. This is the
  // single reason the planner takes distances from the router.
  const road = planDays(ROAD_LEGS, 400, 0);
  assert.equal(road[0].breachesKm, true, "620km does not fit in 400km");
  assert.equal(planDays(FLY_LEGS, 400, 0)[0].breachesKm, false, "344km would have fit");

  // 700km holds the first leg and not the second.
  assert.deepEqual(planDays(ROAD_LEGS, 700, 0).map((p) => p.day), [1, 2]);
  assert.equal(dayCount(planDays(ROAD_LEGS, 700, 0)), 2);
});

check("a daily cap that a single leg breaches still counts that day", () => {
  // 1051km in one hop cannot fit in any day, so it must not loop or vanish.
  const plans = planDays(ROAD_LEGS, 100, 0);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].breachesKm, true);
  assert.equal(plans[1].breachesKm, true);
});

check("a driving-hours cap splits on hours as well as distance", () => {
  // The road figures give real durations: 12h and 10.8h. A 14h cap holds the
  // first leg and not the second.
  const plans = planDays(ROAD_LEGS, 0, 14);
  assert.deepEqual(plans.map((p) => p.day), [1, 2]);
  assert.equal(plans[0].breachesHours, false, "a 12h leg fits inside a 14h day");
  assert.equal(plans[1].breachesHours, true, "a 10.8h leg on top of it does not");
});

check("a first leg longer than the whole cap is still day one, and is flagged", () => {
  const plans = planDays(ROAD_LEGS, 0, 5);
  assert.deepEqual(plans.map((p) => p.day), [1, 2]);
  assert.equal(plans[0].breachesHours, true);
});

check("trimming to N days cuts mid-route and keeps the stop that starts it", () => {
  const plans = planDays(ROAD_LEGS, 700, 0);
  assert.equal(stopCountForDays(4, plans, 1), 2, "London and Paris, Berlin is on day two");
  assert.equal(stopCountForDays(4, plans, 2), 4, "everything");
  assert.equal(stopCountForDays(4, plans, 0), 4, "0 means no cap");
  assert.equal(stopCountForDays(2, plans, 1), 2, "a two-stop trip is never trimmed away");
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
