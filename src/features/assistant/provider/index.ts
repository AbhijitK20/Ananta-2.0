/**
 * Provider selection.
 *
 * Two providers, one choice, made per request rather than at module load: a
 * long-lived Next dev server would otherwise cache a decision taken while the
 * alignment job had not finished yet, and "I re-ran the job and it still says
 * unconfigured" would be a genuinely baffling bug.
 *
 * Selection is capability-based, not preference-based. Nugen wins when it is
 * available, which means a key *and* a customized model id. Everything else gets
 * the deterministic path.
 */
import { DeterministicProvider } from "./deterministic";
import { NugenProvider } from "./nugen";
import type { AIProvider } from "./provider";

export type SelectedProvider = {
  provider: AIProvider;
  /** Why the deterministic path was chosen, empty when Nugen was. */
  degradedReason: string;
};

export async function selectProvider(): Promise<SelectedProvider> {
  const nugen = await NugenProvider.create();
  if (nugen.available) return { provider: nugen, degradedReason: "" };
  return {
    provider: new DeterministicProvider(),
    degradedReason: nugen.health().detail || "customized model unavailable",
  };
}

export { DeterministicProvider } from "./deterministic";
export { NugenProvider, NugenError, readSseDeltas } from "./nugen";
export type {
  AIProvider,
  GenerateRequest,
  GenerateResult,
  ProviderMessage,
  ProviderMetadata,
  StreamHandle,
} from "./provider";
export { assistantNugenConfig, readAssistantAlignment, ASSISTANT_ALIGNMENT_MANIFEST } from "./config";
export type { AssistantAlignment, AssistantNugenConfig } from "./config";
