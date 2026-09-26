import { describe, expect, it } from "vitest";

import { Rejection as RejectionSchema, type Plan, type Rejection } from "../../contracts";

import { auditLedger, explainOne, explainPlan, ledgerSummary, outcomeLabel } from "./index";
import type { ExplanationLedger } from "./index";
import {
  CATALOGUE,
  FITS,
  SCORES,
  CTX,
  FIT_SHORE,
  LEDGER,
  OPTS,
  PLAN,
  REJECTIONS,
  SCORE_SHORE,
  catalogue,
  need,
} from "./scenario.fixtures";

describe("all four outcomes, from one realistic plan", () => {
  it("answers for every catalogue entry, with the right outcome for each", () => {
    const outcomes = Object.fromEntries(LEDGER.explanations.map((item) => [item.experienceId, item.outcome]));
    expect(outcomes).toEqual({
      exp_market_01: "selected",
      exp_pottery_02: "selected",
      exp_walk_03: "rejected",
      exp_cafe_04: "rejected",
      exp_shore_05: "considered",
    });
    expect(LEDGER.explanations).toHaveLength(CATALOGUE.length);
  });

  it("audits clean against the data the UI was handed", () => {
    expect(auditLedger(LEDGER, PLAN, CTX, OPTS)).toEqual({ ok: true, violations: [] });
  });

  it("summarises itself in the traveller's terms", () => {
    expect(ledgerSummary(LEDGER)).toBe("2 in the plan, 2 did not fit, 1 scored but not taken.");
    expect(outcomeLabel("considered")).toBe("Why not this one");
  });
});

describe("a selected stop carries its own caveat", () => {
  it("reports a cost inside `why` as neutral, and leads with the signed component", () => {
    const pottery = need("exp_pottery_02");
    const whyCost = pottery.why.find((line) => line.includes("over your budget"));
    expect(whyCost).toBe("₹300 over your budget for four people");
    // The engine does not sign its own prose, and this layer will not sign it for
    // it. Calling "₹300 over your budget" a reason to go would be dishonest.
    expect(pottery.evidence.find((item) => item.claim === whyCost)?.polarity).toBe("neutral");

    // The `ScoreComponent` carries a signed value, and that leads.
    expect(pottery.evidence[0]?.key).toBe("score:price");
    expect(pottery.evidence[0]?.value).toBe(-0.14);
    expect(pottery.evidence[0]?.claim).toBe("₹300 over your limit for four");

    // The engine's own failed check is not dropped either.
    const failed = pottery.evidence.filter((item) => item.polarity === "opposes" && item.key.startsWith("fit:check:"));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.claim).toBe("₹1,800 for four, over your ₹1,500");
    // And the recommendation still stands: the headline is the reason to go.
    expect(pottery.headline).toBe(PLAN.stops[1]?.why[0]);
    expect(pottery.outcome).toBe("selected");
  });

  it("badges a guessed duration and a scraped access record", () => {
    const pottery = need("exp_pottery_02").evidence.filter((item) => item.key.startsWith("provenance:"));
    expect(pottery.map((item) => item.provenance)).toEqual(["inferred", "provider"]);
    expect(pottery[0]?.claim).toBe("How long it takes was guessed from the listing text, not confirmed.");

    const market = need("exp_market_01").evidence.filter((item) => item.key.startsWith("provenance:"));
    // `curated` earns no line, so only the scraped one is reported.
    expect(market.map((item) => item.key)).toEqual(["provenance:accessibility"]);
    expect(market[0]?.claim).toBe("The access details came from OpenStreetMap.");
  });

  it("reproduces the engine's score components one for one, by reference", () => {
    for (const stop of PLAN.stops) {
      const explanation = need(stop.experienceId);
      const scored = explanation.evidence.filter((item) => item.source === "score");
      const ranked = [
        ...stop.score.components.filter((c) => c.value < 0),
        ...stop.score.components.filter((c) => c.value >= 0),
      ];
      expect(scored.map((item) => item.key)).toEqual(ranked.map((c) => `score:${c.key}`));
      expect(scored.map((item) => item.value)).toEqual(ranked.map((c) => c.value));
      expect(scored.map((item) => item.weight)).toEqual(ranked.map((c) => c.weight));
      // The object handed to the UI is the engine's, not a copy of it.
      expect(explanation.score).toBe(stop.score);
    }
  });
});

describe("the considered candidate answers 'why this and not that'", () => {
  it("states the arithmetic and claims no reason the engine did not give", () => {
    const shore = need("exp_shore_05");
    expect(shore.outcome).toBe("considered");
    expect(shore.blocking).toBeNull();
    expect(shore.failures).toBe(0);
    expect(shore.actions).toEqual([]);

    const ranking = shore.evidence.find((item) => item.key === "pack:ranking");
    expect(ranking?.value).toBe(SCORE_SHORE.total);
    expect(ranking?.claim).toBe("Scored 0.77, against 0.82 and 0.64 for the 2 stops you have.");
    expect(shore.evidence.find((item) => item.key === "pack:window")?.claim).toBe(
      "Your 3 h are already committed to 2 stops.",
    );
  });

  it("carries its own fit, so the meter works for a candidate with no stop", () => {
    const byKey = new Map(
      need("exp_shore_05")
        .evidence.filter((item) => item.source === "fit")
        .map((item) => [item.key, item]),
    );
    expect(byKey.get("fit:window")?.value).toBe(FIT_SHORE.totalMin - FIT_SHORE.availableMin);
    expect(byKey.get("fit:cost")?.claim).toBe("₹0 of the ₹1,500 ceiling.");
  });

  it("falls back to the arithmetic for a component the engine left unexplained", () => {
    const shore = need("exp_shore_05");
    for (const component of SCORE_SHORE.components.filter((c) => c.reason === undefined)) {
      const item = shore.evidence.find((entry) => entry.key === `score:${component.key}`);
      expect(item?.value, component.key).toBe(component.value);
      expect(item?.weight, component.key).toBe(component.weight);
      // The label plus the arithmetic. Never a paraphrase of the label alone,
      // which would assert a reason the engine did not give.
      expect(item?.claim, component.key).toBe(
        `${component.label}: +${component.value} at weight ${component.weight}.`,
      );
    }
  });
});

describe("a rejection reports every failure and never oversells a fix", () => {
  it("keeps both failures for the walk, in the order the engine emitted them", () => {
    const walk = need("exp_walk_03");
    expect(walk.failures).toBe(2);
    expect(walk.evidence.filter((item) => item.source === "filter").map((item) => item.key)).toEqual([
      "filter:no_low_stairs",
      "filter:over_budget",
    ]);
    // The gate's check order is the precedence, and the first one is the one that
    // stopped it. The stairs came first and no relaxation fixes them.
    expect(walk.blocking?.key).toBe("filter:no_low_stairs");
    expect(walk.blocking?.value).toBeNull();
    expect(walk.headline).toBe("The walk is steep and has no step-free route, and you asked for low stairs.");
  });

  it("labels the money fix as the one problem out of two that it clears", () => {
    const raise = need("exp_walk_03").actions.find((action) => action.id === "raise_budget");
    expect(raise?.patch).toEqual({ budgetMinor: 240_000 });
    expect(raise?.clears).toBe(1);
    expect(raise?.scope).toBe("partial");
    // The whole point: "add ₹900" on its own would be a lie by omission.
    expect(raise?.label).toBe("Raise the ceiling by ₹900. Fixes 1 of the 2 problems, not all of them.");
    // Still offered, because it is a real mutation and it does fix one of them.
    // Which problem matters is the traveller's call, not ours.
    expect(need("exp_walk_03").actions.map((action) => action.id)).toEqual(["raise_budget", "drop_it"]);
  });

  it("offers no patch at all for a constraint no context change can fix", () => {
    const cafe = need("exp_cafe_04");
    expect(cafe.blocking?.key).toBe("filter:hours_unverified");
    // `relaxable: false` on the engine's own row, and no code-to-patch mapping.
    expect(cafe.actions).toEqual([]);
  });

  it("states a constraint with no figure rather than inventing one", () => {
    for (const id of ["exp_walk_03", "exp_cafe_04"]) {
      const blocking = need(id).blocking;
      expect(blocking?.value, id).toBeNull();
      expect(blocking?.claim, id).not.toMatch(/\d/);
    }
  });
});

describe("the audit holds the ledger to the data", () => {
  it("catches a sentence quoting a figure nothing in the supplied data holds", () => {
    /*
      The real case this rule exists for, and it is real copy. "₹2,400 for four" is
      that candidate's own cost, and the only record of it is the `fits` map —
      because a candidate the gate dropped was never fitted into the plan. Take the
      map away and the sentence becomes unbacked, which is exactly what the audit
      should say rather than what it should paper over.
    */
    const opts = { catalogue, scores: SCORES };
    const audit = auditLedger(explainPlan(PLAN, CTX, opts), PLAN, CTX, opts);

    expect(audit.ok).toBe(false);
    const bad = audit.violations.filter((v) => v.code === "ungrounded_claim");
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.map((v) => v.message).join(" ")).toContain("2,400");
  });

  it("catches a stale ledger after the context changes under it", () => {
    const audit = auditLedger(LEDGER, PLAN, { ...CTX, availableMin: CTX.availableMin + 60 }, OPTS);
    expect(audit.ok).toBe(false);
    expect(audit.violations.map((v) => v.code)).toContain("evidence_drift");
  });

  it("catches a candidate with no answer at all", () => {
    const trimmed: ExplanationLedger = {
      ...LEDGER,
      explanations: LEDGER.explanations.filter((item) => item.experienceId !== "exp_cafe_04"),
      byId: new Map([...LEDGER.byId].filter(([id]) => id !== "exp_cafe_04")),
    };
    expect(auditLedger(trimmed, PLAN, CTX, OPTS)).toEqual({
      ok: false,
      violations: [{ code: "missing_explanation", message: "No explanation for exp_cafe_04.", experienceId: "exp_cafe_04" }],
    });
  });

  it("catches a claim edited away from the numbers", () => {
    const price = need("exp_pottery_02");
    const forged: ExplanationLedger = {
      ...LEDGER,
      explanations: LEDGER.explanations.map((item) =>
        item.experienceId === "exp_pottery_02"
          ? { ...item, evidence: item.evidence.map((e) => (e.source === "score" ? { ...e, value: 9 } : e)) }
          : item,
      ),
    };
    const audit = auditLedger(forged, PLAN, CTX, OPTS);
    expect(audit.ok).toBe(false);
    const drift = audit.violations.find((v) => v.code === "evidence_drift");
    expect(drift?.experienceId).toBe("exp_pottery_02");
    expect(drift?.message).toContain("evidence[");
  });

  it("refuses an answer for something the plan never mentions", () => {
    const ghost = { ...need("exp_cafe_04"), experienceId: "exp_ghost_99" };
    const invented: ExplanationLedger = {
      ...LEDGER,
      explanations: [...LEDGER.explanations, ghost],
      byId: new Map([...LEDGER.byId, ["exp_ghost_99", ghost]]),
    };
    const audit = auditLedger(invented, PLAN, CTX, OPTS);
    expect(audit.ok).toBe(false);
    expect(audit.violations.some((v) => v.code === "unknown_experience")).toBe(true);
  });

  it("catches a plan that both selected and rejected the same place", () => {
    const contradictory: Plan = {
      ...PLAN,
      rejected: [
        ...REJECTIONS,
        RejectionSchema.parse({ experienceId: "exp_pottery_02", code: "sold_out", message: "It is sold out." }),
      ],
    };
    const ledger = explainPlan(contradictory, CTX, OPTS);
    const audit = auditLedger(ledger, contradictory, CTX, OPTS);
    expect(audit.violations.filter((v) => v.code === "plan_contradiction")).not.toEqual([]);
  });

  it("carries the engine's own rescue move up to the ledger, grounded", () => {
    // pinDebt at 0.18 x 62 = 11.16 beats overload at 0.25 x 18 = 4.5.
    expect(LEDGER.rescue).toBe(
      "Drop the pottery booking and put a free street-food stop in its place — it saves ₹1,800.",
    );
    expect(auditLedger(LEDGER, PLAN, CTX, OPTS).ok).toBe(true);
  });
});

describe("one tapped thing, whichever of the four outcomes it has", () => {
  it("answers for a stop, a rejection, a near-miss and an unknown alike", () => {
    expect(explainOne("exp_pottery_02", PLAN, CTX, OPTS)?.outcome).toBe("selected");
    expect(explainOne("exp_walk_03", PLAN, CTX, OPTS)?.outcome).toBe("rejected");
    expect(explainOne("exp_shore_05", PLAN, CTX, OPTS)?.outcome).toBe("considered");
    expect(explainOne("exp_never_heard_of_it", PLAN, CTX, OPTS)).toBeNull();
  });

  it("says plainly that a catalogue entry the data never touched was not considered", () => {
    const untouchedId = "exp_untouched_99";
    const base = CATALOGUE[4];
    if (!base) throw new Error("empty catalogue");
    const ledger = explainPlan({ ...PLAN, rejected: [], stops: [] }, CTX, {
      catalogue: new Map([[untouchedId, { ...base, id: untouchedId }]]),
    });
    const untouched = ledger.byId.get(untouchedId);

    expect(untouched?.outcome).toBe("not_considered");
    // Honest emptiness: the retrieval limit is not a `DiscoveryContext` field, so
    // there is no patch to offer and none is faked.
    expect(untouched?.actions).toEqual([]);
    expect(untouched?.evidence).toHaveLength(1);
    expect(untouched?.headline).toBe("Nothing in this search ever looked at it, so there is no constraint to report.");
  });

  it("is deterministic, and a shuffled catalogue cannot reorder it", () => {
    expect(explainPlan(PLAN, CTX, OPTS)).toEqual(LEDGER);
    const shuffled = { catalogue: new Map([...catalogue].reverse()), fits: FITS, scores: SCORES };
    expect(explainPlan(PLAN, CTX, shuffled)).toEqual(LEDGER);
  });
});



