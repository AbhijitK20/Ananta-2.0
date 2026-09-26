/**
 * Client-side draft state: the places a traveller has saved, and the places they
 * have put in a draft plan.
 *
 * This is UI state and nothing else. It deliberately does NOT evaluate whether a
 * plan is affordable, reachable or time-feasible — that is the engine's job, in
 * `src/engine`. An earlier draft of this file (from the `ananta` prototype)
 * carried `evaluatePlan`, `generatePlanVariants`, `parsePrice` and
 * `parseDurationMinutes` alongside these four functions, which was two problems
 * at once: it reimplemented planning the engine already owns, and it did so by
 * regex-parsing *display strings* (`parsePrice("Free") === 0`). A plan that
 * claims to cost nothing because a label said "Free" is not a plan, it is a
 * number that reads well. Kept here deliberately: four functions, no planning.
 *
 * Storage keys are namespaced to this app and are NOT carried over from the
 * prototype, because the identifier space changed underneath them — the
 * prototype's ids pointed into a generated dataset we no longer use. Reusing the
 * old keys would resurrect ids that resolve to nothing.
 */

const PLAN_KEY = "travelbuddy-draft-plan";
const SAVED_KEY = "travelbuddy-saved";

const CHANGE_EVENT = "travelbuddy-draft-change";

function readIds(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // A corrupt or hand-edited value must not take the page down with it. An
    // empty draft is a recoverable state; a thrown parse error during render is
    // not.
    return [];
  }
}

function writeIds(key: string, ids: string[]): void {
  window.localStorage.setItem(key, JSON.stringify([...new Set(ids)]));
  // Same-window subscribers (nav badge, other buttons) are not notified by the
  // `storage` event, which only fires in *other* tabs. Dispatch our own so a
  // single page can stay consistent.
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function readPlan(): string[] {
  return readIds(PLAN_KEY);
}

export function writePlan(ids: string[]): void {
  writeIds(PLAN_KEY, ids);
}

export function readSaved(): string[] {
  return readIds(SAVED_KEY);
}

export function writeSaved(ids: string[]): void {
  writeIds(SAVED_KEY, ids);
}

/** Toggle one id in a list, returning the new list. */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((each) => each !== id) : [...ids, id];
}

export const PLAN_CHANGE_EVENT = CHANGE_EVENT;
