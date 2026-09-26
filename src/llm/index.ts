/**
 * The AI layer's public surface. Two functions and one batch job, plus the
 * diagnostics the app and the eval harness need.
 *
 * The import-boundary rule this layer exists to enforce: nothing here imports
 * `src/engine`, `src/db`, or anything that packs a plan. The LLM is downstream
 * of the traveller's words and upstream of nothing but a context patch.
 */

export { parseIntent, parseIntentDetailed, deterministicDecision, extractSignals, patchFromSignals, CONFIDENCE_GATE } from "./nlu";
export type { ParseIntentResult, Signals } from "./nlu";

export { narrate, narrateDetailed, deterministicNarration, buildFactSheet } from "./narrate";
export type { NarrateOptions, NarrateResult } from "./narrate";

export { enrichOne, enrichMany, applyInference, validateInference, candidateBlob, ENRICH_FIELDS } from "./enrich";
export type {
  ApplyResult,
  EnrichBatchOptions,
  EnrichCandidate,
  EnrichField,
  EnrichRejection,
  EnrichResult,
  Inference,
  ValidatedInference,
} from "./enrich";

export { callStructured, callText, toEnvelope, resetBreakers } from "./client";
export type { Attempt, CallOptions, LlmResult, StructuredCall } from "./client";

export { llmConfig, isLlmOff, apiKey } from "./config";
export type { LlmConfig, LlmRole } from "./config";

export {
  sanitizeUserText,
  sanitizePatch,
  mergePatch,
  isEmptyPatch,
  cleanList,
  hasInjectionRisk,
  groundedFigures,
  unsupportedFigures,
  capProse,
  capSuggestions,
  LIMITS,
  MAX_USER_TEXT,
} from "./guardrails";
export type { Patch } from "./guardrails";

export { setLogSink } from "./log";
export { formatMinutes, formatMoney, formatClock, sentence } from "./format";
