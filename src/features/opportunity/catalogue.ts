/**
 * The offline catalogue: the committed curated snapshot under `content/`.
 *
 * This exists so the opportunity engine can be exercised against REAL rows —
 * 133 curated experiences across Bandra, Colaba, Fort, Marine Drive and the
 * adjacent areas, every field carrying provenance — instead of a hand-written
 * fixture that agrees with whatever the code happens to do. A pipeline proven on
 * data we wrote to match it proves nothing.
 *
 * The rows are parsed with the CONTRACT's own `Experience` schema, so a snapshot
 * that has drifted from the contract fails here loudly rather than producing an
 * opportunity off a field that no longer means what the engine thinks.
 *
 * ponytail: ceiling — synchronous `readFileSync` over five files, resolved
 * relative to this module. Add when the catalogue outgrows a snapshot: swap for
 * the `src/db` repository (Abhijit's) and keep this as the offline fallback the
 * demo runs against, which is what the snapshot is for anyway.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Experience } from "../../contracts";

const CONTENT_DIR = join(process.cwd(), "content", "experiences");

/** Every `*.jsonl` in the snapshot, in filename order so the array is stable. */
export function catalogueFiles(dir: string = CONTENT_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * The whole snapshot as contract rows. Sorted by id so two runs on the same
 * files produce byte-identical arrays — every downstream count depends on it.
 */
export function loadCatalogue(dir: string = CONTENT_DIR): Experience[] {
  const rows: Experience[] = [];
  for (const file of catalogueFiles(dir)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      rows.push(Experience.parse(JSON.parse(line)));
    }
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Distinct `neighbourhood` values in the snapshot, sorted. */
export function catalogueNeighbourhoods(catalogue: readonly Experience[]): string[] {
  return [...new Set(catalogue.map((row) => row.neighbourhood).filter((n): n is string => n !== null))].sort();
}
