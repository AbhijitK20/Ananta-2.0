/**
 * Is the Nugen platform actually able to serve this project right now?
 *
 * ```
 * npm run nugen:probe
 * ```
 *
 * Three independent checks, because the failure mode that matters is a *partial*
 * outage and a single call cannot tell you which half is down:
 *
 *   control plane   `GET /models/base`                     — account, key, API shape
 *   data plane      `POST /inference/chat/completions`      — the GPU, i.e. real inference
 *   training        `POST /alignment-projects` (rejected)   — the finetuning orchestrator
 *
 * The third check is the awkward one: there is no "can you train?" endpoint, so this
 * creates a real alignment project and reads its status once. A 404 on the *detail*
 * route would mean the run failed; the point is that a `FAILED` status carrying a 502
 * in its `error` means *their* backend rejected the job, which is information the
 * demo needs and which nothing else in the codebase can report.
 *
 * It creates at most one project per run and says so. It is a probe, not a retrier —
 * `nugen-align.ts` is the thing that retries.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import { ALIGNMENT_MANIFEST, type AlignmentManifest } from "../src/llm/nugen";

const API = process.env.NUGEN_BASE_URL?.replace(/\/$/, "") ?? "https://api.nugen.in/api/v3";
const MODEL = process.env.NUGEN_PROBE_MODEL ?? "llama-v3p2-3b-reasoning";
/** Whatever the last successful run wrote, so the probe can report a stale id. */
const DOCUMENT_ID = process.env.NUGEN_PROBE_DOCUMENT_ID ?? "document_01m3g27ccspgtq53";

const GREEN = "  ok  ";
const RED = " FAIL ";

type Check = { name: string; ok: boolean; detail: string };

async function json(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${process.env.NUGEN_API_KEY ?? ""}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 200);
  }
  return { status: response.status, body };
}

const checks: Check[] = [];

async function controlPlane(): Promise<void> {
  const { status, body } = await json("/models/base");
  const models = (body as { models?: { model_id: string; alignment_ready: boolean }[] } | null)?.models ?? [];
  const ready = models.filter((model) => model.alignment_ready).map((model) => model.model_id);
  checks.push({
    name: "control plane  GET /models/base",
    ok: status === 200,
    detail: status === 200 ? `${models.length} base models, alignment_ready: ${ready.join(", ") || "none"}` : `HTTP ${status}`,
  });
}

async function dataPlane(): Promise<void> {
  const { status, body } = await json("/inference/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      temperature: 0,
      stream: false,
      messages: [{ role: "user", content: "ok" }],
    }),
  });
  const content = (body as { choices?: { message?: { content?: string } }[] } | null)?.choices?.[0]?.message?.content;
  checks.push({
    name: `data plane     POST /inference/chat/completions (${MODEL})`,
    ok: status === 200 && typeof content === "string",
    detail: status === 200 ? `answered: ${JSON.stringify((content ?? "").slice(0, 40))}` : `HTTP ${status}`,
  });
}

async function trainingPlane(): Promise<void> {
  const created = await json("/alignment-projects/create", {
    method: "POST",
    body: JSON.stringify({
      alignment_name: `travelbuddy-probe-${Date.now()}`,
      base_model_id: MODEL,
      document_ids: [DOCUMENT_ID],
      description: "Reachability probe. Safe to ignore.",
    }),
  });
  const id = (created.body as { alignment_id?: string } | null)?.alignment_id;
  if (created.status !== 200 || !id) {
    checks.push({ name: "training       POST /alignment-projects/create", ok: false, detail: `HTTP ${created.status}` });
    return;
  }
  // One status read. A 502 surfaces here within a second or two, which is the whole
  // point: creation succeeding tells you nothing about whether training can start.
  await new Promise((done) => setTimeout(done, 8_000));
  const status = await json(`/alignment-projects/${id}/status`);
  const state = (status.body as { status?: string; early_deployable?: boolean } | null)?.status;
  const detail = await json(`/alignment-projects/${id}`);
  const error = (detail.body as { error?: string } | null)?.error;
  checks.push({
    name: "training       alignment run reaches a checkpoint",
    ok: state === "PROCESSING" || state === "READY" || state === "QUEUED",
    detail: state === "FAILED" ? `${state} — ${error ?? "no reason given"}` : `${state}${state === "QUEUED" ? " (still in queue)" : ""}`,
  });
}

async function main(): Promise<void> {
  const key = process.env.NUGEN_API_KEY?.trim();
  if (!key) {
    process.stderr.write("\nnugen-probe: NUGEN_API_KEY is not set.\n\n");
    process.exit(1);
  }

  await controlPlane();
  await dataPlane();
  await trainingPlane();

  let manifest: AlignmentManifest | null = null;
  try {
    manifest = JSON.parse(await readFile(ALIGNMENT_MANIFEST, "utf8")) as AlignmentManifest;
  } catch {
    manifest = null;
  }

  const aligned = checks.find((check) => check.name.startsWith("training"))?.ok === true;
  const serving = checks.find((check) => check.name.startsWith("data plane"))?.ok === true;

  process.stdout.write("\nNugen Intelligence — TravelBuddy Digital Twin\n\n");
  for (const check of checks) {
    process.stdout.write(`[${check.ok ? GREEN : RED}] ${check.name}\n         ${check.detail}\n`);
  }
  process.stdout.write(`\n  aligned model on disk: ${manifest ? `${manifest.model_id} (${manifest.status})` : "none — run npm run nugen:align"}\n`);
  process.stdout.write(`  twin will use:          ${aligned && serving && manifest ? `aligned model ${manifest.model_id}` : "deterministic classifier (Nugen unavailable)"}\n\n`);

  process.exit(aligned && serving ? 0 : 2);
}

void main();
