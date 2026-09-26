/**
 * The six "reality changed" triggers, as data.
 *
 * WHY THIS IS NOT IN `src/app/_fixtures/index.ts`. That module imports eight
 * contract schemas as VALUES and calls `.parse()` on them at module scope, so
 * anything importing one constant from it drags the entire 824-line / 35 KB zod
 * contract into the browser bundle. `DiscoverySurface` did exactly that to read
 * a six-element array of `{key, label, detail}` strings, and none of it
 * tree-shook because a zod schema evaluated at module scope is not a pure
 * constant as far as a bundler is concerned.
 *
 * So the array lives alone here, with no imports at all. The fixtures module
 * still owns the data it is for; this is the part the client needs.
 *
 * ponytail: ceiling — these are hard-coded rather than editable, which is
 * correct for a demo script and wrong for a product where a provider or city
 * planner configures their own triggers. Move them behind the contract when
 * that is a real requirement.
 */
export const CONTEXT_TRIGGERS = [
  { key: "rain", label: "It started raining", detail: "Outdoor loses, indoor wins" },
  { key: "time", label: "We lost 90 minutes", detail: "Fewer stops, closer" },
  { key: "soldout", label: "This one's sold out", detail: "Find a replacement" },
  { key: "budget", label: "Budget is now ₹600", detail: "Prune and show what was cut" },
  { key: "restroom", label: "Need a bathroom", detail: "Filter to on-site" },
  { key: "exhausted", label: "We're exhausted", detail: "Fewer transfers, longer dwell" },
] as const;

export type ContextTrigger = (typeof CONTEXT_TRIGGERS)[number];
