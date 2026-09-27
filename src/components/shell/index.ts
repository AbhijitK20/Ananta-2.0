/**
 * `DiscoverySearch` used to live here. It was deleted rather than mounted, and
 * the reason is worth keeping:
 *
 * Its own header comment claimed that every chip "maps onto the parameter names
 * `computeDiscovery` actually reads" — `where`, `window`, `budget`, `rain`,
 * `category`, `vegetarian`, `halal`, `wheelchair`, `travellers`. Not one of them
 * was read. The engine reads `t`, `b`, `p`, `pt`, `m`, `w`, `needs`, `at`, `i`,
 * `avoid`, `ages` and `x`. So every chip was a link to the default plan wearing
 * a label, and the comment claimed the opposite, which is worse than the dead
 * links.
 *
 * Free-text location resolution now lives in `src/app/_lib/place.ts` and its
 * input lives in the situation editor on `/tune`, beside every other input,
 * where the traveller is already changing the rest of their situation.
 */
export { BottomNav } from "./BottomNav";
