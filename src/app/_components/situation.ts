/**
 * The pure helpers `SituationEditor` exposes.
 *
 * They live here, apart from the component, because of a boundary problem the
 * component's own `"use client"` directive created.
 *
 * `SituationEditor` uses `useState`, so it must be a Client Component — without
 * the directive `next build` fails outright. But `ContextBar` is a *server*
 * component and it imports `formatMinutes` from `SituationEditor` to label the
 * time budget. Once the editor became a client module, that call became
 * "Attempted to call formatMinutes() from the server but formatMinutes is on the
 * client", and the home page 500'd.
 *
 * Neither placement is right on its own. A function that a server component calls
 * cannot live in a client module, and a function the editor uses cannot live
 * nowhere. So the logic is here — no React, no directives, no state — and both
 * sides import from here.
 *
 * Re-exported from `SituationEditor` as well, so the client's own importers keep
 * one import path and a future edit that reaches for `toggleNeed` from the
 * component still compiles.
 */

/**
 * "3 h 05 m", "45 min", "2 h".
 *
 * Deliberately NOT `formatDuration` from `@/lib/time`. That one reads "3 hr 5 min"
 * and is used for prose in a plan; this one is an axis label on a slider, where a
 * fixed-width `05` stops the numbers jittering as the thumb moves. Two formats
 * for two audiences, not a duplicate.
 */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  return mins === 0 ? `${hours} h` : `${hours} h ${String(mins).padStart(2, "0")} m`;
}

/**
 * Add or remove one value from a list, immutably.
 *
 * Immutably because the array is a field of the frozen `DiscoveryContext` and the
 * next diff is computed against the previous one; a mutation here would make
 * `patch` and `baseline` the same object and the swap diff would show no change.
 */
export function toggleNeed<T extends string>(
  current: ReadonlyArray<T>,
  need: T,
  on: boolean,
): T[] {
  return on ? [...new Set([...current, need])] : current.filter((item) => item !== need);
}
