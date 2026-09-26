/**
 * The adapter test: the ledger in exactly the shape `WhyLedger` declares.
 *
 * `src/components/fit/WhyLedger.tsx` is the UI stream's file and is not touched
 * here, so this test cannot import its prop type — a feature must not depend on a
 * component, and the dependency only points one way. What it does instead is
 * assert the BEHAVIOURAL contract the component relies on, which is what actually
 * broke before: the component declares `why` and `rejectionActions`, and in the
 * running app nothing passed either, so the "why not that" half of the ledger —
 * the differentiator — rendered nothing at all for a candidate the plan refused.
 *
 * When the UI stream's props are importable again, add one line here:
 *
 * ```ts
 * import type { WhyLedgerProps } from "@/components/fit/WhyLedger";
 * const _typed: WhyLedgerProps = whyLedgerProps(LEDGER, "exp_walk_03", rejectionsById);
 * ```
 *
 * which turns any prop drift into a compile error at `tsc --noEmit` rather than a
 * blank panel at demo time. Until then `PROP_NAMES` below is the same list, and
 * the test that walks it fails loudly if the adapter stops filling one.
 */
import { describe, expect, it } from "vitest";

import type { Rejection } from "../../contracts";

import { explainSwaps, ledgerSummary, outcomeLabel, swapCost, whyLedgerProps, type WhyLedgerProps } from "./index";
import { CTX, LEDGER, OPTS, PLAN, REJECTIONS, SCORE_SHORE, need, rejectionsById } from "./scenario.fixtures";

/** Every prop `WhyLedger` accepts, from its own declaration. */
const PROP_NAMES = ["score", "why", "rejections", "rejectionNames", "rejectionActions", "className"] as const;

describe("the adapter fills the props the component declares", () => {
  it("says nothing at all for something it has no answer for", () => {
    expect(whyLedgerProps(LEDGER, "exp_never_heard_of_it", rejectionsById(REJECTIONS))).toEqual({});
  });

  it("hands a selected stop the engine's own breakdown and its own sentences", () => {
    const props: WhyLedgerProps = whyLedgerProps(LEDGER, "exp_pottery_02", rejectionsById(REJECTIONS));

    // The engine's object, by reference. A copy would be a second source of truth
    // for the arithmetic, which is the one thing the component argues it is not.
    expect(props.score).toBe(PLAN.stops[1]?.score);
    // `PlanStop.why` verbatim, in the engine's order.
    expect(props.why).toEqual(PLAN.stops[1]?.why);
    // A stop has nothing to say about rejections, and no actions exist for it.
    expect(props.rejections).toEqual([]);
    expect(props.rejectionActions).toBeUndefined();
  });

  it("gives a rejected candidate its own rejections, its name, and its actions", () => {
    const fired: { id: string; action: string; patch: unknown }[] = [];
    const props = whyLedgerProps(LEDGER, "exp_walk_03", rejectionsById(REJECTIONS), {
      onAction: (action, id) => fired.push({ id, action: action.id, patch: action.patch }),
    });

    // Both rows, in the engine's order. Collapsing to one would hide a problem.
    expect(props.rejections?.map((row) => row.code)).toEqual(["no_low_stairs", "over_budget"]);
    expect(props.rejectionNames?.exp_walk_03).toBe("Dhobi Ghat guided walk");

    // No "arithmetic" panel for something the plan refused. Rendering a score
    // breakdown under a heading called "Why this" would answer a question nobody
    // asked, and would read as a recommendation.
    expect(props.score).toBeUndefined();

    // The actions the component's buttons need, with the honest partial label.
    const actions = props.rejectionActions?.exp_walk_03 ?? [];
    expect(actions.map((action) => action.label)).toEqual([
      "Raise the ceiling by ₹900. Fixes 1 of the 2 problems, not all of them.",
      "Leave this one out and see what fits instead.",
    ]);

    // And they carry a real `DiscoveryContext` mutation to the caller's handler.
    actions[0]?.onSelect();
    expect(fired).toEqual([
      { id: "exp_walk_03", action: "raise_budget", patch: { budgetMinor: 240_000 } },
    ]);
  });

  it("omits the action buttons entirely when no handler is wired", () => {
    // Buttons that do nothing are worse than no buttons: they read as broken
    // rather than as read-only.
    const props = whyLedgerProps(LEDGER, "exp_walk_03", rejectionsById(REJECTIONS));
    expect(props.rejectionActions).toBeUndefined();
    expect(props.rejections).toHaveLength(2);
  });

  it("supplies ranked lines for a candidate the packer never took", () => {
    const props = whyLedgerProps(LEDGER, "exp_shore_05", rejectionsById(REJECTIONS));

    // It was scored, so the arithmetic is real and available.
    expect(props.score).toBe(SCORE_SHORE);
    // `PlanStop.why` does not exist for something that was never a stop, so the
    // ledger supplies its own ranking — costs first — instead of leaving the
    // section empty.
    expect(props.why?.length).toBeGreaterThan(0);
    expect(props.why).toContain("Matches what you asked for: +0.24 at weight 0.9.");
    // The fit meter is `FitMeter`'s job. Repeating it here would print the same
    // number twice in one sheet.
    expect(props.why?.some((line) => line.includes("to get there"))).toBe(false);
    expect(props.rejections).toEqual([]);
  });

  it("never leaves a prop half-filled", () => {
    for (const id of ["exp_market_01", "exp_pottery_02", "exp_walk_03", "exp_cafe_04", "exp_shore_05"]) {
      const props = whyLedgerProps(LEDGER, id, rejectionsById(REJECTIONS), { onAction: () => {} });
      for (const name of PROP_NAMES) {
        if (name === "className") continue;
        // Widened to `unknown` on purpose: the point of the check is the RUNTIME
        // shape, and typing it as the prop union would let the compiler conclude
        // the branch is unreachable and delete the assertion.
        const value: unknown = props[name];
        if (value === undefined) continue;
        // Only `className` is a string in the component's contract, and this
        // adapter never sets it. A string sitting in a data prop would mean a
        // structured explanation had been flattened into prose somewhere it has to
        // stay inspectable.
        expect(typeof value, `${id}.${name}`).not.toBe("string");
        expect(value, `${id}.${name}`).not.toBeNull();
      }
      // A rejection always has at least one row, so the section is never blank.
      if (need(id).outcome === "rejected") {
        expect((props.rejections ?? []).length, id).toBe(need(id).failures);
      }
    }
  });
});

describe("the ledger describes itself in the traveller's terms", () => {
  it("counts each outcome without inventing a fifth", () => {
    expect(ledgerSummary(LEDGER)).toBe("2 in the plan, 2 did not fit, 1 scored but not taken.");
  });

  it("names the outcome for a sheet title", () => {
    expect(outcomeLabel("selected")).toBe("Why this");
    expect(outcomeLabel("rejected")).toBe("Why not this");
    expect(outcomeLabel("not_considered")).toBe("Why nothing is said about this");
  });

  it("counts the entries the data never touched, when there are any", () => {
    const ledger = { ...LEDGER, explanations: [...LEDGER.explanations] };
    const withUnseen = {
      ...ledger,
      explanations: [
        ...ledger.explanations,
        { ...need("exp_cafe_04"), experienceId: "exp_untouched", outcome: "not_considered" as const },
      ],
    };
    expect(ledgerSummary(withUnseen)).toContain("1 never evaluated");
  });
});

describe("rejections are grouped the way the adapter needs them", () => {
  it("keeps every row for a candidate that failed twice", () => {
    const map = rejectionsById(REJECTIONS);
    expect(map.get("exp_walk_03")?.map((row: Rejection) => row.code)).toEqual(["no_low_stairs", "over_budget"]);
    expect(map.get("exp_cafe_04")).toHaveLength(1);
    expect(map.get("exp_market_01")).toBeUndefined();
  });
});

describe("why the plan changed under the traveller", () => {
  /*
   * The swap: rain starts, the pottery booking is dropped, and the free street
   * walk takes its place. The previous plan is `LEDGER`; the new one is built here
   * so both sides of the difference are real ledgers rather than two shapes.
   */
  const after = explainPlan(
    {
      ...PLAN,
      stops: [PLAN.stops[0]].filter((stop): stop is NonNullable<typeof stop> => stop !== undefined),
      legs: [],
      totalMin: 75,
      totalCost: { minor: 0, currency: "INR" },
      utilisation: 75 / 180,
      rejected: [
        ...PLAN.rejected,
        {
          experienceId: "exp_pottery_02",
          code: "weather_unsafe" as const,
          message: "Heavy rain, and the studio is booked solid.",
          shortfall: null,
          unit: null,
          relaxable: false,
        },
      ],
    },
    CTX,
    OPTS,
  );

  const SWAPS = [
    { removedId: "exp_pottery_02", addedId: "exp_shore_05", reason: "Indoors beat a wet street.", scoreDelta: -0.04 },
  ];

  it("reports the engine's own reason, the signed cost, and both sides", () => {
    const [swap] = explainSwaps(SWAPS, LEDGER, after);
    expect(swap?.reason).toBe("Indoors beat a wet street.");
    expect(swap?.scoreDelta).toBe(-0.04);
    expect(swap?.outcome).toBe("replaced");
    expect(swap?.removed?.experienceId).toBe("exp_pottery_02");
    expect(swap?.added?.experienceId).toBe("exp_shore_05");
    expect(swap?.reasonDetail).toBe("Kumbharwada pottery session made way for Marine Drive shell museum walk.");
  });

  it("does not present a swap that scored worse as a straight upgrade", () => {
    const [swap] = explainSwaps(SWAPS, LEDGER, after);
    expect(swap?.evidence[0]?.key).toBe("swap:score_delta");
    expect(swap?.evidence[0]?.claim).toBe("The swap cost 0.04 of score, and it was still the right call.");
    expect(swap?.evidence[0]?.polarity).toBe("opposes");
  });

  it("carries across the constraint that killed the stop that left", () => {
    const [swap] = explainSwaps(SWAPS, LEDGER, after);
    // The new plan rejected the pottery stop for the weather, and that sentence is
    // the gate's, not this file's.
    const blocking = swap?.evidence.find((item) => item.key === "filter:weather_unsafe");
    expect(blocking?.claim).toBe("Heavy rain, and the studio is booked solid.");
  });

  it("carries the caveat on the stop that arrived, so it is not sold as a clean win", () => {
    const [swap] = explainSwaps(SWAPS, LEDGER, after);
    const caveat = swap?.evidence.find((item) => item.polarity === "opposes" && item.key !== "swap:score_delta");
    expect(caveat?.key).toBe("filter:weather_unsafe");
    // Capped, so a panel cannot be handed twenty lines per swap.
    expect(swap?.evidence.length).toBeLessThanOrEqual(3);
  });

  it("classifies a one-sided change honestly", () => {
    const [addedOnly] = explainSwaps(
      [{ removedId: null, addedId: "exp_shore_05", reason: "Fits what is left.", scoreDelta: 0.1 }],
      LEDGER,
      after,
    );
    expect(addedOnly?.outcome).toBe("added");
    expect(addedOnly?.removed).toBeNull();

    const [removedOnly] = explainSwaps(
      [{ removedId: "exp_pottery_02", addedId: null, reason: "Booked solid.", scoreDelta: -0.64 }],
      LEDGER,
      after,
    );
    expect(removedOnly?.outcome).toBe("removed");
    expect(removedOnly?.added).toBeNull();
    expect(removedOnly?.reasonDetail).toContain("nothing replaced it");
  });

  it("yields null rather than a guess for a side it has no ledger for", () => {
    const [swap] = explainSwaps(
      [{ removedId: "exp_never_existed", addedId: "exp_shore_05", reason: "Better fit.", scoreDelta: 0 }],
      LEDGER,
      after,
    );
    expect(swap?.removed).toBeNull();
    expect(swap?.added?.experienceId).toBe("exp_shore_05");
  });

  it("sums the score cost of a set of swaps, signed", () => {
    const swaps = explainSwaps(
      [
        { removedId: "exp_pottery_02", addedId: "exp_shore_05", reason: "a", scoreDelta: -0.04 },
        { removedId: null, addedId: "exp_cafe_04", reason: "b", scoreDelta: 0.12 },
      ],
      LEDGER,
      after,
    );
    expect(swapCost(swaps)).toBe(0.08);
    expect(swapCost([])).toBe(0);
  });
});
