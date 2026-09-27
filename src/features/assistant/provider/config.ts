/**
 * Configuration for the assistant's Nugen provider.
 *
 * The one rule this file exists to enforce: **the assistant only ever runs on a
 * customized model.** It does not fall back to a base model, and it does not
 * treat "no customized model" as "use the base model anyway" — that would make
 * the customization claim unfalsifiable, because a demo would look identical
 * whether or not the alignment job had ever run.
 *
 * Resolution order for the model id:
 *   1. `NUGEN_CUSTOMIZED_MODEL_ID`           — explicit, wins, for per-env deploys
 *   2. the alignment record on disk          — what `npm run assistant:align` wrote
 *   3. null                                  — assistant runs deterministic-only
 *
 * A base model id is never in that list. `NUGEN_BASE_MODEL` exists only to
 * record what the alignment ran against, and is never sent as `model`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://api.nugen.in/api/v3";

/** Written by `scripts/assistant-align.ts`. Absent means "never aligned". */
export const ASSISTANT_ALIGNMENT_MANIFEST = "data/reference/nugen/assistant-alignment.json";

export type AssistantAlignment = {
  alignment_id: string;
  model_id: string;
  base_model_id: string;
  status: string;
  aligned_at: string;
  dataset_sha256: string;
  train_examples: number;
  validation_examples: number;
  benchmark_id: string | null;
  note: string;
};

export type AssistantNugenConfig = {
  enabled: boolean;
  apiKey: string | undefined;
  baseUrl: string;
  /** The customized model, or null. Never a base model. */
  modelId: string | null;
  baseModelId: string;
  alignmentId: string | null;
  timeoutMs: number;
  /** Why the model id is null, for the health endpoint. */
  reason: string;
};

function envStr(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function isAssistantNugenOff(): boolean {
  const flag = envStr("NUGEN_OFF")?.toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") return true;
  const generic = envStr("NUGEN")?.toLowerCase();
  return generic === "0" || generic === "off" || generic === "no" || generic === "false";
}

let cachedManifest: { at: number; value: AssistantAlignment | null } | undefined;

/**
 * Read the alignment record, memoised for a second.
 *
 * A short cache rather than a permanent one because `scripts/assistant-align.ts`
 * writes this file and the Next dev server should pick up a fresh alignment
 * without a restart. A permanent cache would make "I re-ran the job and nothing
 * changed" a debugging session instead of a one-second wait.
 */
export async function readAssistantAlignment(root = process.cwd()): Promise<AssistantAlignment | null> {
  const now = Date.now();
  if (cachedManifest && now - cachedManifest.at < 1000) return cachedManifest.value;
  let value: AssistantAlignment | null = null;
  try {
    const raw = await readFile(join(root, ASSISTANT_ALIGNMENT_MANIFEST), "utf8");
    const parsed = JSON.parse(raw) as Partial<AssistantAlignment>;
    // A record without a model id is not an alignment. Treat it as absent rather
    // than passing `undefined` downstream as if it were an id.
    value =
      typeof parsed.model_id === "string" && parsed.model_id.length > 0
        ? (parsed as AssistantAlignment)
        : null;
  } catch {
    value = null;
  }
  cachedManifest = { at: now, value };
  return value;
}

export async function assistantNugenConfig(): Promise<AssistantNugenConfig> {
  const apiKey = envStr("NUGEN_API_KEY");
  const off = isAssistantNugenOff();
  const alignment = await readAssistantAlignment();
  const explicit = envStr("NUGEN_CUSTOMIZED_MODEL_ID");

  const timeout = Number.parseInt(envStr("NUGEN_TIMEOUT_MS") ?? "20000", 10);

  return {
    enabled: !off && Boolean(apiKey),
    apiKey,
    baseUrl: (envStr("NUGEN_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    modelId: explicit ?? alignment?.model_id ?? null,
    baseModelId: envStr("NUGEN_BASE_MODEL") ?? alignment?.base_model_id ?? "unknown",
    alignmentId: alignment?.alignment_id ?? null,
    timeoutMs: Number.isFinite(timeout) ? Math.min(120_000, Math.max(500, timeout)) : 20_000,
    reason: off
      ? "NUGEN_OFF is set"
      : !apiKey
        ? "NUGEN_API_KEY is not set"
        : explicit
          ? ""
          : alignment
            ? ""
            : "no customized model; run `npm run assistant:align`",
  };
}
