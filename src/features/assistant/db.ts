/**
 * The assistant's database handle.
 *
 * Opens the SAME `data/app.db` the seed script writes, through the same
 * `openDatabase` in `src/db/driver.ts`, and runs the same migrations. One
 * database, not a second one: a separate file would mean a second migration
 * story and a second thing to back up, for tables that are two hundred rows of
 * chat transcript.
 *
 * Lazy and memoised because a module-load `openDatabase` in a Next route bundle
 * runs at build time, when there may be no writable `data/` directory — and a
 * route that cannot even be imported cannot report that it is unhealthy, which
 * is the opposite of what this feature is for.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CITY_MANIFEST, type CityManifest } from "@/contracts";
import { openDatabase, type DbHandle } from "@/db/driver";

const ROOT = process.cwd();

let handle: DbHandle | null = null;
/** Set when the open failed, so a second request does not retry a broken path. */
let failure: string | null = null;
/** Which of the three candidates actually opened. Reported on the health endpoint. */
let openedAt: string | null = null;

export function assistantDbFile(): string {
  return process.env.DB_FILE?.trim() || join(ROOT, "data", "app.db");
}

/**
 * Where the assistant's conversations actually live.
 *
 * `data/app.db` is right on a laptop and **impossible on a serverless deploy**:
 * Vercel mounts the project read-only apart from `/tmp`, and `*.db` is gitignored
 * so nothing is shipped anyway. Opening the configured path there throws, and a
 * chat that 500s on a deployed preview is worse than a chat that forgets.
 *
 * So there are three candidates, tried in order, and the one that worked is
 * reported rather than assumed:
 *
 *   1. `DB_FILE` / `data/app.db` — durable, correct for a server or a laptop.
 *   2. `os.tmpdir()` — writable on every platform. On serverless this is a
 *      per-instance tmpfs, so conversations survive within a warm instance and
 *      are lost on cold start. That is a real limitation, surfaced on
 *      `/api/assistant/health` as `storage: "ephemeral"` rather than hidden.
 *   3. `:memory:` — never fails, forgets immediately. The assistant still answers;
 *      the sidebar just comes back empty after a cold start.
 *
 * Degrading rather than failing is this repo's established position (see
 * `resolveWeather` and the twin's `neutralChannels`), and a read-only filesystem
 * is exactly the case it is for.
 */
function candidates(): { file: string; kind: "durable" | "ephemeral" | "memory" }[] {
  const configured = assistantDbFile();
  return [
    { file: configured, kind: "durable" },
    { file: join(tmpdir(), "travelbuddy-assistant.db"), kind: "ephemeral" },
    { file: ":memory:", kind: "memory" },
  ];
}

/**
 * Where conversations will actually be stored, opening the handle if needed.
 *
 * Opening as a side effect is deliberate: the health endpoint calls this before
 * any chat has happened, and reporting `"unknown"` there would be a worse answer
 * than the truth. The handle is a memoised singleton the first chat would open
 * anyway, so nothing is paid twice.
 */
export function storageKind(): "durable" | "ephemeral" | "memory" | "unavailable" {
  try {
    db();
  } catch {
    return "unavailable";
  }
  if (openedAt === null) return "unknown";
  return candidates().find((candidate) => candidate.file === openedAt)?.kind ?? "unknown";
}

/**
 * The city manifest, read strictly.
 *
 * Strict rather than defaulted: `openDatabase` calls `upsertManifest`, which
 * *writes* this row. A fallback manifest invented here would overwrite the real
 * one in the app's own table, and the manifest carries the bounding box and the
 * UTC offset the whole engine depends on. Failing loudly beats corrupting it.
 */
function readManifest(): CityManifest {
  const raw = readFileSync(join(ROOT, "data", "cities", "mumbai", "manifest.json"), "utf8");
  const parsed = CITY_MANIFEST.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `data/cities/mumbai/manifest.json does not satisfy CITY_MANIFEST: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export function db(): DbHandle {
  if (handle) return handle;
  if (failure) throw new Error(failure);
  const errors: string[] = [];
  for (const candidate of candidates()) {
    try {
      handle = openDatabase(candidate.file, readManifest());
      openedAt = candidate.file;
      if (candidate.kind !== "durable") {
        // Not a warning worth a console line on every boot, and never a silent
        // surprise either: it is on the health endpoint.
        process.stderr.write(
          `\nassistant: ${assistantDbFile()} is not writable (${errors.at(-1) ?? "unknown"}).\n` +
            `           Using ${candidate.file} (${candidate.kind}) — conversations will not survive a restart.\n\n`,
        );
      }
      return handle;
    } catch (error) {
      errors.push(`${candidate.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  failure = `assistant store unavailable: ${errors.join(" | ")}`;
  throw new Error(failure);
}

/** Test seam: drop the memoised handle so a fixture DB can take its place. */
export function resetAssistantDb(): void {
  handle?.close();
  handle = null;
  failure = null;
  openedAt = null;
}
