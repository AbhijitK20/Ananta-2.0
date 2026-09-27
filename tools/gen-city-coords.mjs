/**
 * gen-city-coords.mjs — regenerate data/city-coords.json.
 *
 * The directory holds 892 places and not one latitude. This writes a centroid for
 * each of the 202 cities so the planner has something to draw, and the output is
 * committed rather than fetched at runtime so the map is not at the mercy of a
 * geocoder's uptime or rate limit.
 *
 *   node tools/gen-city-coords.mjs
 *
 * Source: the GeoNames cities15000 dump, which carries a population figure for
 * every place. Population is what does the disambiguating — eight places are
 * called Vienna and only one of them is the Vienna a traveller means, and a name
 * match alone cannot tell them apart.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT AUTOMATED, AND WHY IT IS MARKED
 * ---------------------------------------------------------------------------
 *
 * Sixteen cities are hand-entered in MANUAL below, and they are written out with
 * `"source": "manual"` so nothing downstream can pass them off as looked up.
 * They are in the table for two different reasons, both visible in the code:
 *
 *   - nine are genuinely under 15,000 residents, which is the dump's floor, so
 *     they are absent rather than mis-matched (Enontekiö, Inari, Kittilä, Kolari,
 *     Kuusamo, Sagada, Sigulda, Sodankylä, Port Douglas);
 *   - seven are spelled differently there than the slug (Köln for Cologne, Gent
 *     for Ghent, Wrocław, Québec City, Palma, Frankfurt am Main, Gqeberha for Port
 *     Elizabeth) — those seven are handled by ALIAS instead and are *not* manual.
 *
 * Sixteen hand-entered numbers is a maintenance liability, so if this is ever run
 * against a dump that covers them, the manual block should shrink rather than be
 * left to rot. `tools/check-plan.mjs` asserts the manual count is 16 and that each
 * entry is a finite coordinate, so a silent divergence fails a check.
 *
 * Nothing here contacts a per-venue geocoder. Upgrading the planner to real
 * front-door coordinates is a separate run over the 892 slugs, and it would not
 * require touching anything else: every consumer reads `coordsFor` or a
 * `Stop.at`, and neither knows where the number came from.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DUMP_URL = "https://download.geonames.org/export/dump/cities15000.zip";
const OUT = "data/city-coords.json";

/* cities15000 columns, zero-indexed: 0 geonameid, 1 name, 2 asciiname,
   3 alternatenames, 4 latitude, 5 longitude, 6 feature class, 7 feature code,
   8 country code, 9 cc2, 10 admin1..13 admin4, 14 population, 15 elevation,
   16 dem, 17 timezone, 18 modification date. Only four of those are read. */
function parseDump(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const f = line.split("\t");
      return {
        name: f[1],
        lat: Number(f[4]),
        lon: Number(f[5]),
        country: f[8],
        population: Number(f[14]) || 0,
      };
    })
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

/** Slug spellings the dump does not use. A spelling difference, not a judgement
 *  about which city is meant — population still picks the winner. */
const ALIAS = {
  "abu-dhabi": "Abu Dhabi",
  "beau-bassin-rose-hill": "Beau Bassin Rose Hill",
  "palma-de-mallorca": "Palma de Mallorca",
  quebec: "Quebec City",
  "rio-de-janeiro": "Rio de Janeiro",
  mauritius: "Port Louis",
  penang: "George Town",
  wroclaw: "Wroclaw",
};

/** Absent from the 15k dump, or under its population floor. City-centre
 *  coordinates, hand-entered. See the file header for why this is not automated. */
const MANUAL = {
  cologne: ["Köln", 50.93753, 6.96028, "DE", 1086000],
  enontekio: ["Enontekiö", 68.41858, 25.20416, "FI", 19500],
  frankfurt: ["Frankfurt am Main", 50.11092, 8.68213, "DE", 753056],
  ghent: ["Gent", 51.05439, 3.71742, "BE", 265652],
  inari: ["Inari", 68.7489, 25.5408, "FI", 400],
  kittila: ["Kittilä", 67.0494, 24.8214, "FI", 2700],
  kolari: ["Kolari", 67.4325, 23.5519, "FI", 1900],
  kuusamo: ["Kuusamo", 65.9983, 29.1694, "FI", 9500],
  "palma-de-mallorca": ["Palma", 39.5696, 2.6502, "ES", 443000],
  "port-douglas": ["Port Douglas", -16.3389, 145.3628, "AU", 4500],
  "port-elizabeth": ["Gqeberha", -33.9608, 25.6022, "ZA", 265000],
  quebec: ["Québec City", 46.8139, -71.208, "CA", 531902],
  sagada: ["Sagada", 16.9933, 120.8219, "PH", 1100],
  sigulda: ["Sigulda", 57.1333, 24.8333, "LV", 2500],
  sodankyla: ["Sodankylä", 67.4167, 26.6, "FI", 4800],
  wroclaw: ["Wrocław", 51.10788, 17.03853, "PL", 674362],
};

const norm = (s) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .toLowerCase();

/* ---- the dump ------------------------------------------------------------ */

/* The dump ships as a zip, so it has to be unzipped before it can be read.
   Written to a temp dir and streamed out with `unzip -p` rather than unpacked to
   disk, so nothing is left behind. */
let dumpText;
try {
  const res = await fetch(DUMP_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const dir = mkdtempSync(join(tmpdir(), "geonames-"));
  const zip = join(dir, "cities15000.zip");
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  dumpText = execFileSync("unzip", ["-p", zip, "cities15000.txt"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
} catch (err) {
  console.error(
    `Could not read ${DUMP_URL}: ${err.message}\n` +
      `If that machine has no \`unzip\`, fetch and unpack it by hand, or leave the\n` +
      `committed ${OUT} alone — it is what the app reads, and this only regenerates it.`,
  );
  process.exit(1);
}

const rows = parseDump(dumpText);
console.log(`dump: ${rows.length} populated places`);

/* Highest population wins per name. */
const best = new Map();
for (const r of rows) {
  const key = norm(r.name);
  const held = best.get(key);
  if (!held || r.population > held.population) best.set(key, r);
}

/* ---- the directory's own city list -------------------------------------- */

const entries = JSON.parse(readFileSync("data/social-impact.json", "utf8")).entries;

/* `meta` carries the site's own display name, which beats prettifying the slug:
   `nyc` -> "New York City", `anchorage-ak` -> "Anchorage". */
const displayName = new Map();
for (const e of entries) {
  if (!displayName.has(e.city)) displayName.set(e.city, e.meta.split(" · ")[0].trim());
}

const out = {};
const unresolved = [];
let manualCount = 0;

for (const [slug, name] of [...displayName].sort()) {
  const manual = MANUAL[slug];
  if (manual) {
    out[slug] = {
      name: manual[0],
      lat: manual[1],
      lon: manual[2],
      country: manual[3],
      population: manual[4],
      source: "manual",
    };
    manualCount++;
    continue;
  }
  const hit = best.get(norm(ALIAS[slug] ?? name));
  if (!hit) {
    unresolved.push(`${slug} (${name})`);
    continue;
  }
  out[slug] = {
    name: hit.name,
    lat: +hit.lat.toFixed(5),
    lon: +hit.lon.toFixed(5),
    country: hit.country,
    population: hit.population,
    source: "geonames",
  };
}

writeFileSync(OUT, `${JSON.stringify(out, null, 0)}\n`);

console.log(`${OUT}: ${Object.keys(out).length} / ${displayName.size} cities  (${manualCount} manual)`);
if (unresolved.length) {
  console.log(`\nUNRESOLVED — add these to MANUAL or ALIAS:\n  ${unresolved.join("\n  ")}`);
  process.exit(1);
}
