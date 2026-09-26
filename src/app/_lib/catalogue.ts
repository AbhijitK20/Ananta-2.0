import { readFile } from "node:fs/promises";
import path from "node:path";

import { CITY_MANIFEST, Experience, type CityManifest } from "@/contracts";

/**
 * The catalogue, as the server sees it.
 *
 * WHY THIS FILE EXISTS. The app was serving six hardcoded records to the map,
 * and those records were experience *kinds* rather than places (`kala_ghoda`,
 * `pottery`, `koli`) with no coordinates worth plotting. Meanwhile a real Mumbai
 * catalogue sat in the repository — 40 rows, every one of them parsing clean
 * against the frozen contract, each with real coordinates, OSM opening hours,
 * accessibility flags and per-field provenance. The data existed and the product
 * was not using it.
 *
 * So this reads the committed catalogue, validates it against the frozen
 * contract rather than trusting it, and hands back only what survived. A row
 * that fails validation is dropped and counted, not coerced: a half-populated
 * row that renders as a blank pin is worse than a missing pin, and the count is
 * reported so the gap is visible instead of silent.
 *
 * Cached per process. The file is read from the immutable filesystem of a
 * deployed build, so it cannot change under us, and re-reading 40 rows on every
 * request would be waste. `resetCatalogueCache` exists for tests.
 */
const CITY = "mumbai";

export interface LoadedCatalogue {
  experiences: Experience[];
  manifest: CityManifest | null;
  /** Rows read from disk, before validation. */
  read: number;
  /** Rows dropped because they did not satisfy the frozen contract. */
  rejected: number;
  /** Human-readable reason, or null when everything parsed. */
  problem: string | null;
}

let cached: LoadedCatalogue | null = null;

function dataPath(...parts: string[]): string {
  return path.join(process.cwd(), "data", "cities", CITY, ...parts);
}

export function resetCatalogueCache(): void {
  cached = null;
}

/**
 * Read the committed catalogue for the city.
 *
 * Never throws. A missing file, an unreadable file or a wholly invalid
 * catalogue all return an empty set with `problem` set, because the caller
 * needs to be able to decide what to render and a thrown import would take the
 * whole page down over a data problem.
 */
export async function loadCatalogue(): Promise<LoadedCatalogue> {
  if (cached) return cached;

  let manifest: CityManifest | null = null;
  try {
    const raw = await readFile(dataPath("manifest.json"), "utf8");
    manifest = parseManifest(raw);
  } catch {
    manifest = null;
  }

  let rawRows: unknown[] = [];
  let readError: string | null = null;
  try {
    const text = await readFile(dataPath("experiences.jsonl"), "utf8");
    rawRows = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((row): row is unknown => row !== null);
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }

  const experiences: Experience[] = [];
  let rejected = 0;
  for (const row of rawRows) {
    const parsed = Experience.safeParse(row);
    if (parsed.success) {
      experiences.push(parsed.data);
    } else {
      rejected += 1;
    }
  }

  cached = {
    experiences,
    manifest,
    read: rawRows.length,
    rejected,
    problem:
      readError !== null
        ? `catalogue unreadable: ${readError}`
        : rawRows.length === 0
          ? "catalogue is empty"
          : rejected > 0
            ? `${rejected} of ${rawRows.length} rows failed the frozen contract and were dropped`
            : null,
  };
  return cached;
}

/**
 * Manifest parsing, isolated so a malformed manifest degrades to null instead of
 * taking the page down. Uses the frozen zod schema, so a bad manifest is caught
 * the same way a bad experience row is.
 */
function parseManifest(raw: string): CityManifest | null {
  try {
    const parsed = CITY_MANIFEST.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as CityManifest) : null;
  } catch {
    return null;
  }
}
