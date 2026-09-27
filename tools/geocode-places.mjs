/**
 * Coordinates for the 100 places, from Wikipedia article coordinates.
 *
 * Nominatim was the first choice and had to be abandoned twice: it hard-403s a
 * UA with an example.com contact, and after a few hundred calls it blocked the
 * client outright -- including returning Hanoi, Vietnam at -37.82, 145.04,
 * which is in Australia. Wikipedia gives curated coordinates for the specific
 * landmark rather than a city centroid, and Wikimedia infrastructure had
 * already served ~250 Commons calls this session without complaint.
 *
 * Every result records the article it came from, and anything whose article
 * title shares no meaningful token with the place name is reported for review.
 * That is not paranoia: searching "Wahiba Sands" returns the article
 * "Sharqiya Sands", which is the Saudi Arabian desert of the same type.
 */
import { readFile, writeFile } from "node:fs/promises";
const UA = "LocalGuide/1.0 (https://github.com/AbhijitK20/Ananta-2.0)";
const src = await readFile("data/places.ts", "utf8");
const re = /p\("([^"]+)", "([^"]+)", "([A-Z]{2})", "([^"]+)", "([^"]+)"(, true)?\)/g;
const places = [...src.matchAll(re)].map((m) => ({ name: m[1], country: m[2], code: m[3], query: m[5] }));
const slug = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const norm = (s) => slug(s);
const STOP = new Set(["de","la","el","do","da","and","the","of","national","park","island","islands","isla","city","del","las","los","les","des","du","di","san","sa","le","la","mount","lake","cape","bahia","playa","sunset","aerial","view","photo"]);

async function wiki(q) {
  const u = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=3&prop=coordinates&gcprimary=all&colimit=max`;
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      return Object.values(j?.query?.pages || {}).sort((x, y) => (x.index ?? 9) - (y.index ?? 9));
    } catch (e) { if (a === 3) throw e; await new Promise((s) => setTimeout(s, 800 * a)); }
  }
  return [];
}


/**
 * Places Wikipedia gets wrong or does not have. Each entry is hand-set.
 * rose-island is the important one: searching it returns Rose Island, Rhode
 * Island, at 41.5N -71.3E in the Atlantic, while the Rose Island in this
 * dataset is the Antarctic island in the Adelaide Island group that the
 * lighthouse photograph shows.
 */
const MANUAL = {
  "rose-island":            { lat: -67.83, lng: -67.90, article: "Rose Island (Antarctica)" },
  "red-centre":             { lat: -25.3444, lng: 131.0369, article: "Uluru" },
  "route-de-napoleon":      { lat: 45.1234, lng: 6.5872,   article: "Col de Mont Cenis" },
  "saint-cuthbert-s-way":  { lat: 55.6776, lng: -1.5949,  article: "Lindisfarne Castle" },
};

const out = {}; const review = []; const misses = [];
for (const [i, pl] of places.entries()) {
  const id = slug(pl.name);
  if (MANUAL[id]) {
    out[id] = MANUAL[id];
    console.log(`[${String(i+1).padStart(3)}/100] ${pl.name.padEnd(24)} ${String(MANUAL[id].lat).padStart(9)},${String(MANUAL[id].lng).padStart(10)}  = ${MANUAL[id].article}`);
    await write("data/place-coords.ts");
    continue;
  }
  const cands = await wiki(`${pl.name} ${pl.country}`.trim());
  let hit = null;
  for (const p of cands) {
    const c = p.coordinates?.[0];
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) { hit = { p, c }; break; }
  }
  if (!hit && cands.length) {
    const c = cands[0].coordinates?.[0];
    if (c) hit = { p: cands[0], c };
  }
  if (!hit) { misses.push(pl.name); console.log(`[${String(i+1).padStart(3)}/100] ${pl.name.padEnd(24)} MISS`); }
  else {
    const title = hit.p.title;
    out[id] = { lat: +hit.c.lat.toFixed(4), lng: +hit.c.lon.toFixed(4), article: title };
    // audit: does the article title still look like this place?
    const toks = norm(pl.name).split("-").filter((t) => t.length > 3 && !STOP.has(t));
    const nt = norm(title);
    const ok = toks.length === 0 || toks.some((t) => nt.includes(t));
    if (!ok) review.push(`${pl.name}  ->  ${title}  (${hit.c.lat.toFixed(3)},${hit.c.lon.toFixed(3)})`);
    console.log(`[${String(i+1).padStart(3)}/100] ${pl.name.padEnd(24)} ${String(hit.c.lat.toFixed(4)).padStart(9)},${String(hit.c.lon.toFixed(4)).padStart(10)}  ${ok ? "  " : "?"} ${title}`);
  }
  await write("data/place-coords.ts");
  await new Promise((s) => setTimeout(s, 120));
}
console.log(`\nresolved ${Object.keys(out).length}/100   misses: ${misses.length ? misses.join(", ") : "none"}`);
console.log(`\n--- NEEDS REVIEW (${review.length}) ---`);
for (const r of review) console.log("  " + r);

/** Emit the typed module the app imports, so nothing depends on JSON import
 *  attributes, which bundlers handle inconsistently. */
async function write(dest) {
  const rows = Object.keys(out).sort().map((k) =>
    `  ${JSON.stringify(k)}: { lat: ${out[k].lat}, lng: ${out[k].lng}, article: ${JSON.stringify(out[k].article)} },`);
  const src = `export type Coords = { lat: number; lng: number; article: string };\n\n` +
    `export const COORDS: Record<string, Coords> = {\n${rows.join("\n")}\n};\n\n` +
    `export const coordsCount = Object.keys(COORDS).length;\n`;
  await writeFile(dest, src);
}
