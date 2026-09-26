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
  REST_GAP_MIN,
  leadViolation,
  legsOf,
  loadBudget,
  loadOf,
  packWithinLoad,
  replanWithinLoad,
  toleranceOf,
  walkCapOf,
  type LoadBudget,
  type LoadCode,
  type LoadDrop,
  type LoadExclusion,
  type LoadMetrics,
  type LoadReport,
  type LoadSolve,
  type LoadViolation,
  type ReplanUnderLoad,
} from "./fatigue";

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
  OWN_CONFIDENCE,
  PATCH_UNREACHABLE,
  catalogueResolver,
  elderOp,
  exclusionNote,
  invertTurn,
  ordinalResolver,
  planTurn,
  readTurn,
  summariseSwaps,
  turnReason,
  type CopilotTurn,
  type NamedPlace,
  type SwapNames,
  type TurnContext,
  type TurnReason,
  type TurnReading,
  type TurnRecord,
} from "./copilot";

export {
  handleChat,
  mockIntentParser,
  type ChatOutcome,
  type IntentParser,
} from "./chat";

export {
  asksOf,
  assessDemand,
  captureUnmet,
  createLedger,
  describeSignal,
  mergeRejections,
  rankBlockers,
  recordDemand,
  signalId,
  topSignals,
  type BlockedOn,
  type BlockingCodeCount,
  type BlockingShortfall,
  type DemandAsks,
  type DemandAssessment,
  type DemandLedger,
  type DemandMeta,
  type DemandObservation,
  type DemandSignal,
  type DemandStatus,
  type DiscoveryReport,
  type Range,
} from "./unmet";

// Repairing a trip that is already under way: the clock, the locks, the places
// that are gone, and the two invariants a plan must not break on the way through.
export {
  gone,
  readTrip,
  repair,
  repairOps,
  upcoming,
  type GoneCause,
  type GonePlace,
  type ReasonSource,
  type RepairEvent,
  type RepairExplanation,
  type RepairGap,
  type RepairGuarantees,
  type RepairOutcome,
  type TripState,
} from "./repair";

// The eight conditions from FEATURES §3, and where each one is actually reachable.
export {
  ALL_CONDITION_IDS,
  CONDITIONS,
  CONDITION_COVERAGE,
  MORE_TIME_MIN,
  REPAIR_TRIGGERS,
  TRIGGER_BY_ID,
  runTrigger,
  type Condition,
  type RepairTrigger,
  type TriggerInput,
} from "./triggers";
