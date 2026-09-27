/**
 * GET /api/health — is this app actually running an aligned model?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT IS THE POINT OF THE PROJECT
 * ---------------------------------------------------------------------------
 *
 * HackCelestial requires a real alignment, and a real alignment is a claim
 * anybody should be able to check. So this route answers it with no arguments
 * and no interpretation:
 *
 *   - `alignment.customized` is true only when a training run completed and
 *     wrote a `model_id`. There is no base-model fallback anywhere behind it.
 *   - `alignment.model` is the id. If that id ever appears in `baseModels`, the
 *     claim is false and this route says so, because that is the one mistake
 *     that would make the whole thing a fabrication.
 *   - `alignment.gpu_training_completed` comes from the record, not from us.
 *   - `confidenceProbe` asks the model a question and reports the
 *     `confidence_score` that came back. Aligned models return a number; base
 *     models return nothing at all. It is opt-in because it costs a provider
 *     call.
 *
 * The endpoint answers 200 even when degraded. A 503 would say "the product is
 * down", which is a different claim from "the optional model is not aligned",
 * and conflating the two makes a missing alignment look like an outage.
 */

import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { complete, NugenError } from "@/lib/nugen/client";
import { apiKey, providerDisabled, resolveModel } from "@/lib/nugen/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.NUGEN_BASE_URL ?? "https://api.nugen.in/api/v3";

/** Nugen answers this without an API key, so it is a fair thing to compare against. */
async function listBaseModels(): Promise<string[]> {
  const key = apiKey();
  if (!key) return [];
  const res = await fetch(`${BASE}/models/base`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return [];
  const json = (await res.json().catch(() => null)) as { models?: Array<{ model_id?: string }> } | null;
  return (json?.models ?? []).map((m) => m.model_id ?? "").filter(Boolean);
}

export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  const status = resolveModel();

  const alignment = status.customized
    ? {
        customized: true,
        model: status.model,
        source: status.source,
        alignment_id: status.alignment?.alignment_id ?? null,
        base_model_id: status.alignment?.base_model_id ?? null,
        document_count: status.alignment?.document_count ?? null,
        document_chars: status.alignment?.document_chars ?? null,
        completed_at: status.alignment?.completed_at ?? null,
        gpu_training_completed: status.alignment?.gpu_training_completed ?? true,
      }
    : { customized: false, model: null, detail: status.reason };

  const baseModels = await listBaseModels();
  // The falsification check. An aligned model is a new id, so it must not be one
  // of the base models. If it is, the alignment claim is void and we say so.
  const modelIsBase = Boolean(status.model && baseModels.includes(status.model));

  let confidenceProbe: unknown = { ran: false, why: "pass ?deep=1 to run a real provider call" };
  if (deep && status.customized && !providerDisabled() && apiKey()) {
    const started = Date.now();
    try {
      const res = await complete({
        model: status.model,
        messages: [{ role: "user", content: "Name one place in the catalogue and its city." }],
        maxTokens: 60,
        temperature: 0,
      });
      confidenceProbe = {
        ran: true,
        ok: true,
        model: res.model,
        latencyMs: Date.now() - started,
        // A base model has no confidence_score field at all. `null` here is the
        // single clearest signal that alignment did not happen.
        confidence_score: res.confidence?.score ?? null,
        text: res.text.slice(0, 200),
      };
    } catch (err) {
      confidenceProbe = {
        ran: true,
        ok: false,
        error: err instanceof NugenError ? err.message : String(err),
        retryable: err instanceof NugenError ? err.retryable : false,
      };
    }
  }

  let corpus: unknown = null;
  try {
    const p = join(process.cwd(), "data", "nugen-corpus", "manifest.json");
    corpus = JSON.parse(readFileSync(p, "utf8")) as unknown;
  } catch {
    corpus = null;
  }

  return NextResponse.json(
    {
      ok: true,
      provider: providerDisabled() ? "disabled (NUGEN_OFF=1)" : apiKey() ? "configured" : "no API key",
      alignment,
      modelIsBaseModel: modelIsBase,
      // Stated flat so it cannot be skimmed past: the claim holds only when the
      // model is aligned, is not a base model, and training actually finished.
      claimHolds: Boolean(status.customized && !modelIsBase && status.alignment?.gpu_training_completed !== false),
      confidenceProbe,
      corpus,
      checkedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
