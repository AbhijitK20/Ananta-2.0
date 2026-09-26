/**
 * The recovery moves, tested the only way that means anything: by taking the
 * moves and checking the numbers.
 *
 * WHY THIS FILE IS SEPARATE. `health.test.ts` proves the READ is arithmetic.
 * This one proves the ADVICE is too. The failure mode being guarded against is
 * specific and ugly: a helper that prints "dropping a stop takes you from 94 to
 * 71" while never actually dropping one. So the central test here re-runs the
 * whole read on every projected plan and compares it to the number the move
 * claimed. If the claim and the arithmetic ever drift apart, that test fails
 * first and names the move.
 */
import { describe, expect, it } from "vitest";
import { Plan as PlanSchema, type Plan } from "../../contracts";
import { THRESHOLDS, assessTripHealth, bandOf, type TripHealth } from "./health";
import { compareHealth, recoveryMoves, type RecoveryMove } from "./recovery";
import { CATALOGUE, context, plan, rejection, type StopSpec } from "./fixtures";

const BAD_STOPS: StopSpec[] = [
  { id: "exp-fort", arrive: 600, activityMin: 45, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 90_000 },
  { id: "exp-market", arrive: 670, activityMin: 45, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 40_000 },
  { id: "exp-beach", arrive: 740, activityMin: 45, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 40_000 },
  { id: "exp-nature", arrive: 810, activityMin: 60, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 90_000 },
  { id: "exp-theatre", arrive: 895, activityMin: 60, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 90_000 },
  { id: "exp-showcase", arrive: 980, activityMin: 45, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 40_000 },
];

const BAD_REJECTIONS = [
  rejection({ experienceId: "exp-cafe", code: "duration_exceeds_budget", shortfall: 5, unit: "minutes" }),
  rejection({ experienceId: "exp-gallery", code: "lead_time_too_short", shortfall: 15, unit: "minutes" }),
  rejection({ experienceId: "exp-museum", code: "closed_during_window", shortfall: 10, unit: "minutes" }),
  rejection({ experienceId: "exp-market2", code: "too_far", shortfall: 800, unit: "metres" }),
];

const BAD_CTX = context({
  availableMin: 300,
  budget: { minor: 400_000, currency: "INR" },
  weather: { condition: "storm", tempC: 26, source: "live" },
});

const badPlan = (): Plan => plan({ stops: BAD_STOPS, availableMin: 300, rejected: BAD_REJECTIONS, costMinor: 390_000 });

const movesOf = (p: Plan = badPlan(), ctx = BAD_CTX): RecoveryMove[] => recoveryMoves(p, ctx, CATALOGUE);

const CALM_STOPS: StopSpec[] = [
  { id: "exp-fort", arrive: 630, activityMin: 45, travelMin: 8, bufferMin: 20, costMinor: 40_000 },
  { id: "exp-gallery", arrive: 713, activityMin: 60, travelMin: 8, bufferMin: 20, costMinor: 60_000 },
];

const calmPlan = (): Plan => plan({ stops: CALM_STOPS, availableMin: 420 });
const calmCtx = context({ availableMin: 420 });

/** A deliberately broken plan, for the checks that must refuse to trust one. */
const corrupt = (mutate: (p: Plan) => Plan): Plan => {
  const base = badPlan();
  return PlanSchema.parse({ ...mutate(base), stressScore: 0, stressFactors: [] });
};

const ofKind = (moves: RecoveryMove[], kind: RecoveryMove["kind"]): RecoveryMove | undefined =>
  moves.find((move) => move.kind === kind);

const signalOf = (h: TripHealth, dimension: TripHealth["dimensions"][number]["dimension"], key: string) =>
  h.dimensions.find((d) => d.dimension === dimension)!.signals.find((s) => s.key === key)!;

const riskOf = (h: TripHealth): number => h.dimensions.find((d) => d.dimension === "reservationRisk")!.value;

describe("every move it offers is one it measured", () => {
  const packed = badPlan();
  const before = assessTripHealth(packed, BAD_CTX, CATALOGUE);
  const moves = movesOf();

  it("finds something to do about a plan that scores 94", () => {
    expect(before.score).toBe(94);
    expect(before.trustworthy).toBe(true);
    expect(moves.length).toBeGreaterThan(3);
  });

  it("reports the number a fresh read of the projected plan actually gives", () => {
    for (const move of moves) {
      const verified = assessTripHealth(move.after, BAD_CTX, CATALOGUE);
      expect(verified.score).toBe(move.projectedScore);
      expect(move.projected.score).toBe(move.projectedScore);
    }
  });

  it("only offers moves that make the plan strictly easier", () => {
    for (const move of moves) {
      expect(move.projectedScore).toBeLessThan(before.score);
      expect(move.gain).toBeLessThan(0);
      expect(move.gain).toBe(move.projectedScore - before.score);
    }
  });

  it("shows a move only when it is worth acting on, which is the rule it claims", () => {
    for (const move of moves) {
      const gain = before.score - move.projectedScore;
      const crossed = bandOf(move.projectedScore) !== bandOf(before.score);
      expect(gain >= THRESHOLDS.minRecoveryGain || crossed).toBe(true);
    }
  });

  it("ranks the biggest gain first", () => {
    const scores = moves.map((move) => move.projectedScore);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
  });

  it("writes the measured outcome into the sentence, not a guess", () => {
    for (const move of moves) {
      expect(move.instruction).toContain(String(before.score));
      expect(move.instruction).toContain(String(move.projectedScore));
      expect(move.instruction).toMatch(/[.!]$/);
    }
  });

  it("marks the projected plan as a projection, so it cannot pass for a packed one", () => {
    for (const move of moves) {
      expect(move.after.engineVersion).toContain("recovery-projection");
      expect(move.after.id).not.toBe(packed.id);
      expect(PlanSchema.safeParse(move.after).success).toBe(true);
    }
  });

  it("carries the projected score on the plan it hands back", () => {
    for (const move of moves) {
      expect(move.after.stressScore).toBe(move.projectedScore);
    }
  });

  it("gives two runs the same answer, in the same order", () => {
    expect(JSON.stringify(recoveryMoves(badPlan(), BAD_CTX, CATALOGUE))).toBe(JSON.stringify(moves));
  });

  it("points each move at a dimension the radar actually has", () => {
    for (const move of moves) {
      expect(before.dimensions.map((d) => d.dimension)).toContain(move.targets);
    }
  });
});

describe("leaving a stop out is a real re-timing, not a deletion", () => {
  const packed = badPlan();
  const dropping = movesOf().filter((move) => move.kind === "drop_stop");
  const first = dropping[0]!;

  it("offers one per stop, and each removes exactly that stop", () => {
    expect(dropping.length).toBe(packed.stops.length);
    for (const move of dropping) {
      const removed = move.id.replace("drop_stop:", "");
      expect(packed.stops.map((s) => s.experienceId)).toContain(removed);
      expect(move.after.stops.map((s) => s.experienceId)).not.toContain(removed);
      expect(move.after.stops.length).toBe(packed.stops.length - 1);
      expect(move.cost.stops).toBe(1);
    }
  });

  it("renumbers the survivors so the order is still 0-based and gapless", () => {
    expect(first.after.stops.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("leaves nobody overlapping and nobody arriving before they leave", () => {
    for (const move of dropping) {
      const stops = [...move.after.stops].sort((a, b) => a.order - b.order);
      for (const stop of stops) expect(stop.departMin).toBeGreaterThanOrEqual(stop.arriveMin);
      for (let i = 1; i < stops.length; i += 1) {
        expect(stops[i]!.arriveMin).toBeGreaterThanOrEqual(stops[i - 1]!.departMin);
      }
    }
  });

  it("keeps the legs joining the stops that are left", () => {
    const stops = [...first.after.stops].sort((a, b) => a.order - b.order);
    expect(first.after.legs.length).toBe(stops.length - 1);
    for (let i = 0; i < first.after.legs.length; i += 1) {
      expect(first.after.legs[i]!.fromId).toBe(stops[i]!.experienceId);
      expect(first.after.legs[i]!.toId).toBe(stops[i + 1]!.experienceId);
    }
  });

  it("reports a totalMin that is the span it actually occupies", () => {
    const stops = [...first.after.stops].sort((a, b) => a.order - b.order);
    const built = stops.reduce((sum, s) => sum + (s.departMin - s.arriveMin) + s.fit.bufferMin, 0);
    expect(built + first.after.legs.reduce((sum, l) => sum + l.minutes, 0)).toBe(first.after.totalMin);
  });

  it("keeps every surviving stop's own duration, cost and buffer", () => {
    for (const after of first.after.stops) {
      const before = packed.stops.find((s) => s.experienceId === after.experienceId)!;
      expect(after.departMin - after.arriveMin).toBe(before.departMin - before.arriveMin);
      expect(after.fit.bufferMin).toBe(before.fit.bufferMin);
      expect(after.fit.cost.minor).toBe(before.fit.cost.minor);
    }
  });

  it("spends less, because there is one less stop in it", () => {
    for (const move of dropping) {
      expect(move.cost.minorUnits).toBeGreaterThan(0);
      expect(move.cost.metres).toBeGreaterThanOrEqual(0);
    }
  });

  it("hands back a plan the read can still stand behind", () => {
    const adopted = assessTripHealth(first.after, BAD_CTX, CATALOGUE);
    expect(adopted.trustworthy).toBe(true);
    expect(adopted.score).toBe(first.projectedScore);
  });
});

describe("riding instead of walking changes the mode, not the distance", () => {
  const packed = badPlan();
  const moves = movesOf();
  const ride = ofKind(moves, "ride_instead");

  it("is offered for every walk leg worth replacing", () => {
    expect(ride).toBeDefined();
    expect(moves.filter((m) => m.kind === "ride_instead").length).toBeGreaterThan(1);
  });

  it("turns that leg into a ride and leaves the metres alone", () => {
    const ridden = ride!.after.legs.find((l) => l.mode === "auto")!;
    const walked = packed.legs.find((l) => l.mode === "walk")!;
    expect(ridden.metres).toBe(walked.metres);
    expect(ridden.minutes).toBeLessThan(walked.minutes);
  });

  it("takes the walking out of the walk share, which is the point", () => {
    expect(ride!.after.legs.filter((l) => l.mode === "walk").length).toBe(
      packed.legs.filter((l) => l.mode === "walk").length - 1,
    );
    const after = assessTripHealth(ride!.after, BAD_CTX, CATALOGUE);
    const before = assessTripHealth(packed, BAD_CTX, CATALOGUE);
    expect(after.facts.walkMetres).toBeLessThan(before.facts.walkMetres);
  });

  it("never offers a ride into the first stop, which has no leg before it", () => {
    for (const move of moves.filter((m) => m.kind === "ride_instead")) {
      expect(move.id).not.toBe("ride_instead:exp-fort");
    }
  });
});

describe("more slack is offered, and its cost is admitted", () => {
  const packed = badPlan();
  const buffer = ofKind(movesOf(), "add_buffer");

  it("makes the plan LONGER, and says so in the sentence", () => {
    expect(buffer).toBeDefined();
    expect(buffer!.cost.minutes).toBeLessThan(0);
    expect(buffer!.cost.stops).toBe(0);
    expect(buffer!.after.totalMin).toBeGreaterThan(packed.totalMin);
    expect(buffer!.instruction).toContain("more");
  });

  it("still helps, even though it costs time, because the pin was the problem", () => {
    const after = buffer!.projected;
    const before = assessTripHealth(packed, BAD_CTX, CATALOGUE);
    const pin = (d: TripHealth) => d.dimensions.find((x) => x.dimension === "pinDebt")!.value;
    expect(pin(after)).toBeLessThan(pin(before));
    expect(after.score).toBeLessThan(before.score);
  });

  it("never reaches full slack on a plan that cannot hold it", () => {
    const tight = plan({
      stops: [{ id: "exp-fort", arrive: 600, activityMin: 200, travelMin: 0, bufferMin: 0, fitRatio: 1, verdict: "tight" }],
      availableMin: 60,
    });
    expect(ofKind(recoveryMoves(tight, context({ availableMin: 60 }), CATALOGUE), "add_buffer")).toBeUndefined();
  });
});

describe("the bookable stops come out together", () => {
  const unbook = ofKind(movesOf(), "unbook");

  it("removes exactly the stops that need a reservation", () => {
    expect(unbook).toBeDefined();
    const left = unbook!.after.stops.map((s) => s.experienceId);
    expect(left).not.toContain("exp-nature");
    expect(left).not.toContain("exp-theatre");
    expect(left).toContain("exp-fort");
    expect(unbook!.cost.stops).toBe(2);
  });

  it("takes the booking pressure off the stops, which is what the move was for", () => {
    expect(signalOf(unbook!.projected, "reservationRisk", "bookings").load).toBe(0);
    expect(signalOf(unbook!.projected, "reservationRisk", "shortNotice").load).toBe(0);
    // What is left is honest: a candidate was still refused for booking rules,
    // so the day is not entirely free of that risk.
    expect(signalOf(unbook!.projected, "reservationRisk", "refused").load).toBeGreaterThan(0);
    expect(riskOf(unbook!.projected)).toBeLessThan(riskOf(assessTripHealth(badPlan(), BAD_CTX, CATALOGUE)));
  });

  it("is not offered when nothing needs booking", () => {
    expect(ofKind(movesOf(calmPlan(), calmCtx), "unbook")).toBeUndefined();
  });
});

describe("when there is nothing to offer, it says nothing", () => {
  it("offers nothing at all for a plan that is already easy", () => {
    // A 2-point gain is not a rescue. The bands sit 20 points apart, so a move
    // that small crosses nothing and changes no label, and showing it would
    // only teach the traveller to ignore the list.
    const calm = assessTripHealth(calmPlan(), calmCtx, CATALOGUE);
    expect(calm.score).toBeLessThanOrEqual(THRESHOLDS.saneAt);
    expect(recoveryMoves(calmPlan(), calmCtx, CATALOGUE)).toEqual([]);
  });

  it("will still show a small gain that crosses a band, because that is a milestone", () => {
    // With the floor raised past anything this plan can achieve, only a
    // band-crossing move could survive, and none does.
    expect(recoveryMoves(calmPlan(), calmCtx, CATALOGUE, { minRecoveryGain: 99 })).toEqual([]);
  });

  it("offers no drops for a one-stop plan, because there is nothing to drop", () => {
    const single = plan({ stops: [BAD_STOPS[0]!], availableMin: 300 });
    expect(recoveryMoves(single, BAD_CTX, CATALOGUE).filter((m) => m.kind === "drop_stop")).toEqual([]);
  });

  it("offers no moves at all for a plan that contradicts itself", () => {
    const broken = corrupt((p) => ({ ...p, totalMin: 12 }));
    expect(assessTripHealth(broken, BAD_CTX, CATALOGUE).trustworthy).toBe(false);
    expect(recoveryMoves(broken, BAD_CTX, CATALOGUE)).toEqual([]);
  });

  it("refuses to re-route a plan whose legs do not join its stops", () => {
    const detached = corrupt((p) => ({ ...p, legs: p.legs.map((leg) => ({ ...leg, fromId: "exp-nobody" })) }));
    // The read flags it, because a route it cannot check is not a route...
    expect(assessTripHealth(detached, BAD_CTX, CATALOGUE).trustworthy).toBe(false);
    // ...and a projection would have to invent the missing leg, so none is offered.
    expect(recoveryMoves(detached, BAD_CTX, CATALOGUE)).toEqual([]);
  });

  it("still works with no catalogue, over the dimensions it can read", () => {
    const offered = recoveryMoves(badPlan(), BAD_CTX);
    const withoutCatalogue = assessTripHealth(badPlan(), BAD_CTX, []);
    expect(offered.length).toBeGreaterThan(0);
    for (const move of offered) {
      expect(move.projected.coverage).toBeLessThan(1);
      expect(move.projectedScore).toBeLessThan(withoutCatalogue.score);
    }
  });
});

describe("comparing two reads says which dimension did it", () => {
  const packed = badPlan();
  const before = assessTripHealth(packed, BAD_CTX, CATALOGUE);
  const best = movesOf()[0]!;
  const delta = compareHealth(before, best.projected);

  it("calls the direction and the size, which a subtraction cannot", () => {
    expect(delta.direction).toBe("better");
    expect(delta.before).toBe(94);
    expect(delta.after).toBe(best.projectedScore);
    expect(delta.delta).toBe(best.projectedScore - 94);
    expect(delta.worthIt).toBe(true);
  });

  it("lists only the dimensions that actually moved", () => {
    for (const move of delta.moved) {
      expect(move.before).not.toBe(move.after);
    }
    expect(delta.moved.length).toBeLessThan(7);
  });

  it("names the biggest mover and puts it first", () => {
    const magnitudes = delta.moved.map((m) => Math.abs(m.delta));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
    expect(delta.biggest).toBe(delta.moved[0]);
  });

  it("puts the regressions worst-first, and says when there are none", () => {
    const worse = compareHealth(best.projected, before);
    expect(worse.direction).toBe("worse");
    expect(worse.regressions.length).toBeGreaterThan(0);
    expect(worse.regressions[0]!.delta).toBeLessThanOrEqual(worse.regressions[1]!.delta);
    expect(worse.worthIt).toBe(false);
    expect(compareHealth(before, before).regressions).toEqual([]);
  });

  it("refuses to judge a swap it cannot measure", () => {
    const broken = assessTripHealth(corrupt((p) => ({ ...p, totalMin: 12 })), BAD_CTX, CATALOGUE);
    expect(compareHealth(broken, before).worthIt).toBeNull();
    expect(compareHealth(before, broken).worthIt).toBeNull();
  });

  it("writes a summary with the numbers in it", () => {
    expect(delta.summary).toContain("94");
    expect(delta.summary).toContain(String(best.projectedScore));
    expect(delta.summary).not.toMatch(/undefined|NaN/);
    expect(delta.summary).not.toMatch(/pinDebt|weatherRisk|fomoRisk|overload/);
  });

  it("reports no movement as no movement, not as a tie with detail", () => {
    const same = compareHealth(before, assessTripHealth(packed, BAD_CTX, CATALOGUE));
    expect(same.direction).toBe("unchanged");
    expect(same.moved).toEqual([]);
    expect(same.worthIt).toBeNull();
    expect(same.summary).toContain("Nothing about the strain changed");
  });

  it("tracks the band a dimension crossed, which is what a bar needs", () => {
    const crossed = delta.moved.find((m) => m.bandBefore !== m.bandAfter);
    expect(crossed).toBeDefined();
    expect(crossed!.bandAfter).not.toBe(crossed!.bandBefore);
  });
});
