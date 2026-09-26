/**
 * Ambient declaration for the engine seam.
 *
 * DELETE THIS FILE THE MOMENT `src/engine/index.ts` LANDS.
 *
 * NAMING. This file is `engine-seam.d.ts`, NOT `engine.d.ts`. TypeScript pairs
 * a sibling `foo.d.ts` with `foo.ts` as its declaration companion, so naming it
 * `engine.d.ts` silently made it the types FOR `engine.ts` instead of an
 * ambient module declaration, and the seam failed to resolve with no error
 * pointing at the cause.
 *
 * WHY IT EXISTS. `src/app/_lib/engine.ts` imports the engine dynamically so
 * the app runs before Abhijit's stream is merged. TypeScript cannot resolve a
 * module that does not exist, so the dynamic import is a build error rather
 * than a runtime branch — which means the "no edit on integration" property
 * cannot be expressed without a declaration.
 *
 * This file declares the module's SHAPE, transcribed from the public API in
 * TASKS.md. It is deliberately a declaration and not an implementation: the
 * app cannot accidentally satisfy the engine's contract by importing this,
 * because a `.d.ts` emits nothing.
 *
 * WHY IT CANNOT DRIFT SILENTLY. Two independent checks cover the gap:
 *  - `loadEngine()` checks at runtime that all eleven exported functions
 *    actually exist and are functions. A partial engine fails loudly on the
 *    first request rather than halfway through producing a wrong answer.
 *  - `satisfies EngineApi` in engine.ts checks this declaration against the
 *    shape the rest of the app assumes, so a change to the seam breaks
 *    typecheck.
 * If the real engine's signatures differ from TASKS.md, Abhijit's own
 * typecheck is what catches it, and the fix is to delete this file and correct
 * the seam.
 */
declare module "@/engine" {
  import type {
    ContextChange,
    DiscoveryContext,
    Experience,
    Plan,
    ReplanResult,
    ValidationResult,
  } from "@/contracts";

  export function retrieve(input: {
    context: DiscoveryContext;
    catalogue: Experience[];
    limit?: number;
  }): Experience[];

  export function filterFeasible(
    ctx: DiscoveryContext,
    items: Experience[],
  ): { passed: string[]; rejected: Plan["rejected"] };

  export function score(
    ctx: DiscoveryContext,
    items: Experience[],
    weights: unknown,
  ): Plan["stops"][number]["score"][];

  export function pack(ctx: DiscoveryContext, items: Experience[]): Plan;

  export function validate(plan: Plan): ValidationResult;

  export function replan(
    prev: Plan,
    ctx: DiscoveryContext,
    change: ContextChange,
  ): ReplanResult;

  export function computeFit(
    ctx: DiscoveryContext,
    exp: Experience,
  ): Plan["stops"][number]["fit"];

  export function stress(plan: Plan, ctx: DiscoveryContext): {
    score: number;
    factors: Plan["stressFactors"];
  };

  export function isOpenDuring(
    hours: unknown,
    fromMin: number,
    toMin: number,
    lat: number,
    lon: number,
  ): { open: boolean; status: "ok" | "partial" | "unparsable" | "absent" };

  export function travelBetween(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    mode: "walk" | "auto" | "transit" | "ferry",
    atMin: number,
  ): Plan["legs"][number];

  export function observe(profile: unknown, event: unknown): unknown;
}
