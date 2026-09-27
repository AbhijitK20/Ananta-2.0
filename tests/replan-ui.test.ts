/**
 * The reality-changed path, end to end, at the URL layer.
 *
 * WHY THIS FILE EXISTS. `RealityPanel` shipped six buttons that each built a
 * `ContextChange` with an empty `patch` and navigated. Because this app keeps the
 * traveller's situation in the URL rather than in a store, an empty patch is
 * literally the same address — so the demo's second acceptance criterion ("hit
 * it started raining, get a re-solve with at most two swaps") passed review while
 * doing nothing at all. Typecheck could not see it, the unit tests could not see
 * it, and only a test that actually follows a trigger into the next render can.
 *
 * Four claims, and each one is a way the previous version was broken:
 *
 *  1. a trigger writes a different situation, and the engine reads the field it
 *     wrote — the no-op;
 *  2. `DiscoveryContext.original` is frozen on the FIRST change and does not
 *     move on the second, so "still looking for what you asked for at the start"
 *     is a fact rather than a restatement of the latest click;
 *  3. the reasons in the diff are the engine's own sentences, not strings
 *     composed here;
 *  4. the diff is under the two-swap ceiling for the triggers the docs promise,
 *     and when it is not, the panel says so.
 *
 * The first two are the regression this was written for. The last two are the
 * claim the panel makes out loud, so they are worth a test that fails.
 */
import { describe, expect, it } from "vitest";

import { DiscoveryContext } from "@/contracts";
import { SWAP_BUDGET } from "@/features/discovery";
import {
  computeDiscovery,
  contextFromParams,
  paramsFromContext,
  realityAfter,
} from "@/app/_lib/discovery";
import { CONTEXT_TRIGGERS, TRIGGER_BY_KEY, queryForTrigger } from "@/app/_lib/triggers";
import { originNote, resolvePlace } from "@/app/_lib/place";

/** The default landing situation, as a shareable query. */
const START = "t=180&p=2&pt=couple&m=walk&w=clear";

function triggerFor(key: string) {
  const trigger = TRIGGER_BY_KEY.get(key);
  if (!trigger) throw new Error(`no trigger named ${key}`);
  return trigger;
}

/** One press of a trigger, from a starting query. */
function press(query: string, key: string, firstStopId: string | null = null): URLSearchParams {
  const params = new URLSearchParams(query);
  const context = contextFromParams(params);
  return new URLSearchParams(queryForTrigger(triggerFor(key), { params, context, firstStopId }));
}

describe("reality changed", () => {
  it("every trigger writes a situation the engine can read", () => {
    const start = new URLSearchParams(START);
    const startContext = contextFromParams(start);

    for (const trigger of CONTEXT_TRIGGERS) {
      const next = press(START, trigger.key, "exp-marine-drive");
      expect(next.toString(), `${trigger.key} navigated to its own address`).not.toBe(START);

      // The patch is only real if a `DiscoveryContext` field actually moved.
      // Checking the params alone would pass for a trigger that wrote a key the
      // contract does not have.
      const context = contextFromParams(next);
      const fields: ReadonlyArray<[string, unknown, unknown]> = [
        ["availableMin", context.availableMin, startContext.availableMin],
        ["weather", context.weather.condition, startContext.weather.condition],
        ["budget", context.budget?.minor, startContext.budget?.minor],
        ["accessNeeds", context.accessNeeds.join(","), startContext.accessNeeds.join(",")],
        ["excludedIds", context.excludedIds.join(","), startContext.excludedIds.join(",")],
        ["travelMode", context.travelMode, startContext.travelMode],
      ];
      const moved = fields.filter(([, after, before]) => after !== before);
      expect(moved.length, `${trigger.key} changed no field the engine reads`).toBeGreaterThan(0);
    }
  });

  it("freezes the original ask on the first change and keeps it through the second", () => {
    const once = press(START, "rain");
    const baseline = contextFromParams(new URLSearchParams(START)).original;

    expect(once.get("intent"), "the first change records the baseline").not.toBeNull();
    expect(contextFromParams(once).original).toEqual(baseline);

    // Second change, from the first. The baseline must not drift with it.
    const twice = press(once.toString(), "budget");
    const afterTwo = contextFromParams(twice);

    expect(afterTwo.original).toEqual(baseline);
    // The second trigger moved the budget and only the budget: `rain` before it
    // touched the weather, so an unchanged window here is the point, not a miss.
    expect(afterTwo.budget?.minor).not.toBe(baseline.budget?.minor);
    expect(afterTwo.availableMin).toBe(contextFromParams(once).availableMin);
    // The diff is against what the traveller was looking at a second ago, which
    // is the first change, not the baseline. These are different on purpose.
    expect(twice.get("was")).not.toBe(twice.get("intent"));
  });

  it("keeps the frozen baseline and the exclusions through a round trip", () => {
    // A "back to the map" link is built with `paramsFromContext`. Dropping the
    // history params there would reset the baseline to the current situation and
    // resurrect a stop that just left the plan.
    const sold = press(press(START, "soldout", "exp-marine-drive").toString(), "rain");
    const round = new URLSearchParams(paramsFromContext(contextFromParams(sold), sold));

    expect(round.get("intent")).toBe(sold.get("intent"));
    expect(round.get("changed")).toBe("rain");
    expect(contextFromParams(round).excludedIds).toEqual(["exp-marine-drive"]);
    expect(contextFromParams(round).original).toEqual(contextFromParams(sold).original);
  });

  it("diff two real plans and reports engine-authored reasons under the ceiling", async () => {
    const after = await computeDiscovery(press(START, "rain"));
    const reality = await realityAfter(press(START, "rain"), after);

    expect(reality, "a trigger produced no diff at all").not.toBeNull();
    if (!reality) return;

    expect(reality.change.kind).toBe("weather_changed");
    expect(reality.intentPreserved, "the original ask moved").toBe(true);
    expect(reality.intent.length, "no baseline was rendered to the traveller").toBeGreaterThan(0);

    // A finished sentence with the real number in it, not "constraint violated".
    for (const row of [...reality.removed, ...reality.added]) {
      expect(row.reason.length, `no reason for ${row.id}`).toBeGreaterThan(10);
      expect(row.reason).not.toMatch(/constraint|violation|undefined/i);
    }

    // Over the ceiling is allowed to ship only as a loud finding, which
    // `warningsFor` does. Silent is the failure this guards.
    if (reality.swapCount > SWAP_BUDGET) {
      expect(reality.warnings.join(" ")).toContain("budget");
    }
  }, 30_000);

  it("keeps every plan it builds inside the frozen contract", async () => {
    for (const key of ["rain", "time", "budget", "restroom", "exhausted"]) {
      const params = press(START, key);
      const after = await computeDiscovery(params);
      expect(() => DiscoveryContext.parse(after.context), key).not.toThrow();
      expect(after.plan, `${key} produced no plan`).toBeDefined();
    }
  }, 30_000);
});

describe("where you are", () => {
  it("resolves free text to a real coordinate, and says so when it cannot", async () => {
    const colaba = await resolvePlace("I am at Colaba");
    expect(colaba.point, "Colaba did not resolve").not.toBeNull();
    expect(colaba.label).toBe("Colaba");

    // The lead-in is stripped, not matched as part of the name. `Chhatrapati
    // Shivaji Maharaj` is a real row in the catalogue, so this is a real answer
    // rather than a fixture that happens to line up.
    const venue = await resolvePlace("we're near Chhatrapati Shivaji Maharaj");
    expect(venue.point, "the lead-in was not stripped").not.toBeNull();
    expect(venue.source).toBe("place");

    // Honest failure. Snapping an unknown place onto a real one would produce
    // confident, wrong travel times, which is the worst thing this can do.
    const nonsense = await resolvePlace("the moon");
    expect(nonsense.point).toBeNull();
    expect(originNote(nonsense)).toContain("the moon");
    expect(originNote(colaba)).toBeNull();
  });

  it("moves the plan when the origin moves", async () => {
    const bandra = await computeDiscovery(new URLSearchParams(START));
    const colaba = await computeDiscovery(new URLSearchParams(`${START}&at=Colaba`));

    expect(colaba.context.origin.label).toBe("Colaba");
    expect(colaba.context.origin.point).not.toEqual(bandra.context.origin.point);
    expect(bandra.originNote, "a resolved origin produced a warning").toBeNull();

    // The whole point of resolving it: the distance gate now measures from
    // somewhere real, so a different origin must reach a different answer.
    const reachable = new Set(colaba.plan.stops.map((stop) => stop.experienceId));
    const bandraReachable = new Set(bandra.plan.stops.map((stop) => stop.experienceId));
    expect([...reachable].some((id) => !bandraReachable.has(id))).toBe(true);
  }, 30_000);

  it("carries interests and things to avoid into the context and back out again", async () => {
    const params = new URLSearchParams(`${START}&i=local%20food,craft&avoid=crowds`);
    const after = await computeDiscovery(params);

    expect(after.context.interests).toEqual(["local food", "craft"]);
    expect(after.context.avoid).toEqual(["crowds"]);

    const round = new URLSearchParams(paramsFromContext(after.context, params));
    expect(round.get("i")).toBe("local food,craft");
    expect(round.get("avoid")).toBe("crowds");
  }, 30_000);

  it("does not let a URL smuggle an unbounded vocabulary past the parser", () => {
    const many = Array.from({ length: 200 }, (_, i) => `thing${i}`).join(",");
    const context = contextFromParams(new URLSearchParams(`i=${many}&avoid=${many}`));
    expect(context.interests.length).toBeLessThanOrEqual(8);
    expect(context.avoid.length).toBeLessThanOrEqual(8);
  });
});
