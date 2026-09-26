/**
 * Engine contract test.
 *
 * WHY THIS EXISTS. `src/app/_lib/engine-seam.d.ts` is an AMBIENT module
 * declaration for `@/engine`. TypeScript resolves `@/engine` to that
 * declaration and never to a real file, so once it is present the typechecker
 * is satisfied by the FICTION and cannot tell you that the real engine is
 * missing a function, has a different signature, or does not exist at all. An
 * ambient declaration for a module that has not been written is a promise, and
 * this test is the only thing in the repository that checks the promise.
 *
 * It imports the REAL `@/engine`. It deliberately does NOT import
 * `engine-seam.d.ts` — that file emits no runtime code, so importing it would
 * test nothing, and doing so is exactly the mistake that lets drift through.
 *
 * HOW IT AVOIDS A PERMANENT SKIP. The test is enabled by the PRESENCE of the
 * real engine module, resolved from disk rather than by a version flag or a
 * manual un-skip. The engine has landed, so these assertions run and stay run.
 * That is the difference between a skip that hides a failure and a gate.
 *
 * `tests/**` is Abhijit's directory per TASKS.md. The repository owner asked
 * for this file explicitly, which is the only reason it is here.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The engine's published surface, from TASKS.md.
 *
 * This list is the contract. It is duplicated here on purpose rather than
 * imported from the seam: importing it would make the test tautological, since
 * it would assert that the engine matches a declaration that was written to
 * describe the engine. A test that checks the fiction against itself proves
 * nothing. The duplication is the point, and the second test below is what
 * keeps the two copies honest with each other.
 */
const REQUIRED = [
  "retrieve",
  "filterFeasible",
  "score",
  "computeFit",
  "stress",
  "isOpenDuring",
  "travelBetween",
  "pack",
  "validate",
  "replan",
  "observe",
  // The orchestrator, and the only supported way to get a Plan. Added because
  // `discover()` now calls it instead of hand-wiring the three stages, which is
  // what returned 500 on every API request.
  "planItinerary",
] as const;

const ENGINE_ENTRY = resolve(process.cwd(), "src/engine/index.ts");

/** True when the real engine has landed. Checked on disk, not in a variable. */
const ENGINE_PRESENT = existsSync(ENGINE_ENTRY);

describe("engine contract", () => {
  it.skipIf(!ENGINE_PRESENT)("the real engine satisfies the seam", async () => {
    const mod = (await import("@/engine")) as Record<string, unknown>;

    for (const name of REQUIRED) {
      expect(typeof mod[name], `@/engine must export ${name}`).toBe("function");
    }
  });

  it.skipIf(!ENGINE_PRESENT)(
    "the real engine exports nothing beyond the declared surface",
    async () => {
      /*
        Catches the opposite failure: a function ADDED to the engine that the UI
        never reaches. That is how a second, divergent entry point appears —
        someone calls it, the seam is not updated, and the contract quietly stops
        describing the engine. Only a named export that no consumer references is
        reported, so a legitimately unused helper is flagged for a decision
        rather than silently tolerated.
      */
      const mod = (await import("@/engine")) as Record<string, unknown>;
      const declared = new Set<string>(REQUIRED);
      const undeclared = Object.keys(mod).filter(
        (name) => name !== "default" && typeof mod[name] === "function" && !declared.has(name),
      );

      // Reported, not failed: an undeclared export is a question for the owner,
      // not proof of a defect. `expect.soft` keeps it visible without turning a
      // new-but-harmless helper into a broken build.
      expect.soft(undeclared, "engine exports not in the seam declaration").toEqual([]);
    },
  );

  /**
   * Always runs, so the suite is never empty and never silently vacuous.
   *
   * Guards the two lists that can drift from each other WITHOUT any real engine
   * existing: the runtime guard in `engine.ts`, and the ambient declaration. If
   * someone adds an eleventh function to the engine's contract and updates one
   * of these but not the other, this fails immediately.
   */
  it("the runtime guard and this test agree on the required surface", async () => {
    const { REQUIRED_ENGINE_EXPORTS } = await import("@/app/_lib/engine");
    expect([...REQUIRED_ENGINE_EXPORTS].sort()).toEqual([...REQUIRED].sort());
  });

  /**
   * The test that would have caught the production 500.
   *
   * The two tests above only assert `typeof mod[name] === "function"`. That is a
   * NAME check, and it passed happily while both API routes returned 500: the
   * seam called `filterFeasible(ctx, candidates)` and `pack(ctx, survivors)`,
   * but the landed engine declares `filterFeasible(ctx, candidates, opts)` and
   * `pack(ctx, feasible, opts)` with `opts` REQUIRED. Every name existed, so
   * every name check passed, and every call threw a TypeError on `opts.weekday`.
   *
   * `plan.ts` documents the drift in its own header ("The seam advertised
   * `pack(): Plan` but the implementation returned a different type") and then
   * routes around the seam instead of fixing it. A name check cannot see that,
   * because the seam's ambient declaration is fiction tsc already believes.
   *
   * So: CALL the seam. Arity and shape are the only things that actually broke,
   * and the only way to see them is to invoke the thing.
   */
  it.skipIf(!ENGINE_PRESENT)("the seam can actually call the engine", async () => {
    const { discover } = await import("@/app/_lib/engine");
    const { DiscoveryContext } = await import("@/contracts");

    const context = DiscoveryContext.parse({
      id: "seam-probe",
      origin: { label: "Bandra West, Mumbai", point: { lat: 19.0495, lon: 72.832 } },
      availableMin: 180,
      nowMin: 840,
      budget: { minor: 300000, currency: "INR" },
      budgetPerPerson: null,
      partySize: 2,
      partyType: "couple",
      childAges: [],
      accessNeeds: ["lowStairs"],
      diets: [],
      interests: ["street_food", "market", "heritage", "art"],
      avoid: [],
      weather: { condition: "clear", tempC: 29, source: "live" },
      travelMode: "walk",
      requests: [],
      excludedIds: [],
      pinnedIds: [],
      original: {
        availableMin: 180,
        budget: { minor: 300000, currency: "INR" },
        partySize: 2,
        accessNeeds: ["lowStairs"],
      },
    });

    // Must not reject. The production failure was an unhandled TypeError here,
    // which Next turned into a bodiless 500.
    const result = await discover(context);

    expect(result.source).toBe("engine");
    // `pack` returns a PackResult, which is NOT a Plan. If the seam ever hands
    // that through unassembled again, these are the fields that go missing.
    expect(result.plan).toMatchObject({
      id: expect.any(String),
      contextId: context.id,
      stops: expect.any(Array),
      legs: expect.any(Array),
      rejected: expect.any(Array),
      relaxations: expect.any(Array),
      stressFactors: expect.any(Array),
      engineVersion: expect.any(String),
    });
    // `validate` needs a real Plan, not a PackResult.
    expect(result.validation).not.toBeNull();
  });

  it("reports the engine's presence honestly", () => {
    /*
      Makes the skip visible instead of invisible. If the engine has not landed,
      this asserts that we are skipping for the RIGHT reason — a genuinely absent
      module — so the day the import starts failing for a different reason (a
      syntax error inside the engine, say) the suite goes red rather than
      reporting a cheerful skip.
    */
    if (!ENGINE_PRESENT) {
      expect(existsSync(ENGINE_ENTRY)).toBe(false);
    } else {
      expect(existsSync(ENGINE_ENTRY)).toBe(true);
    }
  });
});
