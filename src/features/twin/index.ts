/**
 * `src/features/twin/**` — the Weather-Driven Digital Twin.
 *
 * An *enhancement* to the existing solution, not a new application. The entities are
 * the 4,596 `Experience` rows the planner already searches, the edges are the
 * `transitCorridors` the city manifest already declares, the evidence is the 291
 * reviews and 40 events already committed to `content/`, and the output is a `Plan`
 * the real `planItinerary()` produced. Nothing here re-implements retrieval, a fit, a
 * gate, a pack or an objective.
 *
 * Nine modules, in dependency order:
 *
 *   hazards.ts    the vocabulary: 5 hazards, 6 channels, 7 entity classes
 *   scenario.ts   the what-if input in real units, and the narrowing to `WeatherNow`
 *   social.ts     social signals: the live public feed and the committed corpus
 *   corpus.ts     the domain corpus the Nugen alignment trains on
 *   graph.ts      the entity graph, and the adjacency the cascade walks
 *   impact.ts     the prior, and the correction the observations earn
 *   propagate.ts  the four cascade orders, and the uncertainty intervals
 *   observe.ts    the senses: live weather + social + the aligned model
 *   apply.ts      the re-solve: twin catalogue + twin context -> the real engine
 *
 * Typical wiring, in one place in `src/app`:
 *
 * ```ts
 * const manifest = await readAlignmentManifest();
 * const signals  = await corpusSignals();
 * const model    = fitImpactModel(signals, opennessOf, classOfSignal);
 * const graph    = buildGraph(experiences, cityManifest);
 *
 * const observation = await observe({ point, scenario: fromParams, graph, model, corpusSignals: signals, manifest });
 * const twin        = simulate(toSimulateOptions(observation, graph, model));
 * const applied     = applyTwin({ context, catalogue: experiences, twin });
 * const delta       = diffPlans(baseline, applied.result, closedById(applied.closed));
 * ```
 *
 * Four invariants, each enforced by a test rather than by a comment:
 *
 *  1. **No LLM in the decision path.** The aligned model classifies free text; the
 *     deterministic engine computes every number and re-solves the plan.
 *  2. **Nothing throws.** A dead feed, a dead API and a missing aligned model all
 *     degrade to the deterministic path, and `provenance` says which ran.
 *  3. **A clear sky is a no-op.** All six channels stay at 1.0 and the plan is
 *     byte-identical to the baseline.
 *  4. **The live plan is untouchable.** `simulate` and `applyTwin` are pure and
 *     return new objects.
 */
export {
  CHANNEL_KINDS,
  HAZARD_KINDS,
  SEVERITY_WORDS,
  classify,
  composeChannels,
  neutralChannels,
  opennessOf,
  round2,
  type ChannelKind,
  type ChannelSet,
  type ChannelState,
  type EntityClass,
  type HazardKind,
  type ImpactSeverity,
} from "./hazards";

export {
  BASELINE_SCENARIO,
  FLOOD_MAX_CM,
  RAIN_MAX_MMH,
  SCENARIO_BOUNDS,
  TEMP_MAX_C,
  TEMP_MIN_C,
  WIND_MAX_KMH,
  conditionOf,
  driversOf,
  monthOf,
  normalizeScenario,
  paramsFromScenario,
  scenarioFromParams,
  weatherNowOf,
  weekdayOf,
  type HazardDrivers,
  type WeatherScenario,
} from "./scenario";

export {
  classifyReport,
  liveSocialSource,
  resolveSocial,
  signalsFromEvents,
  signalsFromReviews,
  type LiveSocialOptions,
  type SignalSource,
  type SocialRequest,
  type SocialSignal,
  type SocialSource,
} from "./social";

export {
  benchmarkFrom,
  buildCorpus,
  cancellationDocument,
  neighbourhoodDocuments,
  propagationDocument,
  taxonomyDocument,
  type BenchmarkSample,
  type CorpusDocument,
} from "./corpus";

export {
  adjacencyOf,
  buildGraph,
  haversineMetres,
  type CityManifest,
  type EdgeKind,
  type EntityGraph,
  type GraphEdge,
  type GraphNode,
  type TransitCorridor,
} from "./graph";

export {
  IMPACT_MODEL_VERSION,
  SHELTER_BINS,
  cellFor,
  directImpact,
  fitImpactModel,
  shelterBinOf,
  type Cell,
  type DirectImpact,
  type ImpactModel,
  type ShelterBin,
} from "./impact";

export {
  CASCADE_ORDERS,
  simulate,
  type CascadeOrder,
  type CascadeStep,
  type CorridorImpact,
  type HazardState,
  type NodeImpact,
  type SimulateOptions,
  type TwinProvenance,
  type TwinState,
} from "./propagate";

export {
  corpusSignals,
  deterministicSeverities,
  observe,
  readAlignmentManifest,
  searchQueryFor,
  toSimulateOptions,
  type Observation,
  type ObserveOptions,
} from "./observe";

export {
  SHUT_AT,
  applyTwin,
  buildTwinContext,
  diffPlans,
  twinFit,
  type ApplyOptions,
  type ApplyResult,
  type PlanDelta,
} from "./apply";
