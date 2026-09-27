/**
 * `AIProvider` — the one seam the assistant's orchestration talks to.
 *
 * There are two implementations, `nugen.ts` and `deterministic.ts`, and that is
 * what makes the interface worth having rather than speculative: the orchestrator
 * cannot tell them apart, so the degraded path is exercised by every test that
 * does not stub a provider, and `NUGEN_OFF=1` is a supported mode rather than an
 * outage.
 *
 * The contract deliberately does NOT include `regenerate`, `delete` or `rename`.
 * Those are conversation operations and belong to the store, not to a thing that
 * turns tokens into text. A provider that could delete a message would be a
 * provider with write access to the database.
 */

export type GenerateRequest = {
  /** Fully assembled messages, system prompt first. Already ordered by `context.ts`. */
  messages: ProviderMessage[];
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
};

export type ProviderMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type GenerateResult = {
  text: string;
  modelId: string;
  usage: { prompt?: number; completion?: number; total?: number } | null;
  latencyMs: number;
  finishReason: "stop" | "length" | "aborted" | "error";
};

/**
 * A stream of text deltas. Yields `""` never — an empty delta is noise, and the
 * route filters rather than trusting the provider.
 */
export type StreamHandle = AsyncIterable<string>;

export type ProviderMetadata = {
  source: "nugen-customized" | "deterministic";
  /** The model id sent as `model`, or null on the deterministic path. */
  modelId: string | null;
  /** Base model the customization ran against, for provenance display. */
  baseModelId: string | null;
  /** Alignment record the model id came from, when there is one. */
  alignmentId: string | null;
  promptVersion: string;
};

export interface AIProvider {
  readonly name: string;
  /** False when the provider cannot serve at all (no key, no customized model). */
  readonly available: boolean;
  metadata(): ProviderMetadata;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /**
   * Streams deltas. The returned handle ends when the provider is done, and
   * throws on provider failure — the route owns the error frame, so a provider
   * that swallowed its own errors would produce a `done` event for an empty
   * answer.
   */
  stream(request: GenerateRequest): StreamHandle;
  healthCheck(): Promise<ProviderHealthResult>;
}

export type ProviderHealthResult = {
  ok: boolean;
  detail: string;
  latencyMs: number;
};
