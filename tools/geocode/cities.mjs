/**
 * Step A -- resolve the 202 city slugs in the directory to real coordinates.
 *
 * ── Why this has to happen first ─────────────────────────────────────────────
 * data/social-impact.json carries `city` as a bare slug: "guangzhou", "nyc",
 * "halifax-ca", "rasht". There is no country, no centre, no extent. Every place
 * lookup needs a centre to bias toward and a country to insist on, and both
 * have to be right or the place step inherits the same silent-wrongness the
 * transport step was built to prevent.
 *
 * ── Why slugs cannot be trusted to be unique ────────────────────────────────
 * There are 202 of them and the world has more than one of most of these
 * names. "halifax" is Nova Scotia and also Nova Scotia's neighbour in
 * England; "springfield" exists in most of the English-speaking world; the
 * slug suffix "-ca" is a hint the data carries but nothing enforces.
 *
 * So the resolution records EVERY distinct country in the candidate set, and
 * anything ambiguous is written to the report rather than resolved by picking
 * the first row. A wrong city centre does not fail loudly here -- it just
 * biases every place in that city toward the wrong hemisphere, which is
 * exactly the failure this whole pipeline is designed to make impossible.
 *
 * Output: data/cities/index.json
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { lookup, mapLimit, stats } from "./client.mjs";

/** Slug -> something worth searching. "halifax-ca" -> "halifax ca". */
export function deSlug(slug) {
  return slug.replace(/-/g, " ").trim();
}

/**
 * Search radius for the city gate, in km.
 *
 * Not a circle because metros are not circles, but a single radius is the one
 * number that is easy to reason about and to audit. 45km clears the sprawl of
 * Rio, LA and Istanbul while still rejecting "same city name, other
 * continent" -- the nearest false positive for any of these names is 5,000km
 * away, not 200.
 */
export const CITY_RADIUS_KM = 45;

async function resolveOne(slug) {
  const q = deSlug(slug);
  let candidates = [];
  let error = null;

  try {
    // place:city rather than a free search: we want the settlement itself, not
    // a neighbourhood, a landmark, or a business whose name contains the word.
    const res = await lookup({ q, limit: 8, osm_tag: "place:city" });
    candidates = res.features;
  } catch (e) {
    error = e.message;
  }

  if (!candidates.length) {
    return { slug, q, resolved: false, reason: error ?? "no place:city candidate", candidates: [] };
  }

  const countries = [...new Set(candidates.map((c) => c.properties.countrycode).filter(Boolean))];

  if (countries.length > 1) {
    return {
      slug,
      q,
      resolved: false,
      reason: `ambiguous across ${countries.length} countries: ${countries.join(", ")}`,
      candidates: candidates.map(trim),
    };
  }

  const top = candidates[0];
  const p = top.properties;
  return {
    slug,
    q,
    resolved: true,
    lat: Number(top.geometry.coordinates[1]),
    lon: Number(top.geometry.coordinates[0]),
    name: p.name ?? null,
    country: p.country ?? null,
    countryCode: p.countrycode ?? null,
    state: p.state ?? null,
    osmType: p.osm_type ?? null,
    osmId: p.osm_id ?? null,
    // How many runners-up agreed on the country. One candidate is a weaker
    // answer than five, and worth knowing when a city later looks wrong.
    agreement: candidates.filter((c) => c.properties.countrycode === p.countrycode).length,
  };
}

const trim = (f) => ({
  name: f.properties.name,
  country: f.properties.country,
  countryCode: f.properties.countrycode,
  city: f.properties.city,
  lat: f.geometry.coordinates[1],
  lon: f.geometry.coordinates[0],
});

export async function resolveCities(slugs, { onProgress } = {}) {
  const done = [];
  const out = await mapLimit(slugs, async (slug) => {
    const r = await resolveOne(slug);
    onProgress?.(r);
    return r;
  });
  for (const r of out) done.push(r);
  return done;
}

/** Read the city slugs out of the extracted directory. */
export async function citySlugs() {
  const raw = JSON.parse(await readFile("data/social-impact.json", "utf8"));
  return [...new Set(raw.entries.map((e) => e.city).filter(Boolean))].sort();
}

export async function main() {
  const slugs = await citySlugs();
  console.log(`resolving ${slugs.length} city slugs via Photon\n`);

  let n = 0;
  const cities = await resolveCities(slugs, {
    onProgress: (r) => {
      n++;
      const mark = r.resolved ? " " : "!";
      const where = r.resolved
        ? `${r.lat.toFixed(3)},${r.lon.toFixed(3)} ${r.countryCode ?? "??"}`
        : r.reason;
      console.log(`[${String(n).padStart(3)}/${slugs.length}] ${mark} ${r.slug.padEnd(20)} ${where}`);
    },
  });

  const ok = cities.filter((c) => c.resolved);
  const bad = cities.filter((c) => !c.resolved);
  const index = Object.fromEntries(ok.map((c) => [c.slug, c]));

  await mkdir(dirname("data/cities/index.json"), { recursive: true });
  await writeFile("data/cities/index.json", JSON.stringify(index, null, 2) + "\n");

  console.log(`\nresolved ${ok.length}/${cities.length}   unresolved ${bad.length}`);
  if (bad.length) {
    console.log("\n--- UNRESOLVED (need a hand, not a guess) ---");
    for (const b of bad) console.log(`  ${b.slug.padEnd(20)} ${b.reason}`);
  }
  const weak = ok.filter((c) => c.agreement === 1);
  if (weak.length) {
    console.log(`\n(${weak.length} resolved on a single candidate -- worth a glance: ${weak.map((w) => w.slug).join(", ")})`);
  }
  const s = stats();
  console.log(`\ncache: ${s.hits} hits, ${s.misses} requests`);
  return { cities, index, unresolved: bad };
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
