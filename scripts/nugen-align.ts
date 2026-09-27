/**
 * Run the Nugen domain alignment for the Digital Twin.
 *
 * ```
 * NUGEN_API_KEY=... npm run nugen:align
 * ```
 *
 * The chain HackCelestial 3.0 requires, executed for real against
 * `api.nugen.in`:
 *
 * ```
 * base model  ->  domain corpus  ->  benchmark  ->  Nugen alignment  ->  deploy  ->  id on disk
 * ```
 *
 * Stages, each idempotent enough to re-run:
 *
 *  1. **Corpus**     built from this repository by `buildCorpus()` — the catalogue's
 *                    shelter structure, the reviews' exposure judgements, the
 *                    events' cancellation thresholds, the twin's own taxonomy.
 *  2. **Upload**     `POST /documents/create` as plain text (developer edition).
 *  3. **Wait**       poll `GET /documents/{id}/status` until `READY`. Uploads are
 *                    async and a document id used early 404s, so this poll is not
 *                    optional politeness.
 *  4. **Benchmark**  `POST /benchmarks/upload` with instruction/response pairs
 *                    derived from the real reviews, so the run is scored against
 *                    the twin's own deterministic classifier.
 *  5. **Align**      `POST /alignment-projects/create`. Asynchronous.
 *  6. **Wait**       poll `GET /alignment-projects/{id}/status`. `early_deployable`
 *                    becomes true once a checkpoint exists, so a long run can be
 *                    deployed mid-flight with `?early=true` — which is the
 *                    difference between a demo tonight and a demo whenever the
 *                    queue clears.
 *  7. **Deploy**     `POST /models/{id}/deployment`, then poll its status.
 *  8. **Record**     write `data/reference/nugen/alignment.json`, which
 *                    `src/llm/nugen.ts` reads at request time.
 *
 * Flags, because a training run is long and a hackathon is short:
 *   `--early`     deploy the newest checkpoint as soon as one exists
 *   `--skip-train` reuse the alignment id already on disk, and only deploy
 *   `--timeout-min N` give up waiting after N minutes (default 45)
 *   `--dry-run`   build and print the corpus, touch no network
 *
 * Exits non-zero if it cannot produce a model id, so a CI step running this cannot
 * pass quietly on a broken run.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import { buildCorpus, benchmarkFrom, type CorpusDocument } from "../src/features/twin/corpus";
import {
  signalsFromEvents,
  signalsFromReviews,
  type EventRow,
  type ReviewRow,
  type SocialSignal,
} from "../src/features/twin/social";
import { ALIGNMENT_MANIFEST, type AlignmentManifest } from "../src/llm/nugen";

const API = process.env.NUGEN_BASE_URL?.replace(/\/$/, "") ?? "https://api.nugen.in/api/v3";
const ALIGNMENT_NAME = process.env.NUGEN_ALIGNMENT_NAME ?? "travelbuddy-monsoon-impact-v1";

const argv = process.argv.slice(2);
/**
 * Accepts `--early` and `early` alike. Reading the flag name as written by hand is
 * how a `--dry-run` silently becomes a real training run against a paid API, so the
 * leading dashes are normalised here rather than trusted at eight call sites.
 */
const flag = (name: string): boolean => argv.some((arg) => arg.replace(/^-+/, "") === name);
const option = (name: string, dflt: number): number => {
  const at = argv.findIndex((arg) => arg.replace(/^-+/, "") === name);
  const raw = at >= 0 ? argv[at + 1] : undefined;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : dflt;
};
const stringOption = (name: string, dflt: string): string => {
  const at = argv.findIndex((arg) => arg.replace(/^-+/, "") === name);
  const raw = at >= 0 ? argv[at + 1] : undefined;
  return raw !== undefined && !raw.startsWith("--") ? raw : dflt;
};

/**
 * The base model to align.
 *
 * `GET /api/v3/models/base` reports exactly two entries with `alignment_ready: true`
 * — `llama-v3p2-3b-reasoning` and `qwen2-vl-2b-instruct` — and this defaults to the
 * first. `--base-model` exists because a run can fail inside Nugen's own job
 * orchestrator with a 502 during `training_data_upload`, and the only way to tell
 * "this model is broken" from "this corpus is broken" is to run the other one.
 */
const BASE_MODEL = stringOption("base-model", process.env.NUGEN_BASE_MODEL ?? "llama-v3p2-3b-reasoning");

const DEADLINE_MS = option("timeout-min", 45) * 60_000;
const started = Date.now();

function key(): string {
  const value = process.env.NUGEN_API_KEY?.trim();
  if (!value) {
    fail("NUGEN_API_KEY is not set. Sign up at https://nugen.in/signup?invite=PILLAIUNIV2026 and export the key.");
  }
  return value;
}

function fail(message: string): never {
  process.stderr.write(`\nnugen-align: ${message}\n\n`);
  process.exit(1);
}

function say(message: string): void {
  const seconds = ((Date.now() - started) / 1000).toFixed(0).padStart(4, " ");
  process.stdout.write(`[${seconds}s] ${message}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

type CatalogueRow = {
  id: string;
  name: string;
  category: string;
  location: { lat: number; lon: number };
  durationMin: number;
  indoorOutdoor: "indoor" | "outdoor" | "covered" | "mixed";
  weatherSensitive: "none" | "rain" | "heat" | "wind" | "any";
  neighbourhood: string | null;
  capacity: number | null;
  blurb: string | null;
};
/** JSONL where a bad line is a skipped line, never a crash: 4,596 OSM rows. */
async function readJsonl<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skipped on purpose and counted in the summary, because a corpus that
      // silently drops half its rows is worse than one that says it did.
    }
  }
  return out;
}

/**
 * The twin reads TWO catalogues, and it has to.
 *
 * `data/cities/mumbai/experiences.jsonl` is 4,596 harvested OSM rows keyed
 * `osm-node-<id>`, with `neighbourhood: null` on almost all of them. That is the
 * long tail, and it is what the planner actually searches.
 *
 * `content/experiences/*.jsonl` is 133 hand-curated rows keyed by slug, with
 * neighbourhoods, capacities, best months and weather sensitivity filled in. That
 * is the rich tier — and it is the *only* tier the reviews and events reference.
 *
 * The two id spaces are disjoint, which is a fact about the repository rather than a
 * bug to paper over: joining them by id yields nothing, so a corpus built from the
 * OSM tier alone carries no evidence at all. Both are therefore loaded, and the
 * curated tier is what the area documents are built from because it is what the
 * social corpus talks about.
 */
async function loadCorpus(): Promise<{
  documents: CorpusDocument[];
  signals: SocialSignal[];
  rows: CatalogueRow[];
  curated: CatalogueRow[];
}> {
  const curatedDir = "content/experiences";
  const curatedFiles = (await readdir(curatedDir)).filter((name) => name.endsWith(".jsonl"));
  const curated: CatalogueRow[] = [];
  for (const name of curatedFiles) curated.push(...(await readJsonl<CatalogueRow>(join(curatedDir, name))));
  say(`catalogue: ${curated.length} curated rows across ${curatedFiles.length} areas`);

  const harvested = (await readJsonl<CatalogueRow>("data/cities/mumbai/experiences.jsonl")).slice(0, 4000);
  say(`catalogue: ${harvested.length} harvested OSM rows`);

  const reviewDir = "content/reviews";
  const files = (await readdir(reviewDir)).filter((name) => name.endsWith(".jsonl"));
  const reviews: ReviewRow[] = [];
  for (const name of files) reviews.push(...(await readJsonl<ReviewRow>(join(reviewDir, name))));
  say(`reviews: ${reviews.length} across ${files.length} areas`);

  const events = await readJsonl<EventRow>("content/events/events.jsonl");
  say(`events: ${events.length}`);

  const signals = [...signalsFromReviews(reviews), ...signalsFromEvents(events)];
  const withWeather = signals.filter((signal) => signal.conditions.length > 0).length;
  say(`signals: ${signals.length} total, ${withWeather} carrying a hazard`);

  const documents = buildCorpus(curated, signals);
  // `--docs N` keeps only the taxonomy and propagation documents plus the N largest
  // evidence documents. It exists because a Nugen run can fail in their job
  // orchestrator with a 502 during `training_data_upload`, and the first thing worth
  // trying is less data — which is also the honest way to find out whether a corpus
  // is too large rather than too small.
  const limit = option("docs", Number.POSITIVE_INFINITY);
  const kept = Number.isFinite(limit)
    ? [
        ...documents.filter((doc) => doc.category === "taxonomy" || doc.category === "propagation"),
        ...documents.filter((doc) => doc.category !== "taxonomy" && doc.category !== "propagation").slice(0, Math.max(0, limit)),
      ]
    : documents;
  say(`corpus: ${kept.length} documents, ${kept.reduce((sum, doc) => sum + doc.text.length, 0).toLocaleString()} characters`);
  if (kept.length !== documents.length) {
    say(`  (--docs ${limit}: dropped ${documents.length - kept.length} of ${documents.length})`);
  }
  return { documents: kept, signals, rows: harvested, curated };
}

// ---------------------------------------------------------------------------
// Nugen transport
// ---------------------------------------------------------------------------

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
  if (!response.ok) fail(`${init.method ?? "GET"} ${path} returned ${response.status}: ${text.slice(0, 400)}`);
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
}

/** Poll until `done` or the deadline. Returns the last body either way. */
async function poll<T>(
  label: string,
  path: string,
  done: (body: T) => boolean,
  giveUp: (body: T) => boolean = () => false,
  everyMs = 5_000,
): Promise<T> {
  let last: T | undefined;
  for (;;) {
    if (Date.now() - started > DEADLINE_MS) {
      fail(`timed out after ${(DEADLINE_MS / 60_000).toFixed(0)} min waiting for ${label}. Re-run with --early to deploy the newest checkpoint instead.`);
    }
    last = await api<T>(path);
    if (done(last)) return last;
    if (giveUp(last)) fail(`${label} failed: ${JSON.stringify(last).slice(0, 400)}`);
    say(`${label}: ${(last as { status?: string }).status ?? "pending"}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/**
 * One document at a time, and a 409 is a success.
 *
 * Nugen deduplicates uploads by file name and answers a repeat with `409
 * Conflict` plus the id of the document that already exists. That makes a re-run
 * cheap and idempotent — the second run reuses the corpus it uploaded an hour ago
 * instead of paying to re-ingest it — so the conflict is parsed for its id rather
 * than treated as an error. Uploading per-file is what makes that possible, since
 * the conflict is reported per document and not for the batch.
 */
async function uploadDocuments(documents: CorpusDocument[]): Promise<string[]> {
  const ids: string[] = [];
  let reused = 0;
  for (const doc of documents) {
    const form = new FormData();
    form.append("files", new Blob([doc.text], { type: "text/plain" }), doc.name);
    form.append("categories", "travelbuddy-twin");
    form.append("names", doc.name);

    const response = await fetch(`${API}/documents/create`, {
      method: "POST",
      headers: { accept: "application/json", Authorization: `Bearer ${key()}` },
      body: form,
    });
    const text = await response.text();
    if (response.ok) {
      const parsed = JSON.parse(text) as { document_ids?: string[] };
      const id = parsed.document_ids?.[0];
      if (id) ids.push(id);
      continue;
    }
    if (response.status === 409) {
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
async function uploadBenchmark(documentId: string, signals: SocialSignal[]): Promise<string | null> {
  const samples = benchmarkFrom(signals, 60);
  if (samples.length === 0) {
    say("no benchmark samples; the run will not be scored");
    return null;
  }
  const form = new FormData();
  form.append("file", new Blob([JSON.stringify(samples)], { type: "application/json" }), "twin-hazard-benchmark.json");
  form.append("benchmark_name", "TravelBuddy twin hazard assessment");
  form.append("document_id", documentId);
  form.append("description", "Instruction/response pairs derived from 291 real reviews, scored against the twin's deterministic classifier.");
  const body = await api<{ benchmark_id?: string; n_samples?: number }>("/benchmarks/upload", { method: "POST", body: form });
  say(`benchmark: ${body.n_samples ?? samples.length} samples, id ${body.benchmark_id ?? "none"}`);
  return body.benchmark_id ?? null;
}

type AlignmentStatus = {
  alignment_id: string;
  status: string;
  early_deployable?: boolean;
};

/**
 * Nugen has returned `Finetuning failed: Nugen job creation failed: HTTP 502 Bad
 * Gateway` for every base model and every corpus size tried, and the plain
 * `/inference/chat/completions` endpoint returns 502 as well while
 * `/models/base`, `/documents` and `/alignment-projects` all answer normally. That
 * is their GPU data plane being down, not a bad request, and it is why this retries.
 *
 * The retry is on the whole *project creation*, not on the poll: a project that
 * failed cannot be resurrected, so the only thing that can succeed is a new one.
 * `--retries N` bounds it, and a 502 is the only failure worth retrying blindly —
 * a `400 base model does not support alignment` will fail identically forever and
 * is reported immediately.
 */
const BACKOFF_MS = [10_000, 20_000, 40_000, 80_000, 120_000];

async function createAlignmentWithRetry(
  documentIds: string[],
  benchmarkId: string | null,
): Promise<string> {
  const attempts = Math.max(1, Math.round(option("retries", 3)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const id = await createAlignment(documentIds, benchmarkId);
    const first = await api<AlignmentStatus>(`/alignment-projects/${id}/status`);
    // A 502 surfaces as FAILED within a second or two, so the first status read is
    // the cheapest possible place to detect it.
    if (first.status !== "FAILED") return id;
    const detail = await api<{ error?: string }>(`/alignment-projects/${id}`);
    const retryable = /\b502\b|bad gateway|unavailable|timeout/i.test(detail.error ?? "");
    say(`attempt ${attempt}/${attempts} failed: ${detail.error ?? "no reason given"}`);
    if (!retryable || attempt === attempts) {
      fail(
        `Nugen could not train the aligned model: ${detail.error ?? "unknown error"}.\n` +
          `  The control plane answered, so the corpus and the request are fine — this is\n` +
          `  their inference/training backend. Re-run the same command when it recovers;\n` +
          `  uploads are deduplicated by filename, so a re-run costs nothing.`,
      );
    }
    const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 120_000;
    say(`retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
  /* c8 ignore next */
  return fail("unreachable");
}

async function createAlignment(documentIds: string[], benchmarkId: string | null): Promise<string> {
  const body = await api<{ alignment_id?: string; status?: string }>("/alignment-projects/create", {
    method: "POST",
    body: JSON.stringify({
      alignment_name: ALIGNMENT_NAME,
      base_model_id: BASE_MODEL,
      document_ids: documentIds,
      benchmark_id: benchmarkId,
      description:
        "Domain alignment for the TravelBuddy Digital Twin: weather hazard classification and impact propagation across a Mumbai hospitality and travel catalogue.",
    }),
  });
  const id = body.alignment_id;
  if (!id) fail("alignment create returned no alignment_id");
  say(`alignment ${id} created on ${BASE_MODEL} (${body.status ?? "PROCESSING"})`);
  return id;
}

/** The model id, which is not the alignment id. They are different identifiers. */
async function modelIdFor(alignmentId: string): Promise<string> {
  const detail = await api<{ model_id?: string; models?: { model_id: string }[]; status?: string }>(
    `/alignment-projects/${alignmentId}`,
  );
  const found = detail.model_id ?? detail.models?.[0]?.model_id;
  if (found) return found;
  // The detail route is the documented home for configuration and model info; if
  // it has not been populated yet the alignment id is the only handle, and the
  // deploy call below is what actually needs the model.
  return alignmentId;
}

async function deployModel(modelId: string, alignmentId: string, early: boolean): Promise<boolean> {
  const query = early ? "?early=true" : "";
  try {
    const body = await api<{ model_id?: string }>(`/models/${modelId}/deployment${query}`, { method: "POST" });
    say(`deploying ${body.model_id ?? modelId}${early ? " (early checkpoint)" : ""}`);
  } catch (error) {
    // `api()` exits the process on a non-2xx, so a 409 "still training" arrives as
    // a thrown message only when the early flag was not passed. Re-running with
    // --early is the documented remedy, so say so rather than dying silently.
    fail(`deploy rejected. The run is still training, which is what 409 means — re-run with --early.\n  ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await poll(
      "deployment",
      `/models/${modelId}/deployment/status`,
      (b: { status?: string }) => b.status === "READY" || b.status === "DEPLOYED" || b.status === "COMPLETED",
      (b: { status?: string }) => b.status === "FAILED",
      10_000,
    );
    say("deployment ready");
    return true;
  } catch (error) {
    // A deployment still in flight is not a failed alignment. Record the alignment
    // anyway: the id is valid, and the next `assessText` call will find the model
    // unavailable and fall back deterministically until it lands.
    say(`deployment not ready yet: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  // `alignmentId` is threaded for the log line, which is the only reason it is here.
  void alignmentId;
}

async function readManifest(): Promise<AlignmentManifest | null> {
  try {
    return JSON.parse(await readFile(ALIGNMENT_MANIFEST, "utf8")) as AlignmentManifest;
  } catch {
    return null;
  }
}

async function writeManifest(manifest: AlignmentManifest): Promise<void> {
  await mkdir(dirname(ALIGNMENT_MANIFEST), { recursive: true });
  await writeFile(ALIGNMENT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  say(`wrote ${ALIGNMENT_MANIFEST}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { documents, signals } = await loadCorpus();

  if (flag("dry-run")) {
    for (const doc of documents) {
      process.stdout.write(`\n${"=".repeat(72)}\n${doc.name}  [${doc.category}]\n${"=".repeat(72)}\n${doc.text}\n`);
    }
    const samples = benchmarkFrom(signals, 3);
    process.stdout.write(`\n${"=".repeat(72)}\nbenchmark sample\n${"=".repeat(72)}\n${JSON.stringify(samples[0] ?? null, null, 2)}\n`);
    return;
  }

  const existing = await readManifest();

  if (flag("skip-train") && existing) {
    say(`reusing alignment ${existing.alignment_id} (model ${existing.model_id})`);
    const deployed = await deployModel(existing.model_id, existing.alignment_id, flag("early"));
    await writeManifest({ ...existing, status: deployed ? "DEPLOYED" : existing.status });
    return;
  }

  const documentIds = await uploadDocuments(documents);
  const benchmarkId = await uploadBenchmark(documentIds[0] ?? "", signals);
  const alignmentId = await createAlignmentWithRetry(documentIds, benchmarkId);

  let status: AlignmentStatus;
  if (flag("early")) {
    // Deploy the newest checkpoint as soon as one exists rather than waiting for
    // the run to finish. The GPU serves the latest checkpoint and refreshes on its
    // own, so the id is stable; only the weights move.
    status = await poll<AlignmentStatus>(
      "alignment checkpoint",
      `/alignment-projects/${alignmentId}/status`,
      (body) => body.early_deployable === true || body.status === "READY",
      (body) => body.status === "FAILED",
      15_000,
    );
  } else {
    status = await poll<AlignmentStatus>(
      "alignment",
      `/alignment-projects/${alignmentId}/status`,
      (body) => body.status === "READY" || body.status === "EVALUATED",
      (body) => body.status === "FAILED" || body.status === "STOPPED",
      15_000,
    );
  }
  say(`alignment status: ${status.status}`);

  const modelId = await modelIdFor(alignmentId);
  say(`aligned model: ${modelId}`);
  const deployed = await deployModel(modelId, alignmentId, flag("early"));

  await writeManifest({
    alignment_id: alignmentId,
    model_id: modelId,
    base_model_id: BASE_MODEL,
    status: deployed ? "DEPLOYED" : status.status,
    aligned_at: new Date().toISOString(),
    corpus_documents: documents.length,
    benchmark_id: benchmarkId,
    evaluation: null,
    note:
      "Produced by scripts/nugen-align.ts. `model_id` is what src/llm/nugen.ts sends as `model` to " +
      "/inference/chat/completions and /inference/rerank. Delete this file to fall back to the deterministic classifier.",
  });

  process.stdout.write(
    `\nBase model      ${BASE_MODEL}\n` +
      `Alignment       ${alignmentId}\n` +
      `Aligned model   ${modelId}\n` +
      `Status          ${deployed ? "DEPLOYED" : status.status}\n` +
      `Corpus          ${documents.length} documents\n` +
      `Benchmark       ${benchmarkId ?? "none"}\n\n` +
      `Next: set NUGEN_API_KEY in the app environment. The Digital Twin uses this model\n` +
      `for hazard classification on live social text; the deterministic engine still\n` +
      `computes every number and re-solves the plan.\n\n`,
  );
}

void (async () => {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`\nnugen-align: ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exit(1);
  }
})();
