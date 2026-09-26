/**
 * `src/features/discovery/**` — the traveller side: context editor, replanner,
 * plan diff, "reality changed" panel, suggestion chips, chat sidecar adapter.
 *
 * The engine stays authoritative. Nothing in this folder computes a fit, a score,
 * a rejection or an objective; it calls the engine, guards the result, and turns
 * it into something renderable.
 *
 * Typical wiring, in one place in `src/app`:
 *
 * ```ts
 * const session = createSession({ engine, seed, catalogue, weights });
 * const first = discover(engine, session);
 * const outcome = applyAction(engine, first.session, ACTION_BY_ID.get("rain")!);
 * outcome.ok && render(outcome.reality);   // REMOVED / ADDED / UNCHANGED / REASON
 * ```
 */
export type { EnginePort, TravelMode } from "./engine";
export { hm, money, plural } from "./format";

export {
  DEFAULT_PREFS,
  FLOOR_MIN,
  INDOOR_TOKEN,
  WALK_TOKENS,
  WEATHER_TOKENS,
  applyOp,
  applyOps,
  applyPatch,
  classifyChange,
  createContext,
  narrativeFor,
  opsFromPatch,
  slug,
  type ContextSeed,
  type DiscoveryPrefs,
  type EditorChange,
  type EditorOp,
  type EditorState,
  type WalkingTolerance,
  type WeatherSensitivity,
} from "./context";

export {
  ACTION_BY_ID,
  ALL_ACTIONS,
  REALITY_TRIGGERS,
  SUGGESTIONS,
  runAction,
  type ActionInput,
  type DiscoveryAction,
} from "./actions";

export {
  diffPlans,
  indexCatalogue,
  type DiffInput,
  type PlanDiff,
  type StopDiff,
} from "./diff";

export {
  SWAP_BUDGET,
  buildRealityChanged,
  intentLines,
  type PlanShape,
  type RealityChanged,
  type RealityInput,
} from "./reality";

export {
  actionInput,
  applyAction,
  applyEditorChange,
  applyOpsAndReplan,
  createSession,
  discover,
  replan,
  type ActionOutcome,
  type Admitted,
  type DiscoverOutcome,
  type DiscoverySession,
  type ReplanOutcome,
  type SessionInit,
  type Violation,
} from "./replanner";

export {
  CONFIDENCE_GATE,
  handleChat,
  mockIntentParser,
  type ChatOutcome,
  type IntentParser,
} from "./chat";
