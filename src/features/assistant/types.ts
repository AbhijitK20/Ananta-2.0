/**
 * The assistant's wire types.
 *
 * Kept apart from `src/contracts` on purpose. That file is the frozen contract
 * for the planning engine — `Experience`, `DiscoveryContext`, `Rejection` — and
 * every change to it is a change to the engine's blast radius. A chat transcript
 * is not part of that contract and has no business widening it, so it lives here
 * with the feature that owns it.
 *
 * The one thing borrowed from the contract is the vocabulary. The assistant
 * refuses to invent its own words for the app's concepts: a "fit meter" is the
 * engine's `FitMeter`, a "rejection" is a `Rejection`, a "time budget" is
 * `availableMin`. The system prompt and the dataset both enforce this, and
 * `safety.ts` checks the response for terms the app does not have.
 */

export type MessageRole = "user" | "assistant" | "system";

/**
 * Why a message may be incomplete.
 *
 * `streaming` is persisted BEFORE the first token and rewritten in a finally, so
 * an aborted or crashed request leaves an honestly-labelled `stopped`/`error`
 * row rather than a half answer that reads as finished. The UI renders the
 * difference; a silent truncation is indistinguishable from a short reply.
 */
export type MessageStatus = "complete" | "streaming" | "stopped" | "error";

export type TokenUsage = {
  prompt?: number;
  completion?: number;
  total?: number;
};

export type Conversation = {
  id: string;
  ownerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

export type Message = {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: string;
  modelId: string | null;
  tokenUsage: TokenUsage | null;
  latencyMs: number | null;
  metadata: Record<string, unknown>;
};

/** One SSE frame on the wire. Mirrors the shape the route writes, exactly. */
export type StreamEvent =
  | { type: "start"; conversationId: string; messageId: string; model: string; source: ProviderSource }
  | { type: "delta"; text: string }
  | { type: "message"; message: Message }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "done"; latencyMs: number };

/**
 * Which implementation answered.
 *
 * Surfaced in the UI on every reply. A prediction whose provenance is invisible
 * is indistinguishable from a guess, which is the argument `src/llm/nugen.ts`
 * already makes about the twin's hazard calls.
 */
export type ProviderSource = "nugen-customized" | "deterministic";

/** Public health surface. Contains no key material by construction. */
export type ProviderHealth = {
  provider: "nugen" | "deterministic";
  configured: boolean;
  /** The model id that would be sent, or null when none is available. */
  model: string | null;
  /** True only when `model` came from a real alignment record, not a base model. */
  customized: boolean;
  status: "ready" | "degraded" | "unconfigured";
  /** Why `status` is not "ready". Empty when it is. */
  detail: string;
  checkedAt: string;
};
