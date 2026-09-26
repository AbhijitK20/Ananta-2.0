/**
 * Resolves every place in data/places.ts to a real, freely-licensed photo on
 * Wikimedia Commons and downloads it to public/places/.
 *
 *   node tools/fetch-place-images.mjs            # only the missing ones
 *   node tools/fetch-place-images.mjs --force    # re-fetch everything
 *   node tools/fetch-place-images.mjs "Taj Mahal" # just one, for a quick fix
 *
 * Why Commons and not a stock API: the brief is "famous places", and Commons is
 * where the actual landmark photographs live -- the Taj Mahal, Angkor, the
 * Great Wall, Machu Picchu. A stock search for "famous places" returns
 * postcards. It also needs no API key, and the licence and photographer come
 * back with the file, which is what makes attribution possible at all.
 *
 * Attribution is written to data/place-images.json and rendered in the card
 * overlay. Do not strip it: most of what this fetches is CC BY-SA, which
 * requires crediting the author by name.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const UA = "TravelBuddy-PlaceCarousel/1.0 (offline travel guide; contact: hello@example.com)";
const API = "https://commons.wikimedia.org/w/api.php";
const OUT_DIR = "public/places";
const META = "data/place-images.json";
const WIDTH = 1600;

const force = process.argv.includes("--force");
const only = process.argv.slice(2).find((a) => !a.startsWith("--"));

/** data/places.ts is a TS module, so the entries are read out of the source. */
async function loadPlaces() {
  const src = await readFile("data/places.ts", "utf8");
  const re =
    /p\("([^"]+)", "([^"]+)", "([A-Z]{2})", "([^"]+)", "([^"]+)"(, true)?\)/g;
  return [...src.matchAll(re)].map((m) => ({
    name: m[1],
    country: m[2],
    code: m[3],
    region: m[4],
    query: m[5],
    fromLonelyPlanet: Boolean(m[6]),
  }));
}

const slug = (s) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip the HTML Commons puts in the attribution fields. */
const plain = (html) =>
  String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Titles that are never the thing a card is meant to show.
 *
 * Commons will happily return a locator map, a heraldic emblem or a street plan
 * for a query like "Krakow Poland old town", and all of those are large and
 * landscape-shaped, so they scored *well* on suitability and kept winning. A
 * card wants the landmark, not a diagram of where it is.
 */
const NOT_A_PHOTO =
  /\b(map|maps|plan|plans|locator|coat of arms|arms of|flag|flags|logo|emblem|seal|chart|diagram|graph|scheme|outline|topograph|distribution|range|satellite|ASTER|landsat|sentinel|modis)\b/i;

/**
 * Places where no amount of ranking produces the right *kind* of image, so a
 * specific file is named instead.
 *
 * These are all one failure: the place name doubles as something else, so
 * Commons' best match is a photo of that other thing. Ranking cannot separate
 * "a landscape of Monteverde" from "a bird called Monteverde" -- it only knows
 * text similarity. Each pin below was picked by eye from the search results, and
 * each is a landscape or place scene rather than a taxon.
 */
const PINS = {
  // top match was Grapsus grapsus, i.e. a marine iguana
  "Galápagos Islands": "File:Paisaje de isla Santa Cruz, islas Galápagos, Ecuador, 2015-07-26, DD 71.JPG",
  // top match was Myioborus torquatus, i.e. a collared redstart
  Monteverde: "File:Monteverde Reserve Costa Rica 02.jpg",
  // top match was a NASA ASTER satellite product
  "São Tomé": "File:Sao Tome & Principe, fishermen's beach launch area.jpg",
  // top match was Battery Russell, a fort in Fort Stevens State Park, New York
  Samoa: "File:West on Lalomanu beach Taufua Beach Fales Samoa.jpg",
  // top match was a 1923 American junkyard
  Maryland: "File:Maryland State House from College Ave.JPG",
  // top match was a road sign, "Достык көшесі"
  Astana: "File:Astana 020000, Kazakhstan - panoramio (13).jpg",
  // top match was an airport terminal interior
  "Buenos Aires": "File:Obelisk of Buenos Aires (Obelisco de Buenos Aires - Buenos Aires Argentina (5269820034).jpg",
  // top match carried a camera date stamp burned into the frame
  Alaska: "File:Holgate Glacier, Kenai Fjords NP, Alaska.jpg",
  // top match was a Boundary Waters canoe-area road sign
  "Northeastern Minnesota": "File:Dark sunset over Boundary Waters (Unsplash).jpg",
  // top match was a Churaumi aquarium tank
  Okinawa: "File:Yonezaki Coast at Iheya Island 202603.jpg",
  // top match was an abstract underwater coral shot
  Oman: "File:Desierto de Wahiba, Omán, 2024-08-17, DD 17.jpg",
};

/** Fetch one exact file by title, bypassing search entirely. */
async function fetchCommonsByTitle(title) {
  const url =
    `${API}?action=query&format=json&origin=*` +
    `&titles=${encodeURIComponent(title)}` +
    `&prop=imageinfo&iiprop=url|size|extmetadata|mime` +
    `&iiurlwidth=${WIDTH}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const page = Object.values(json?.query?.pages || {})[0];
      if (!page?.imageinfo?.[0]) return null;
      return { index: 0, title: page.title, ...page.imageinfo[0] };
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(700 * attempt);
    }
  }
  return null;
}

/**
 * Pick the best candidate out of a Commons search.
 *
 * Two terms, and the weighting matters:
 *
 *  - `relevance` is Commons' own ranking, which the API hands back in `index`.
 *    This was ignored entirely at first, which was a real bug: the suitability
 *    term is coarse, so seven good Krakow photographs all scored identically,
 *    and the winner inside that tie was whichever the JSON object happened to
 *    iterate first. The JSON is keyed by pageid and is *not* in rank order --
 *    for "Edinburgh castle Scotland" the index=1 result arrived eighth. So
 *    ties were effectively random, and that is how a street plan of a
 *    different city won Krakow.
 *  - `suitability` then decides between files that match equally well: can
 *    this fill a portrait card without being a thumbnail? Landscape beats
 *    portrait because the card is portrait but the strip crops to a tall 0.72
 *    window, and a wide shot survives that crop better than a tall one does.
 */
function pickBest(candidates) {
  const usable = candidates
    .map((c) => {
      if (!/\.(jpe?g|png)$/i.test(c.title)) return null;
      if (NOT_A_PHOTO.test(c.title.replace(/^File:/, ""))) return null;
      const w = c.width || 0;
      const h = c.height || 0;
      if (!w || !h) return null;
      const meta = c.extmetadata || {};
      const licence = plain(meta.LicenseShortName?.value);
      // Reject anything that is not a photograph or a freely-licensed scan.
      if (meta.Restrictions?.value) return null;
      if (/non-?free|fair use|copyright/i.test(licence)) return null;

      // Deliberately capped below the maximum suitability score, so a
      // well-matched but awkwardly-shaped photo still beats a marginally
      // better-ranked map-like image of the wrong thing.
      const rank = Number.isFinite(c.index) ? c.index : 99;
      const relevance = Math.max(0, 30 - rank * 3);

      const landscape = w / h;
      let suitability = 0;
      if (landscape > 1.15 && landscape < 2.4) suitability += 14; // good band
      else if (landscape >= 1) suitability += 6;
      if (w >= 2400) suitability += 8;
      else if (w >= 1600) suitability += 6;
      else if (w >= 1200) suitability += 3;
      else suitability -= 30; // too small to fill the card
      if (landscape < 0.7) suitability -= 20; // very tall, crops badly
      if (meta.Artwork?.value && /paint|draw|engraving|print/i.test(meta.Artwork.value)) {
        suitability -= 12; // still usable, but a photo reads better at this size
      }
      return {
        title: c.title,
        rank,
        url: c.thumburl || c.url,
        descriptionUrl: c.descriptionurl,
        width: w,
        height: h,
        licence,
        author: plain(meta.Artist?.value) || "Unknown",
        credit: plain(meta.Credit?.value),
        score: relevance + suitability,
      };
    })
    .filter(Boolean);

  // Rank breaks ties explicitly rather than leaning on sort stability.
  usable.sort((a, b) => b.score - a.score || a.rank - b.rank);
  return usable[0] || null;
}

async function searchCommons(query) {
  const url =
    `${API}?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${encodeURIComponent(query)}` +
    `&gsrnamespace=6&gsrlimit=14` +
    `&prop=imageinfo&iiprop=url|size|extmetadata|mime` +
    `&iiurlwidth=${WIDTH}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
        const pages = Object.values(json?.query?.pages || {});
        // `index` is the search rank and lives on the page object, not inside
        // imageinfo, so it has to be carried across explicitly -- spreading
        // imageinfo alone silently drops it and loses Commons' own ranking.
        return pages.map((p) => ({
          index: p.index,
          title: p.title,
          ...p.imageinfo?.[0],
        }));
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(700 * attempt);
    }
  }
  return [];
}

/**
 * Download one image, retrying on failure.
 *
 * The retry matters more here than on the search call. Commons serves
 * thumbnails from a different path than the API and will return 403 under a
 * run of rapid successive downloads, which is exactly what a 100-image sweep
 * is. Without this, a transient refusal permanently loses that place: the
 * first full pass dropped seven of them to bare "HTTP 403" with nothing
 * distinguishing a rate limit from a genuinely missing file.
 */
async function download(url, dest) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 8000) throw new Error(`suspiciously small (${buf.length}b)`);
      await writeFile(dest, buf);
      return buf.length;
    } catch (err) {
      if (attempt === 4) throw err;
      // Back off hard, and longer each time: this is a rate limit, not a bug.
      await sleep(1500 * attempt * attempt);
    }
  }
  return 0;
}

const meta = existsSync(META) ? JSON.parse(await readFile(META, "utf8")) : {};

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(path.dirname(META), { recursive: true });

  let places = await loadPlaces();
  if (only) {
    places = places.filter((x) => x.name.toLowerCase().includes(only.toLowerCase()));
    console.log(`filtered to ${places.length} by "${only}"\n`);
  }

  const results = { ok: [], missing: [], failed: [] };
  let done = 0;

  // Sequential on purpose. Commons is a volunteer-run mirror and does not want
  // 100 parallel API hits from a new client; a slow, well-behaved fetch takes
  // about three minutes and does not get anyone rate-limited.
  for (const place of places) {
    const id = slug(place.name);
    const file = path.join(OUT_DIR, `${id}.jpg`);
    done += 1;
    const label = `[${String(done).padStart(3)}/${places.length}] ${place.name}`.padEnd(34);

    if (!force && existsSync(file) && meta[id]) {
      console.log(`${label} cached`);
      results.ok.push(meta[id]);
      continue;
    }

    try {
      // A pin is a claim that search cannot rank its way to. Fall back to
      // search if the pinned file has since been renamed or deleted upstream.
      const pin = PINS[place.name];
      let best = pin ? pickBest([await fetchCommonsByTitle(pin)].filter(Boolean)) : null;
      if (best) console.log(`${label} pinned  ${best.title}`);
      if (!best) best = pickBest(await searchCommons(place.query));
      if (!best) {
        console.log(`${label} NO MATCH  (query: ${place.query})`);
        results.missing.push(place);
        continue;
      }
      const bytes = await download(best.url, file);
      const record = {
        id,
        name: place.name,
        country: place.country,
        code: place.code,
        region: place.region,
        fromLonelyPlanet: place.fromLonelyPlanet,
        image: `/places/${id}.jpg`,
        commonsTitle: best.title,
        commonsPage: best.descriptionUrl,
        licence: best.licence || "See Commons",
        author: best.author,
        bytes,
      };
      meta[id] = record;
      results.ok.push(record);
      console.log(
        `${label} ok  ${(bytes / 1024).toFixed(0)}kb  ${best.width}x${best.height}  ${record.licence}`,
      );
    } catch (err) {
      console.log(`${label} FAILED  ${err.message}`);
      results.failed.push({ ...place, error: err.message });
    }
    await writeFile(META, JSON.stringify(meta, null, 1));
  }

  await writeFile(META, JSON.stringify(meta, null, 1));

  console.log("\n--- summary ---");
  console.log(`resolved : ${results.ok.length}`);
  console.log(`no match : ${results.missing.length}`);
  console.log(`failed   : ${results.failed.length}`);
  if (results.missing.length) {
    console.log("\nno match — fix the `query` in data/places.ts for:");
    for (const m of results.missing) console.log(`  ${m.name}  ("${m.query}")`);
  }
  if (results.failed.length) {
    console.log("\nfailed — re-run for just these:");
    for (const f of results.failed) console.log(`  ${f.name}  ${f.error}`);
  }
  const total = results.ok.reduce((n, r) => n + r.bytes, 0);
  console.log(`\ntotal image weight: ${(total / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
