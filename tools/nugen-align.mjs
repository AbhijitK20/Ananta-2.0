/**
 * Upload the corpus and run the domain alignment.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * HackCelestial 3.0 makes Nugen Intelligence a mandatory technology: every team
 * must align a base model to its own domain and then run inference on the
 * aligned result. This script is the second half of that chain —
 *
 *     base model -> Nugen alignment -> domain model -> integrated for inference
 *
 * — and it produces the one artefact that makes the claim checkable: a
 * `model_id` that only exists because Nugen's training pipeline ran.
 *
 * ---------------------------------------------------------------------------
 * THE CHAIN, AND WHERE EACH LINK LIVES
 * ---------------------------------------------------------------------------
 *
 *   1. corpus      `npm run corpus:build`  -> data/nugen-corpus/*.txt
 *   2. upload      this script, step 1     -> Nugen document ids
 *   3. align       this script, step 2     -> alignment id
 *   4. model       this script, step 3     -> model_id   <-- the deliverable
 *   5. integrate   lib/nugen/client.ts     -> inference calls carry the model id
 *
 * Steps 1-4 are this file. Step 5 is the app.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RECORD IS WRITTEN TO DISK
 * ---------------------------------------------------------------------------
 *
 * The model id lands in `data/reference/nugen/alignment.json`, and the app reads
 * it at request time. Two reasons:
 *
 *   - The id is a build output, not source. It changes every time the corpus is
 *     rebuilt, so committing it would mean a commit per training run.
 *   - Its *absence* is meaningful. If the record is missing, the app knows no
 *     aligned model exists and says so, rather than silently running the base
 *     model and letting the alignment claim stand unchallenged.
 *
 * ---------------------------------------------------------------------------
 * COST AND IDEMPOTENCE
 * ---------------------------------------------------------------------------
 *
 * Uploads are deduplicated by filename on Nugen's side, so a re-run after a
 * failure costs one alignment job and no re-upload. A previous run of this
 * pipeline failed three times in a row with `HTTP 502` from Nugen's training
 * backend — the corpus and the request were fine, their GPU workers were not —
 * so re-running when it recovers is the expected path, not an edge case.
 *
 * Usage:
 *   NUGEN_API_KEY=... node tools/nugen-align.mjs [--dry-run]
 *
 * `--dry-run` uploads and validates the corpus but does not create an alignment.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load `.env.local` into `process.env` without overwriting anything already set.
 *
 * Next.js does this for the app itself, so `/api/chat` finds the key with no
 * help. This script is plain Node and gets no such treatment, which is a trap
 * worth removing: `npm run nugen:align` would fail with "NUGEN_API_KEY is not
 * set" while the app sitting next to it worked fine, and the obvious conclusion
 * would be that the key was missing rather than that the script had not looked.
 *
 * Deliberately a fifteen-line parser and not a dependency. It handles the subset
 * this file uses — `KEY=value`, `#` comments, optional `export`, optional
 * surrounding quotes — and nothing else. A real dotenv would be a package in
 * `devDependencies` for one call site.
 */
function loadEnvFile() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment wins, so `NUGEN_API_KEY=... npm run nugen:align` still
    // overrides the file rather than being silently ignored.
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

loadEnvFile();

const BASE = process.env.NUGEN_BASE_URL ?? "https://api.nugen.in/api/v3";
const API_KEY = process.env.NUGEN_API_KEY;
const BASE_MODEL = process.env.NUGEN_BASE_MODEL ?? "llama-v3p2-3b-reasoning";
const ALIGNMENT_NAME = process.env.NUGEN_ALIGNMENT_NAME ?? "Local Legends — domain alignment";
const CORPUS_DIR = join(process.cwd(), "data", "nugen-corpus");
const RECORD = join(process.cwd(), "data", "reference", "nugen", "alignment.json");
const DRY_RUN = process.argv.includes("--dry-run");

const POLL_MS = Number(process.env.NUGEN_POLL_MS ?? 15_000);
const ALIGN_TIMEOUT_MS = Number(process.env.NUGEN_ALIGN_TIMEOUT_MS ?? 45 * 60_000);

if (!API_KEY) {
  console.error("NUGEN_API_KEY is not set. Export it and re-run; it is never written to disk by this script.");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, ok: res.ok, json };
}

const stamp = () => `[${String(Math.round(process.uptime())).padStart(5)}s]`;
const log = (...a) => console.log(stamp(), ...a);

/* -------------------------------------------------------------------------- *
 * Step 1 — upload
 * -------------------------------------------------------------------------- */

function corpusFiles() {
  if (!existsSync(CORPUS_DIR)) {
    console.error(`No corpus at ${CORPUS_DIR}. Run \`npm run corpus:build\` first.`);
    process.exit(2);
  }
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".txt"))
    .sort();
}

/**
 * Nugen processes uploads asynchronously, so a document id is not usable until
 * its status reads READY. Creating an alignment against a document still
 * processing is rejected with a 404, which is a confusing way to learn this.
 */
async function waitForReady(ids) {
  const pending = new Set(ids);
  const ready = [];
  const deadline = Date.now() + 10 * 60_000;

  while (pending.size && Date.now() < deadline) {
    for (const id of [...pending]) {
      const { json } = await call(`/documents/${id}/status`);
      const status = json?.status;
      if (status === "READY") {
        ready.push(id);
        pending.delete(id);
      } else if (status && /FAIL|ERROR/i.test(status)) {
        throw new Error(`document ${id} reached ${status}: ${JSON.stringify(json)}`);
      }
    }
    if (pending.size) {
      log(`documents: ${ready.length} ready, ${pending.size} still processing`);
      await sleep(5_000);
    }
  }

  if (pending.size) throw new Error(`documents never became READY: ${[...pending].join(", ")}`);
  return ready;
}

/**
 * Nugen deduplicates by filename and answers 409 when a document of the same
 * name already exists, handing back the id it already has. So before uploading
 * anything, the existing set is listed and matched by filename, and only the
 * genuinely new documents are sent.
 *
 * This is what makes a re-run cheap, and re-runs are the expected path rather
 * than an edge case: the previous run of this pipeline failed three times with
 * an HTTP 502 from Nugen's training backend while the control plane was healthy.
 * A failed alignment should cost one training job, not a corpus upload.
 *
 * The `limit` is not optional and neither is the loop. `/documents/list`
 * returns 10 documents by default, which is silently wrong: with more than ten
 * documents on the account the tail looks absent, the script decides to
 * re-upload it, and the upload comes back 409 on a document that was there all
 * along. It surfaces as a confusing "resolved N ids for M files" error rather
 * than as a pagination problem. The cap is 100 per page, so this pages with
 * `offset` rather than asking for a bigger limit, which is rejected with a 422.
 */
async function existingByName() {
  const byName = new Map();
  const PAGE = 100;
  let offset = 0;

  for (;;) {
    const { ok, json } = await call(`/documents/list?limit=${PAGE}&offset=${offset}`);
    if (!ok || !Array.isArray(json?.documents)) {
      throw new Error(`could not list documents at offset ${offset}: ${JSON.stringify(json)}`);
    }
    for (const d of json.documents) byName.set(d.document_name, d.document_id);
    if (json.documents.length < PAGE) break;
    offset += PAGE;
  }

  log(`Nugen holds ${byName.size} documents`);
  return byName;
}

async function upload(files) {
  const blobs = files.map((f) => {
    const body = readFileSync(join(CORPUS_DIR, f));
    return {
      f,
      chars: body.length,
      sha: createHash("sha256").update(body).digest("hex").slice(0, 12),
    };
  });

  const already = await existingByName();
  const known = blobs
    .filter((b) => already.has(b.f))
    .map((b) => ({ ...b, id: already.get(b.f), reused: true }));
  const fresh = blobs.filter((b) => !already.has(b.f));

  log(`corpus: ${blobs.length} documents · ${known.length} already on Nugen · ${fresh.length} to upload`);

  let ids = known.map((b) => b.id);
  if (fresh.length) {
    const form = new FormData();
    for (const b of fresh) {
      form.append("files", new Blob([readFileSync(join(CORPUS_DIR, b.f))], { type: "text/plain" }), b.f);
    }
    form.append("categories", "local-legends-domain");

    const { ok, status, json } = await call("/documents/create", { method: "POST", body: form });
    if (status === 409 && json?.detail?.document_id) {
      // A race, or a document created between the list and the upload. Take the
      // id it offers and re-list rather than treating a benign conflict as fatal.
      log(`409 on upload, re-listing: ${json.detail.message ?? ""}`);
      const retry = await existingByName();
      ids = blobs.map((b) => retry.get(b.f)).filter(Boolean);
    } else if (!ok) {
      throw new Error(`upload failed: HTTP ${status} ${JSON.stringify(json)}`);
    } else {
      ids = [...ids, ...(json?.document_ids ?? [])];
      log(`uploaded ${json?.document_ids?.length ?? 0} new document ids`);
    }
  }

  if (ids.length !== files.length) {
    throw new Error(
      `resolved ${ids.length} document ids for ${files.length} corpus files. ` +
        `Nugen deduplicates by filename, so a missing id means a file was neither ` +
        `uploaded nor already present. Check /documents/list.`,
    );
  }
  log(`resolved ${ids.length} document ids total`);
  return { ids, blobs };
}

/* -------------------------------------------------------------------------- *
 * Step 2 — create the alignment
 * -------------------------------------------------------------------------- */

async function createAlignment(documentIds) {
  const { ok, status, json } = await call("/alignment-projects/create", {
    method: "POST",
    body: JSON.stringify({
      alignment_name: ALIGNMENT_NAME,
      base_model_id: BASE_MODEL,
      document_ids: documentIds,
      workflow_id: "hackcelestial3-local-legends",
      description:
        "Domain alignment for the Local Legends assistant: 890 curated local picks across 202 cities, " +
        "222 quests, the XP and streak rules, plus the site's own editorial. The corpus states its own " +
        "coverage gaps so the model refuses rather than inventing a place.",
    }),
  });
  if (!ok) throw new Error(`alignment create failed: HTTP ${status} ${JSON.stringify(json)}`);
  log(`alignment ${json.alignment_id} created on ${BASE_MODEL}`);
  return json.alignment_id;
}

/* -------------------------------------------------------------------------- *
 * Step 3 — poll to a model id
 * -------------------------------------------------------------------------- */

/**
 * A failure here is usually Nugen-side, not ours. The control plane answers, the
 * corpus is accepted and the project is created and queued; if the job then dies
 * with 502 it is their training backend, and the right response is to re-run
 * this script rather than to change the corpus.
 */
async function awaitAlignment(alignmentId) {
  const deadline = Date.now() + ALIGN_TIMEOUT_MS;
  let last = "";

  while (Date.now() < deadline) {
    const { json } = await call(`/alignment-projects/${alignmentId}/status`);
    const s = json?.status ?? "UNKNOWN";
    if (s !== last) {
      log(`alignment: ${s}${json?.queue_position != null ? ` (queue position ${json.queue_position})` : ""}`);
      last = s;
    }

    // Nugen signals success with READY, not COMPLETED. Waiting for "COMPLETED"
    // here is what made an eight-minute successful run look like a hang: the job
    // finished, the model existed, and this loop sat polling for a state the API
    // never uses. Both are accepted, and a model id is the real test of success.
    if (s === "READY" || s === "COMPLETED") {
      let modelId = json?.model_id ?? json?.aligned_model_id;
      if (!modelId) {
        // The detail endpoint carries model_id; the status endpoint does not.
        const detail = await call(`/alignment-projects/${alignmentId}`);
        modelId = detail.json?.model_id;
        if (modelId) json = detail.json;
      }
      if (!modelId) {
        throw new Error(`${s} but no model_id on either endpoint: ${JSON.stringify(json)}`);
      }
      return { modelId, json };
    }

    if (/FAIL|ERROR|CANCEL/i.test(s)) {
      throw new Error(
        `alignment ${s}: ${json?.error ?? json?.detail ?? JSON.stringify(json)}\n` +
          `  This is Nugen's training pipeline, not the request. Re-run this script when it recovers.`,
      );
    }

    await sleep(POLL_MS);
  }
  throw new Error(`alignment did not finish within ${ALIGN_TIMEOUT_MS}ms (last status ${last})`);
}

/* -------------------------------------------------------------------------- */

/**
 * Deploy a freshly trained model and wait for it to report ready.
 *
 * Asynchronous: the call returns immediately and `deployment_status` stays
 * UNDEPLOYED for a couple of minutes afterwards.
 */
async function deploy(modelId) {
  const start = await call(`/models/${modelId}/deployment`, { method: "POST", body: "{}" });
  if (!start.ok) {
    log(`deploy request returned HTTP ${start.status}; the model id remains valid`);
    return false;
  }
  log(`deploy requested for ${modelId}`);

  const deadline = Date.now() + 15 * 60_000;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await call(`/models/${modelId}`);
    const s = json?.deployment_status ?? null;
    if (s !== last) {
      log(`deployment status: ${s}`);
      last = s;
    }
    if (s && s !== "UNDEPLOYED" && s !== "DEPLOYING" && s !== "PENDING") return true;
    await sleep(20_000);
  }
  log("deployment did not report ready within 15 minutes");
  return false;
}

async function main() {
  const files = corpusFiles();
  log(`corpus: ${files.length} text documents from ${CORPUS_DIR}`);

  const { ids, blobs } = await upload(files);
  const ready = await waitForReady(ids);
  log(`all ${ready.length} documents READY`);

  if (DRY_RUN) {
    log("--dry-run: stopping before alignment creation.");
    log(JSON.stringify({ documents: files.length, ready: ready.length, baseModel: BASE_MODEL }, null, 2));
    return;
  }

  const alignmentId = await createAlignment(ready);
  const { modelId, json } = await awaitAlignment(alignmentId);

  // A trained model is not a served model. `model_id` arrives with
  // `deployment_status: UNDEPLOYED`, and inference against an undeployed id
  // fails in a way that does not name the missing step -- a 404 on the model, or
  // a 504 from the inference backend. So deploying is part of producing a usable
  // id, not an optional extra, and it happens here rather than being left to
  // whoever deploys next.
  const deployed = await deploy(modelId);

  mkdirSync(join(process.cwd(), "data", "reference", "nugen"), { recursive: true });
  const record = {
    model_id: modelId,
    alignment_id: alignmentId,
    base_model_id: BASE_MODEL,
    alignment_name: ALIGNMENT_NAME,
    status: "READY",
    completed_at: json?.completed_at ?? new Date().toISOString(),
    deployed,
    document_count: ready.length,
    document_chars: blobs.reduce((n, b) => n + b.chars, 0),
    document_sha256: blobs.map((b) => ({ file: b.f, chars: b.chars, sha256_12: b.sha })),
    gpu_training_completed: true,
  };
  writeFileSync(RECORD, JSON.stringify(record, null, 2) + "\n", "utf8");

  log(`MODEL ID: ${modelId}`);
  log(`record written to ${RECORD}`);
}

main().catch((err) => {
  console.error(`\nnugen-align failed: ${err.message}`);
  process.exit(1);
});
