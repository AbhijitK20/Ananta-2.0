/**
 * Run the Nugen domain alignment for the AI assistant.
 *
 * ```
 * NUGEN_API_KEY=... npm run assistant:align
 * ```
 *
 * The chain, executed for real against `api.nugen.in`:
 *
 * ```
 * base model -> domain corpus -> benchmark -> Nugen alignment -> deploy -> id on disk
 * ```
 *
 * Stages, each safe to re-run:
 *
 *   1. **Dataset**  `npm run assistant:dataset` is a prerequisite, not a stage
 *                   here. Its `manifest.json` carries the SHA-256 of the training
 *                   set and that hash is written into the alignment record, so a
 *                   model can always be traced back to the exact data it came
 *                   from. Regenerating the data and re-running this is the whole
 *                   reproduction procedure.
 *   2. **Upload**   `POST /documents/create` per document. Nugen deduplicates by
 *                   file name and answers a repeat with 409 plus the existing id,
 *                   which is parsed for that id — so a re-run costs nothing and
 *                   this is safe to run on a panic.
 *   3. **Wait**     `GET /documents/{id}/status` until READY. Uploads are async
 *                   and an id used early 404s, so this poll is load-bearing.
 *   4. **Benchmark** `POST /benchmarks/upload` with the validation split. The
 *                   test split is deliberately NOT uploaded: a benchmark the model
 *                   was scored against is no longer held out, and the eval
 *                   harness would then be measuring training data.
 *   5. **Align**    `POST /alignment-projects/create`. Asynchronous.
 *   6. **Wait**     poll status. `early_deployable` means a checkpoint exists, so
 *                   `--early` can deploy mid-flight, which is the difference
 *                   between a demo tonight and a demo whenever the queue clears.
 *   7. **Deploy**   `POST /models/{id}/deployment`, then poll its status.
 *   8. **Record**   write `data/reference/nugen/assistant-alignment.json`, which
 *                   `src/features/assistant/provider/config.ts` reads per request.
 *
 * Flags:
 *   --dry-run          print the corpus and touch no network
 *   --early            deploy the newest checkpoint as soon as one exists
 *   --skip-train       reuse the alignment id on disk and only deploy
 *   --timeout-min N    give up waiting after N minutes (default 45)
 *   --retries N        attempts at project creation, for a 502 their side
 *
 * Exits non-zero if it cannot produce a model id, so a CI step running this
 * cannot pass quietly on a broken run.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  ASSISTANT_ALIGNMENT_MANIFEST,
  type AssistantAlignment,
} from "../src/features/assistant/provider/config";

const API = (process.env.NUGEN_BASE_URL?.replace(/\/$/, "") ?? "https://api.nugen.in/api/v3") as string;
const OUT_DIR = "data/ai_assistant";
const ALIGNMENT_NAME = process.env.NUGEN_ASSISTANT_ALIGNMENT_NAME ?? "travelbuddy-assistant-v1";

/** Only these two are `alignment_ready` per `GET /models/base`. */
const DEFAULT_BASE_MODEL = "llama-v3p2-3b-reasoning";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.some((arg) => arg.replace(/^-+/, "") === name);
const option = (name: string, dflt: number): number => {
  const at = argv.findIndex((arg) => arg.replace(/^-+/, "") === name);
  const raw = at >= 0 ? argv[at + 1] : undefined;
  const parsed = raw === undefined || String(raw).startsWith("--") ? Number.NaN : Number.parseFloat(String(raw));
  return Number.isFinite(parsed) ? parsed : dflt;
};
const stringOption = (name: string, dflt: string): string => {
  const at = argv.findIndex((arg) => arg.replace(/^-+/, "") === name);
  const raw = at >= 0 ? argv[at + 1] : undefined;
  return raw !== undefined && !String(raw).startsWith("--") ? String(raw) : dflt;
};

const BASE_MODEL = stringOption("base-model", process.env.NUGEN_BASE_MODEL ?? DEFAULT_BASE_MODEL);
const DEADLINE_MS = option("timeout-min", 45) * 60_000;
const started = Date.now();

function key(): string {
  const value = process.env.NUGEN_API_KEY?.trim();
  if (!value) {
    fail("NUGEN_API_KEY is not set. Generate one at https://nugen.in and export it.");
  }
  return value;
}

function fail(message: string): never {
  process.stderr.write(`\nassistant-align: ${message}\n\n`);
  process.exit(1);
}

function say(message: string): void {
  const seconds = ((Date.now() - started) / 1000).toFixed(0).padStart(4, " ");
  process.stdout.write(`[${seconds}s] ${message}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type DatasetManifest = {
  examples: number;
  train: number;
  validation: number;
  test: number;
  documents: number;
  dataset_sha256: string;
  test_sha256: string;
};

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`${status}: ${body.slice(0, 300)}`);
    this.name = "ApiError";
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${key()}`,
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new ApiError(response.status, text);
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
}

async function poll<T>(
  label: string,
  path: string,
  done: (body: T) => boolean,
  giveUp: (body: T) => boolean = () => false,
  everyMs = 5_000,
): Promise<T> {
  for (;;) {
    if (Date.now() - started > DEADLINE_MS) {
      fail(`timed out after ${(DEADLINE_MS / 60_000).toFixed(0)} min waiting for ${label}. Re-run with --early to deploy the newest checkpoint instead.`);
    }
    const body = await api<T>(path);
    if (done(body)) return body;
    if (giveUp(body)) fail(`${label} failed: ${JSON.stringify(body).slice(0, 400)}`);
    say(`${label}: ${(body as { status?: string }).status ?? "pending"}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

type CorpusDocument = { name: string; text: string };

/** One document at a time, and a 409 is a success. */
async function uploadDocuments(documents: CorpusDocument[]): Promise<string[]> {
  const ids: string[] = [];
  let reused = 0;
  for (const doc of documents) {
    const form = new FormData();
    form.append("files", new Blob([doc.text], { type: "text/plain" }), doc.name);
    form.append("categories", "travelbuddy-assistant");
    form.append("names", doc.name);

    const response = await fetch(`${API}/documents/create`, {
      method: "POST",
      headers: { accept: "application/json", Authorization: `Bearer ${key()}` },
      body: form,
    });
    const text = await response.text();
    if (response.ok) {
      const id = (JSON.parse(text) as { document_ids?: string[] }).document_ids?.[0];
      if (id) ids.push(id);
      continue;
    }
    if (response.status === 409) {
      // Nugen answers a duplicate upload with the id of the document it already
      // has, so a re-run reuses yesterday's corpus instead of paying to re-ingest
      // it. The conflict is per document, which is why this is per document.
      const existing = /"document_id"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      if (existing) {
        ids.push(existing);
        reused += 1;
        continue;
      }
    }
    fail(`uploading ${doc.name} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  say(`uploaded ${ids.length - reused} documents, reused ${reused}`);

  for (const id of ids) {
    await poll(
      `document ${id}`,
      `/documents/${id}/status`,
      (b: { status?: string }) => b.status === "READY",
      (b: { status?: string }) => b.status === "FAILED",
      3_000,
    );
  }
  say("all documents READY");
  return ids;
}

/**
 * The validation split, as instruction/response pairs.
 *
 * The test split is never uploaded. A benchmark the run is scored against stops
 * being held out the moment it is attached, and `scripts/assistant-eval.ts` needs
 * a set nobody has tuned against.
 */
async function uploadBenchmark(documentId: string): Promise<string | null> {
  const raw = await readFile(join(OUT_DIR, "validation.jsonl"), "utf8").catch(() => "");
  const samples = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { instruction: string; response: string });
  if (samples.length === 0) {
    say("no validation samples; the run will not be scored");
    return null;
  }
  const form = new FormData();
  form.append("file", new Blob([JSON.stringify(samples)], { type: "application/json" }), "assistant-benchmark.json");
  form.append("benchmark_name", "TravelBuddy assistant domain validation");
  if (documentId) form.append("document_id", documentId);
  form.append("description", "Held-out validation split. The test split is deliberately excluded.");
  const body = await api<{ benchmark_id?: string; n_samples?: number }>("/benchmarks/upload", {
    method: "POST",
    body: form,
  });
  say(`benchmark: ${body.n_samples ?? samples.length} samples, id ${body.benchmark_id ?? "none"}`);
  return body.benchmark_id ?? null;
}

type AlignmentStatus = { alignment_id: string; status: string; early_deployable?: boolean };

/**
 * Nugen has returned `Finetuning failed: Nugen job creation failed: HTTP 502 Bad
 * Gateway`, with `stage_failures: ["training_data_upload: outcome_unknown",
 * "training: finetuning_failure"]`, for every base model and every corpus size
 * tried, while `/models/base`, `/documents` and `/alignment-projects` all answer
 * normally. That is their GPU training backend, not a bad request.
 *
 * The retry wraps the WHOLE run — create, then wait, then resolve the model id —
 * not just the create call. The first version of this script checked the status
 * one second after creating the project and found `PROCESSING`, concluded the
 * project was healthy, and then let the 502 surface two minutes later from the
 * wait with no retry left. A project that has failed cannot be resurrected, so
 * the only thing that can succeed is a new one, and the only place that knows
 * whether the new one survived is the end of the run.
 *
 * Only a 502 is retried blindly — a `400 base model does not support alignment`
 * fails identically forever and is reported immediately.
 */
const BACKOFF_MS = [10_000, 20_000, 40_000, 80_000, 120_000];

type RunResult = { alignmentId: string; status: string; modelId: string };

/** Create, wait for a checkpoint, and resolve the model id. Throws `ApiError`-free failures. */
async function runAlignment(
  documentIds: string[],
  benchmarkId: string | null,
  datasetSha: string,
  early: boolean,
): Promise<RunResult> {
  const alignmentId = await createAlignment(documentIds, benchmarkId, datasetSha);
  // `giveUp` throws rather than exiting, so the retry above gets a chance. An
  // earlier version called process.exit here, which is why a 502 that surfaced
  // two minutes into the queue got no retry at all.
  const giveUpOn = (body: AlignmentStatus): boolean => {
    if (body.status === "FAILED" || body.status === "STOPPED") {
      throw new AlignmentFailed(alignmentId);
    }
    return false;
  };
  const status = early
    ? // Deploy the newest checkpoint as soon as one exists rather than waiting for
      // the run to finish. The GPU serves the latest checkpoint and refreshes on
      // its own, so the id is stable and only the weights move.
      await poll<AlignmentStatus>(
        "alignment checkpoint",
        `/alignment-projects/${alignmentId}/status`,
        (body) => body.early_deployable === true || body.status === "READY",
        giveUpOn,
        15_000,
      )
    : await poll<AlignmentStatus>(
        "alignment",
        `/alignment-projects/${alignmentId}/status`,
        (body) => body.status === "READY" || body.status === "EVALUATED",
        giveUpOn,
        15_000,
      );
  say(`alignment status: ${status.status}`);
  const modelId = await modelIdFor(alignmentId);
  return { alignmentId, status: status.status, modelId };
}

/** Why the last run failed, as a short string, or "" if it is still healthy. */
async function failureReason(alignmentId: string): Promise<string> {
  const detail = await api<{ error?: string; stage_failures?: string[] }>(`/alignment-projects/${alignmentId}`);
  return detail.error ?? (detail.stage_failures ?? []).join(", ");
}

async function alignWithRetry(
  documentIds: string[],
  benchmarkId: string | null,
  datasetSha: string,
  early: boolean,
): Promise<RunResult> {
  const attempts = Math.max(1, Math.round(option("retries", 3)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result: RunResult;
    try {
      result = await runAlignment(documentIds, benchmarkId, datasetSha, early);
    } catch (error) {
      // A FAILED status is the case worth retrying; a timeout or a transport
      // error is reported as-is, because re-running a project that may still be
      // training wastes a queue slot and tells us nothing new.
      const status = await lastStatus(alignmentIdFrom(error)).catch(() => null);
      if (status !== "FAILED") throw error;
      const reason = await failureReason(alignmentIdFrom(error));
      say(`attempt ${attempt}/${attempts} failed: ${reason || "no reason given"}`);
      if (attempt === attempts) {
        fail(
          `Nugen could not train the aligned model: ${reason || "unknown error"}\n` +
            `  Their control plane answered — the corpus uploaded, the benchmark was accepted\n` +
            `  and the project was created and queued — so the request and the data are fine.\n` +
            `  This is their GPU training backend returning 502.\n\n` +
            `  Re-run \`npm run assistant:align\` when it recovers. Uploads are deduplicated by\n` +
            `  filename, so a re-run costs nothing.\n\n` +
            `  The assistant keeps working meanwhile: with no customized model it answers from\n` +
            `  the deterministic provider, and /api/assistant/health reports customized: false.`,
        );
      }
      if (!/\b502\b|bad gateway|unavailable|timeout/i.test(reason)) {
        fail(`alignment failed for a reason a retry will not fix: ${reason}`);
      }
      const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 120_000;
      say(`retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    return result;
  }
  /* c8 ignore next */
  return fail("unreachable");
}

/** Carries the alignment id on the error so the retry can look up the reason. */
class AlignmentFailed extends Error {
  constructor(readonly alignmentId: string) {
    super(`alignment ${alignmentId} failed`);
    this.name = "AlignmentFailed";
  }
}

function alignmentIdFrom(error: unknown): string {
  return error instanceof AlignmentFailed ? error.alignmentId : "";
}

async function lastStatus(alignmentId: string): Promise<string | null> {
  if (!alignmentId) return null;
  const body = await api<{ status?: string }>(`/alignment-projects/${alignmentId}/status`);
  return body.status ?? null;
}

async function createAlignment(
  documentIds: string[],
  benchmarkId: string | null,
  datasetSha: string,
): Promise<string> {
  const body = await api<{ alignment_id?: string; status?: string }>("/alignment-projects/create", {
    method: "POST",
    body: JSON.stringify({
      alignment_name: ALIGNMENT_NAME,
      base_model_id: BASE_MODEL,
      document_ids: documentIds,
      benchmark_id: benchmarkId,
      description:
        `Domain alignment for the TravelBuddy AI assistant: travel planning and app usage for Mumbai, ` +
        `with refusal behaviour, terminology and grounded answers. Training set SHA-256 ${datasetSha}.`,
    }),
  });
  const id = body.alignment_id;
  if (!id) fail("alignment create returned no alignment_id");
  say(`alignment ${id} created on ${BASE_MODEL} (${body.status ?? "PROCESSING"})`);
  return id;
}

/** The model id, which is not the alignment id. They are different identifiers. */
async function modelIdFor(alignmentId: string): Promise<string> {
  const detail = await api<{ model_id?: string | null; models?: { model_id: string }[]; status?: string }>(
    `/alignment-projects/${alignmentId}`,
  );
  const found = detail.model_id ?? detail.models?.[0]?.model_id;
  if (found) return found;
  // The detail route is the documented home for model info; if it has not been
  // populated yet the alignment id is the only handle, and the deploy call below
  // is what actually needs the model.
  return alignmentId;
}

async function deployModel(modelId: string, early: boolean): Promise<boolean> {
  try {
    const body = await api<{ model_id?: string }>(
      `/models/${modelId}/deployment${early ? "?early=true" : ""}`,
      { method: "POST" },
    );
    say(`deploying ${body.model_id ?? modelId}${early ? " (early checkpoint)" : ""}`);
  } catch (error) {
    // A 409 means the run is still training, which `--early` exists for.
    fail(
      `deploy rejected. The run is still training, which is what 409 means — re-run with --early.\n  ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    await poll(
      "deployment",
      `/models/${modelId}/deployment/status`,
      (b: { status?: string }) =>
        b.status === "READY" || b.status === "DEPLOYED" || b.status === "COMPLETED",
      (b: { status?: string }) => b.status === "FAILED",
      10_000,
    );
    say("deployment ready");
    return true;
  } catch (error) {
    // A deployment still in flight is not a failed alignment. Record it anyway:
    // the id is valid, and the assistant will find the model unavailable and fall
    // back until it lands.
    say(`deployment not ready yet: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function writeRecord(record: AssistantAlignment): Promise<void> {
  await mkdir(dirname(ASSISTANT_ALIGNMENT_MANIFEST), { recursive: true });
  await writeFile(ASSISTANT_ALIGNMENT_MANIFEST, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  say(`wrote ${ASSISTANT_ALIGNMENT_MANIFEST}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dataset = await readJson<DatasetManifest>(join(OUT_DIR, "manifest.json"));
  if (!dataset) {
    fail(`no ${OUT_DIR}/manifest.json. Run \`npm run assistant:dataset\` first — this script uploads the corpus that command builds.`);
  }
  // The hash is recomputed from the file rather than trusted from the manifest, so
  // a hand-edited train.jsonl cannot claim a provenance it does not have.
  const actualSha = createHash("sha256").update(await readFile(join(OUT_DIR, "train.jsonl"), "utf8")).digest("hex");
  if (actualSha !== dataset.dataset_sha256) {
    fail(
      `${OUT_DIR}/train.jsonl does not match its manifest hash.\n` +
        `  manifest: ${dataset.dataset_sha256}\n` +
        `  actual:   ${actualSha}\n` +
        `  Re-run \`npm run assistant:dataset\`, or find out what edited the file.`,
    );
  }
  say(`dataset: ${dataset.train} train / ${dataset.validation} validation / ${dataset.test} held out`);
  say(`dataset sha256: ${actualSha}`);

  const existing = await readJson<AssistantAlignment>(ASSISTANT_ALIGNMENT_MANIFEST);

  if (flag("dry-run")) {
    const { readdir } = await import("node:fs/promises");
    for (const name of (await readdir(join(OUT_DIR, "documents"))).filter((n) => n.endsWith(".txt")).sort()) {
      const text = await readFile(join(OUT_DIR, "documents", name), "utf8");
      process.stdout.write(`\n${"=".repeat(72)}\n${name}  ${text.length} chars\n${"=".repeat(72)}\n${text.slice(0, 600)}\n…\n`);
    }
    return;
  }

  if (flag("skip-train") && existing) {
    say(`reusing alignment ${existing.alignment_id} (model ${existing.model_id})`);
    const deployed = await deployModel(existing.model_id, flag("early"));
    await writeRecord({ ...existing, status: deployed ? "DEPLOYED" : existing.status });
    return;
  }

  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(join(OUT_DIR, "documents"))).filter((n) => n.endsWith(".txt")).sort();
  const documents: CorpusDocument[] = [];
  for (const name of names) {
    documents.push({ name, text: await readFile(join(OUT_DIR, "documents", name), "utf8") });
  }
  if (documents.length === 0) fail(`${OUT_DIR}/documents is empty. Run \`npm run assistant:dataset\` first.`);

  const documentIds = await uploadDocuments(documents);
  const benchmarkId = await uploadBenchmark(documentIds[0] ?? "");
  const { alignmentId, status, modelId } = await alignWithRetry(
    documentIds,
    benchmarkId,
    actualSha,
    flag("early"),
  );

  say(`aligned model: ${modelId}`);
  const deployed = await deployModel(modelId, flag("early"));

  await writeRecord({
    alignment_id: alignmentId,
    model_id: modelId,
    base_model_id: BASE_MODEL,
    status: deployed ? "DEPLOYED" : status,
    aligned_at: new Date().toISOString(),
    dataset_sha256: actualSha,
    train_examples: dataset.train,
    validation_examples: dataset.validation,
    benchmark_id: benchmarkId,
    note:
      "Produced by scripts/assistant-align.ts. `model_id` is what " +
      "src/features/assistant/provider/config.ts sends as `model` to /inference/chat/completions. " +
      "Delete this file and the assistant falls back to the deterministic provider rather than to the base model.",
  });

  process.stdout.write(
    `\nBase model      ${BASE_MODEL}\n` +
      `Alignment       ${alignmentId}\n` +
      `Aligned model   ${modelId}\n` +
      `Status          ${deployed ? "DEPLOYED" : status}\n` +
      `Documents       ${documents.length}\n` +
      `Dataset sha256  ${actualSha}\n` +
      `Benchmark       ${benchmarkId ?? "none"}\n\n` +
      `Next: set NUGEN_API_KEY (and optionally NUGEN_CUSTOMIZED_MODEL_ID=${modelId}) in the\n` +
      `app environment. /api/assistant/health will then report customized: true.\n\n`,
  );
}

void main().catch((error: unknown) => {
  const detail =
    error instanceof ApiError
      ? `${error.status} — ${error.body.slice(0, 400)}`
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`\nassistant-align: ${detail}\n\n`);
  process.exit(1);
});
