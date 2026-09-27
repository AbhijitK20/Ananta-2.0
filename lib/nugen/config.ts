/**
 * Which model the assistant is allowed to talk to, and how we know.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE IN THIS FILE
 * ---------------------------------------------------------------------------
 *
 * A base model id is never a legal answer from `resolveModel()`.
 *
 * The resolution order is:
 *
 *     1. `NUGEN_CUSTOMIZED_MODEL_ID`   — an explicit override, for a demo machine
 *     2. `data/reference/nugen/alignment.json` → `.model_id` — written by
 *        `npm run nugen:align` when a training run actually completes
 *     3. `null` — no aligned model exists
 *
 * There is no fourth step. Not a base model, not a "reasonable default", not a
 * constant at the bottom of the file.
 *
 * The reason is that this project is required to demonstrate a real model
 * alignment, and the only way that claim can be checked is if it is possible to
 * ask the running app which model it is using and get an answer that cannot be
 * faked. If a base model were the fallback, the app would answer questions
 * perfectly well and the alignment would be unfalsifiable — a demo that looks
 * identical with and without the mandatory technology, which is precisely what
 * the requirement exists to rule out.
 *
 * So the failure mode is a loud one. With no aligned model the assistant
 * reports that it has none, `/api/health` answers `customized: false`, and
 * `confidence_score` is absent from every response. Those are the symptoms to
 * look for if the alignment has not been run.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where `npm run nugen:align` writes the id of a completed training run. */
const RECORD_PATH = join(process.cwd(), "data", "reference", "nugen", "alignment.json");

export type AlignmentRecord = {
  model_id: string;
  alignment_id: string;
  base_model_id: string;
  alignment_name: string;
  status: string;
  completed_at: string | null;
  document_count: number;
  document_chars: number;
  gpu_training_completed: boolean;
};

export type ModelStatus =
  | { customized: true; model: string; source: "env" | "record"; alignment: AlignmentRecord | null }
  | { customized: false; model: null; source: null; alignment: null; reason: string };

/**
 * Read the alignment record, if a training run has ever completed.
 *
 * Returns null rather than throwing on a missing or malformed file: the absence
 * of an alignment is a normal state (it is the state before the first successful
 * run, and it is the state on every machine but the one that trained the model),
 * not an error. The caller turns it into `customized: false`.
 */
export function readAlignment(): AlignmentRecord | null {
  if (!existsSync(RECORD_PATH)) return null;
  try {
    const rec = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as AlignmentRecord;
    // A record that claims a model but never finished training is not evidence of
    // anything, so it is treated as no record. `npm run nugen:align` only writes
    // on COMPLETED, but the file is a build output a person can also edit.
    if (!rec?.model_id || (rec.status !== "READY" && rec.status !== "COMPLETED") || rec.gpu_training_completed !== true) return null;
    return rec;
  } catch {
    return null;
  }
}

export function resolveModel(): ModelStatus {
  const fromEnv = process.env.NUGEN_CUSTOMIZED_MODEL_ID?.trim();
  if (fromEnv) {
    return { customized: true, model: fromEnv, source: "env", alignment: readAlignment() };
  }

  const record = readAlignment();
  if (record) {
    return { customized: true, model: record.model_id, source: "record", alignment: record };
  }

  return {
    customized: false,
    model: null,
    source: null,
    alignment: null,
    reason: existsSync(RECORD_PATH)
      ? "the alignment record exists but does not describe a completed training run"
      : "no alignment record — run `npm run nugen:align` to produce one",
  };
}

/**
 * The kill switch, and the thing that proves the app works without their
 * platform. Setting `NUGEN_OFF=1` forces the offline path with a key still
 * configured, so the deterministic answer path can be demonstrated while the
 * provider is unreachable.
 */
export function providerDisabled(): boolean {
  return process.env.NUGEN_OFF === "1";
}

export function apiKey(): string | null {
  const k = process.env.NUGEN_API_KEY?.trim();
  return k ? k : null;
}

/** Total budget for one provider call. Clamped, because a hung socket is worse than a slow one. */
export function timeoutMs(): number {
  const n = Number(process.env.NUGEN_TIMEOUT_MS ?? 20_000);
  if (!Number.isFinite(n)) return 20_000;
  return Math.min(120_000, Math.max(500, n));
}
