/**
 * content/tools/validate-content.ts — the single runnable check for content/**.
 *
 * Why this exists rather than a pytest: the whole point of the curated layer is
 * that every field is honest about where it came from, and a wrong field is a
 * hard-constraint failure at query time that nobody notices until the demo.
 *
 * It checks four things, in order of how badly they hurt:
 *
 *   1. SCHEMA. Every line parses as the frozen `Experience` contract. The
 *      contract is imported, never restated, so a contract change breaks here
 *      rather than silently passing.
 *   2. CROSS-REFERENCE. Reviews, events and eval scenarios only name ids that
 *      exist. A dangling id is a dead card.
 *   3. DERIVED RATINGS. `rating` is recomputed from `content/reviews`. Ratings
 *      are derived data, so deriving them here is the correct home for them —
 *      hand-maintaining 114 of them is how they drift.
 *   4. COPY. Banned AI-slop phrases, over-long blurbs, and descriptions that
 *      restate the blurb.
 *
 * Usage:
 *   npx tsx content/tools/validate-content.ts
 *   npx tsx content/tools/validate-content.ts --write-ratings
 *   npx tsx content/tools/validate-content.ts --index
 *   npx tsx content/tools/validate-content.ts --json
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Experience, RejectionCode, CONTRACT_VERSION } from "../../src/contracts/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const EXP = join(ROOT, "content/experiences");
const REV_DIR = join(ROOT, "content/reviews");
const EVT = join(ROOT, "content/events/events.jsonl");
const ECL = join(ROOT, "content/evaluation/scenarios.jsonl");

const argv = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Rating smoothing. Declared here, once, so it is auditable and reproducible.
// Shrink toward a regional prior; the prior and the prior weight are both
// stated rather than buried. docs/DATA_SPEC.md §5 allows Wilson lower bound
// instead; if the engine swaps this, delete --write-ratings and hand the
// numbers over.
// ---------------------------------------------------------------------------
const RATING_PRIOR = 4.1;
const RATING_PRIOR_WEIGHT = 12;

type Rec = Record<string, unknown> & { id: string; __meta?: Record<string, unknown> };
type Line = { file: string; no: number; raw: string; rec?: Rec };

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

function readJsonl(path: string): Line[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((raw, i) => ({ file: path.slice(ROOT.length + 1), no: i + 1, raw }))
    .filter((l) => l.raw.trim().length > 0)
    .map((l) => {
      try {
        return { ...l, rec: JSON.parse(l.raw) as Rec };
      } catch (e) {
        fail(`${l.file}:${l.no} not valid JSON — ${(e as Error).message}`);
        return l;
      }
    });
}

// --- 1. schema -------------------------------------------------------------

const expFiles = readdirSync(EXP).filter((f) => f.endsWith(".jsonl")).sort();
const expLines = expFiles.flatMap((f) => readJsonl(join(EXP, f)));
const byId = new Map<string, Line>();
const parsed: Experience[] = [];

for (const l of expLines) {
  if (!l.rec) continue;
  const id = typeof l.rec.id === "string" ? l.rec.id : "?";
  if (byId.has(id)) fail(`duplicate experience id "${id}" (${l.file}:${l.no} and ${byId.get(id)!.file}:${byId.get(id)!.no})`);
  else byId.set(id, l);
  const r = Experience.safeParse(l.rec);
  if (!r.success) {
    for (const i of r.error.issues) fail(`${l.file}:${l.no} ${id} · ${i.path.join(".") || "(root)"}: ${i.message}`);
    continue;
  }
  parsed.push(r.data);
  if (!l.rec.__meta) fail(`${l.file}:${l.no} ${id} · missing __meta (every record must declare synthetic / estimateBasis)`);
  if (l.rec.__meta && typeof l.rec.__meta.synthetic !== "boolean")
    fail(`${l.file}:${l.no} ${id} · __meta.synthetic must be a boolean`);
}

// --- 2. cross references ---------------------------------------------------

const revLines = readJsonlSafe(REV_DIR).map(parse);
const evtLines = readFileSafe(EVT).map(parse);
const scnLines = readFileSafe(ECL).map(parse);

function readFileSafe(p: string): Line[] {
  return existsSync(p) ? readJsonl(p) : [];
}
function readJsonlSafe(dir: string): Line[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().flatMap((f) => readJsonl(join(dir, f)));
}
function parse(l: Line): Line {
  return l;
}

const SENTIMENT_FOR_RATING: Record<string, [number, number]> = { negative: [1, 2], mixed: [3, 3], positive: [4, 5] };
/** Paise. What a party may plausibly spend at a free-ENTRY record, per person. */
const FREE_ENTRY_SPEND_CEILING_PER_PERSON = 300000;

const revByExp = new Map<string, number[]>();
const REVIEWS_PER_EXPERIENCE_MIN = 2;
for (const l of revLines) {
  if (!l.rec) continue;
  const eid = String(l.rec.experienceId ?? "");
  const r = parsed.find((p) => p.id === eid);
  if (!r) {
    fail(`${l.file}:${l.no} review references unknown experienceId "${eid}"`);
    continue;
  }
  const rating = l.rec.rating;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5)
    fail(`${l.file}:${l.no} ${eid} · review rating must be an integer 1..5, got ${String(rating)}`);
  if (typeof l.rec.partySize !== "number" || l.rec.partySize < 1)
    fail(`${l.file}:${l.no} ${eid} · review partySize must be >= 1`);
  if (l.rec.synthetic !== true) fail(`${l.file}:${l.no} ${eid} · review must carry synthetic: true`);
  if (typeof l.rec.text !== "string" || l.rec.text.length < 25)
    fail(`${l.file}:${l.no} ${eid} · review text must be a real sentence, not a stub`);
  // sentiment has to agree with the star rating, or the Bayesian average is meaningless
  const band = SENTIMENT_FOR_RATING[String(l.rec.sentiment)];
  if (!band) fail(`${l.file}:${l.no} ${eid} · unknown sentiment "${String(l.rec.sentiment)}"`);
  else if (typeof rating === "number" && (rating < band[0] || rating > band[1]))
    fail(`${l.file}:${l.no} ${eid} · sentiment "${String(l.rec.sentiment)}" contradicts rating ${rating}`);
  // spend has to be plausible for the party and the price on the experience
  const spend = l.rec.spendMinor;
  if (typeof spend !== "number" || spend < 0) fail(`${l.file}:${l.no} ${eid} · spendMinor must be >= 0`);
  else if (r.pricePerPerson && typeof l.rec.partySize === "number") {
    const ideal = r.pricePerPerson.minor * (l.rec.partySize as number);
    if (spend > ideal * 3 + 50000) fail(`${l.file}:${l.no} ${eid} · spendMinor ${spend} is more than 3x price x partySize (${ideal})`);
  } else if (!r.pricePerPerson && typeof l.rec.partySize === "number") {
    // pricePerPerson null means free ENTRY, not free visit. A market, a bazaar
    // and a craft shop all have no ticket and still cost money, so cap the
    // incidental spend instead of demanding zero.
    const ceiling = FREE_ENTRY_SPEND_CEILING_PER_PERSON * (l.rec.partySize as number);
    if (spend > ceiling)
      fail(`${l.file}:${l.no} ${eid} · free entry but spendMinor ${spend} exceeds the ₹${FREE_ENTRY_SPEND_CEILING_PER_PERSON}/person incidental ceiling (${ceiling})`);
  }
  const list = revByExp.get(eid) ?? [];
  list.push(Number(rating));
  revByExp.set(eid, list);
}

for (const l of evtLines) {
  if (!l.rec) continue;
  const eid = String(l.rec.experienceId ?? "");
  if (eid !== "" && !byId.has(eid)) fail(`${l.file}:${l.no} event references unknown experienceId "${eid}"`);
  if (l.rec.synthetic !== true) fail(`${l.file}:${l.no} event must carry synthetic: true`);
  if (l.rec.provenance === "osm") fail(`${l.file}:${l.no} event must not claim osm provenance; events are authored, not harvested`);
  // Dates are plain strings, so nothing downstream will catch a typo in one.
  for (const k of ["startDate", "endDate"]) {
    const v = l.rec[k];
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
      fail(`${l.file}:${l.no} event ${String(l.rec.id)} · ${k} must be YYYY-MM-DD, got ${JSON.stringify(v)}`);
  }
  if (typeof l.rec.startDate === "string" && typeof l.rec.endDate === "string" && l.rec.endDate < l.rec.startDate)
    fail(`${l.file}:${l.no} event ${String(l.rec.id)} · endDate is before startDate`);
  const om = l.rec.openMin, cm = l.rec.closeMin, dm = l.rec.durationMin;
  if (typeof om !== "number" || typeof cm !== "number" || cm <= om)
    fail(`${l.file}:${l.no} event ${String(l.rec.id)} · closeMin must be a real closing time, got ${om}..${cm}`);
  if (typeof dm !== "number" || typeof cm === "number" && typeof om === "number" && dm > cm - om)
    fail(`${l.file}:${l.no} event ${String(l.rec.id)} · durationMin ${dm} does not fit inside the opening window`);
  if (l.rec.capacity !== null && (typeof l.rec.capacity !== "number" || l.rec.capacity < 1))
    fail(`${l.file}:${l.no} event ${String(l.rec.id)} · capacity must be a positive integer or null`);
}

const knownIds = new Set(byId.keys());
const REJECTION_CODES: string[] = RejectionCode.options;
for (const l of scnLines) {
  if (!l.rec) continue;
  const sid = String(l.rec.id ?? "?");
  const refs = [
    ...(l.rec.acceptableIds as string[] | undefined ?? []),
    ...(l.rec.forbiddenIds as string[] | undefined ?? []),
  ];
  for (const id of refs) if (!knownIds.has(id)) fail(`${l.file}:${l.no} scenario "${sid}" references unknown id "${id}"`);
  for (const k of Object.keys((l.rec.forbiddenBecause as object | undefined) ?? {}))
    if (!knownIds.has(k)) fail(`${l.file}:${l.no} scenario "${sid}" forbiddenBecause names unknown id "${k}"`);

  // Every forbidden id needs a code, and the code has to exist in the frozen
  // contract. A scenario that invents a rejection code is worse than no
  // scenario, because the harness would then assert against a string the engine
  // can never emit.
  const fb = (l.rec.forbiddenBecause as Record<string, string> | undefined) ?? {};
  const forbidden = (l.rec.forbiddenIds as string[] | undefined) ?? [];
  for (const id of forbidden)
    if (!(id in fb)) fail(`${l.file}:${l.no} scenario "${sid}" forbids "${id}" with no forbiddenBecause code`);
  for (const [id, code] of Object.entries(fb)) {
    if (!forbidden.includes(id)) fail(`${l.file}:${l.no} scenario "${sid}" gives a code for "${id}", which is not in forbiddenIds`);
    if (!REJECTION_CODES.includes(code))
      fail(`${l.file}:${l.no} scenario "${sid}" uses rejection code "${code}" for "${id}", which is not in the contract`);
  }
  for (const id of refs) if (forbidden.includes(id) && (l.rec.acceptableIds as string[]).includes(id))
    fail(`${l.file}:${l.no} scenario "${sid}" lists "${id}" as both acceptable and forbidden`);

  // `original` is the trip the traveller actually asked for. The replanner
  // diffs against it forever, so a scenario whose `original` disagrees with its
  // own live context is testing the wrong thing.
  const ctx = l.rec.context as Record<string, unknown> | undefined;
  const orig = ctx?.original as Record<string, unknown> | undefined;
  if (!ctx || !orig) fail(`${l.file}:${l.no} scenario "${sid}" is missing context or context.original`);
  else {
    for (const k of ["availableMin", "partySize"] as const)
      if (ctx[k] !== orig[k]) fail(`${l.file}:${l.no} scenario "${sid}" · context.${k} (${String(ctx[k])}) disagrees with original.${k} (${String(orig[k])})`);
    if (JSON.stringify(ctx.budget) !== JSON.stringify(orig.budget))
      fail(`${l.file}:${l.no} scenario "${sid}" · context.budget disagrees with original.budget`);
    if (JSON.stringify(ctx.accessNeeds) !== JSON.stringify(orig.accessNeeds))
      fail(`${l.file}:${l.no} scenario "${sid}" · context.accessNeeds disagrees with original.accessNeeds`);
    if (typeof ctx.nowMin !== "number" || ctx.nowMin < 0 || ctx.nowMin > 1440)
      fail(`${l.file}:${l.no} scenario "${sid}" · nowMin must be 0..1440, got ${String(ctx.nowMin)}`);
  }
  if (typeof l.rec.expectCoverage !== "boolean") fail(`${l.file}:${l.no} scenario "${sid}" · expectCoverage must be a boolean`);
  if (!l.rec.assertions || typeof l.rec.assertions !== "object") fail(`${l.file}:${l.no} scenario "${sid}" · assertions block is required`);
  if (typeof l.rec.why !== "string" || l.rec.why.length < 30)
    fail(`${l.file}:${l.no} scenario "${sid}" · needs a one-line "why" of at least 30 characters`);

  const rp = l.rec.replan as Record<string, unknown> | undefined;
  if (rp) {
    for (const k of ["expectAddedIds", "expectRemovedIds", "expectKeptIntentTerms"] as const)
      for (const id of (rp[k] as string[] | undefined) ?? [])
        if (k !== "expectKeptIntentTerms" && !knownIds.has(id)) fail(`${l.file}:${l.no} scenario "${sid}" replan.${k} names unknown id "${id}"`);
    const ch = rp.change as Record<string, unknown> | undefined;
    if (!ch || typeof ch.narrative !== "string")
      fail(`${l.file}:${l.no} scenario "${sid}" replan needs a change with a human narrative, not just a patch`);
    if (typeof rp.maxSwaps !== "number") fail(`${l.file}:${l.no} scenario "${sid}" replan needs maxSwaps`);
  }
}

// --- 3. derived ratings ----------------------------------------------------

type Fix = { file: string; before: string; after: string };
const fixes: Fix[] = [];
let coldStart = 0;

for (const l of expLines) {
  if (!l.rec) continue;
  const id = l.rec.id as string;
  const rs = revByExp.get(id) ?? [];
  const cur = l.rec.rating as { value: number; count: number; rawMean: number | null } | undefined;
  if (rs.length < REVIEWS_PER_EXPERIENCE_MIN) {
    // Cold start. Legal, but only if it was declared and the record really has
    // no signal — otherwise it is a bug in the seeding, not a product state.
    coldStart++;
    if (cur && cur.count !== 0) fail(`${l.file}:${l.no} ${id} · claims count=${cur.count} but only ${rs.length} reviews exist`);
    if (l.rec.__meta?.ratingless !== true)
      fail(`${l.file}:${l.no} ${id} · only ${rs.length} reviews, so the rating must stay empty; set __meta.ratingless = true to declare a cold-start record`);
    continue;
  }
  if (l.rec.__meta?.ratingless === true)
    fail(`${l.file}:${l.no} ${id} · declares __meta.ratingless but has ${rs.length} reviews`);
  const n = rs.length;
  const sum = rs.reduce((a, b) => a + b, 0);
  const rawMean = Math.round((sum / n) * 100) / 100;
  const value = Math.round(((sum + RATING_PRIOR_WEIGHT * RATING_PRIOR) / (n + RATING_PRIOR_WEIGHT)) * 100) / 100;
  if (!cur) continue;
  if (cur.count === n && Math.abs((cur.rawMean ?? -1) - rawMean) < 0.005 && Math.abs(cur.value - value) < 0.005) continue;
  const before = l.raw;
  const after = l.raw.replace(
    /"rating":\{[^}]*\}/,
    `"rating":{"value":${value},"count":${n},"rawMean":${rawMean}}`,
  );
  if (before === after) {
    fail(`${l.file}:${l.no} ${id} · could not rewrite rating; check the field shape`);
    continue;
  }
  if (argv.has("--write-ratings")) {
    fixes.push({ file: join(ROOT, l.file), before, after });
  } else {
    fail(`${l.file}:${l.no} ${id} · rating drift: file has count=${cur.count} rawMean=${cur.rawMean} value=${cur.value}; reviews give count=${n} rawMean=${rawMean} value=${value} (prior ${RATING_PRIOR}, weight ${RATING_PRIOR_WEIGHT}) — re-run with --write-ratings`);
  }
}
// One write per file, not per line. Grouping here is not tidiness: writing each
// fix as its own `writeFileSync` silently truncates the file to the last line.
const byFile = new Map<string, Fix[]>();
for (const f of fixes) (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f);
for (const [file, group] of byFile) {
  let text = readFileSync(file, "utf8");
  for (const f of group) {
    if (!text.includes(f.before)) {
      fail(`${file.replace(ROOT + "\\", "")} · rating rewrite aborted: the line changed underneath us. Re-run.`);
      continue;
    }
    text = text.replace(f.before, f.after);
  }
  writeFileSync(file, text, "utf8");
}

// --- 4. copy ---------------------------------------------------------------

const SLOP = [
  "world-class", "world class", "seamless", "unforgettable", "must-visit",
  "must visit", "perfect for everyone", "hidden gem", "must see", "must-see",
  "nestled", "bustling", "vibrant", "picturesque", "treasure trove",
  "culinary delight", "embark", "a journey", "escape to", "savour the",
  "savor the", "tantalizing", "tantalising", "mouth-watering", "must try",
  "must-try", "not to be missed", "is a must", "something for everyone",
];
for (const l of expLines) {
  if (!l.rec) continue;
  const id = l.rec.id as string;
  const blurb = (l.rec.blurb as string | null) ?? "";
  const desc = (l.rec.description as string | null) ?? "";
  for (const phrase of SLOP) {
    const re = new RegExp(`\\b${phrase}\\b`, "i");
    if (re.test(blurb)) fail(`${l.file}:${l.no} ${id} · blurb contains banned phrase "${phrase}"`);
    if (re.test(desc)) fail(`${l.file}:${l.no} ${id} · description contains banned phrase "${phrase}"`);
  }
  if (blurb.length > 200) fail(`${l.file}:${l.no} ${id} · blurb is ${blurb.length} chars; a card line is <= 200`);
  if (desc.length > 520) fail(`${l.file}:${l.no} ${id} · description is ${desc.length} chars; keep it under 520`);
  if (blurb && desc && desc.toLowerCase().startsWith(blurb.toLowerCase().slice(0, 30)))
    fail(`${l.file}:${l.no} ${id} · description restates the blurb`);
  if (!(l.rec.keywords as string[]).length) fail(`${l.file}:${l.no} ${id} · no keywords; FTS has nothing to hit`);
  const p = l.rec.perception as { landscape: string[]; activities: string[]; atmosphere: string[] };
  for (const dim of ["landscape", "activities", "atmosphere"] as const) {
    if (!p?.[dim]?.length) fail(`${l.file}:${l.no} ${id} · perception.${dim} is empty`);
  }

  // Contradictory pairs. This makes the engine draw the wrong conclusion from a
  // row that parses perfectly, which is worse than a parse error: it is invisible
  // until the demo keeps a place in the rain that should have been dropped.
  //
  // Only genuine contradictions belong here. `outdoor` + weatherSensitive "none"
  // is NOT one: "none" means weather does not RUIN it, and a stone clock tower in
  // the monsoon is exactly that. Only `indoor` + a weather value is incoherent,
  // because it claims the weather both cannot reach the place and ruins it. The
  // fix is `mixed`, which is what the enum's `mixed` member is for.
  if (l.rec.indoorOutdoor === "indoor" && l.rec.weatherSensitive === "rain")
    fail(`${l.file}:${l.no} ${id} · indoorOutdoor "indoor" contradicts weatherSensitive "rain"; use "mixed" if part of the visit is exposed`);
}

// --- report ----------------------------------------------------------------

const tally = <T extends string>(xs: T[]) => {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const cols = (a: [string, number][], n = 62) => {
  const w = Math.max(4, Math.floor(n / Math.max(a.length, 1)) - 2);
  return a.map(([k, v]) => `${k}`.padEnd(w) + String(v).padStart(4)).join("\n");
};
const money = (r: Experience) => (r.pricePerPerson ? r.pricePerPerson.minor / 100 : 0);
const dur = (r: Experience) => r.durationMin;

console.log(`\ncontent check · contract v${CONTRACT_VERSION}\n${"=".repeat(64)}`);
console.log(`\nexperiences  ${parsed.length} across ${expFiles.length} files`);
console.log(cols(tally(expLines.map((l) => (l.rec ? `${l.file.split("/").pop()!.replace(".jsonl", "")}` : "?")).filter((x) => x !== "?")).map(([k, v]) => [`  ${k}`, v] as [string, number])));
console.log(`\nlocalities\n${cols(tally(parsed.map((p) => p.neighbourhood ?? "?")).map(([k, v]) => [`  ${k}`, v] as [string, number]))}`);
console.log(`\ncategories in use: ${new Set(parsed.map((p) => p.category)).size} of 26`);
console.log(cols(tally(parsed.map((p) => p.category)).map(([k, v]) => [`  ${k}`, v] as [string, number])));
console.log(`\nindoor/outdoor\n${cols(tally(parsed.map((p) => p.indoorOutdoor)).map(([k, v]) => [`  ${k}`, v] as [string, number]))}`);
const free = parsed.filter((p) => p.pricePerPerson === null).length;
const under100 = parsed.filter((p) => money(p) > 0 && money(p) <= 100).length;
const over2000 = parsed.filter((p) => money(p) > 2000).length;
console.log(`\nprice  free ${free} · <=100 ${under100} · >2000 ${over2000}`);
console.log(`duration  min ${Math.min(...parsed.map(dur))} · median ${[...parsed.map(dur)].sort((a, b) => a - b)[Math.floor(parsed.length / 2)]} · max ${Math.max(...parsed.map(dur))}`);
const short = parsed.filter((p) => dur(p) <= 30).length;
const long = parsed.filter((p) => dur(p) >= 120).length;
console.log(`          <=30 min ${short} · >=120 min ${long}`);

const accKeys = ["stepFree", "strollerOk", "lowStairs", "seatingAvailable", "hearingLoop", "restroomOnSite"] as const;
console.log(`\naccessibility coverage (true / false / null)`);
for (const k of accKeys) {
  const t = parsed.filter((p) => p.accessibility[k] === true).length;
  const f = parsed.filter((p) => p.accessibility[k] === false).length;
  const n = parsed.filter((p) => p.accessibility[k] === null).length;
  console.log(`  ${k.padEnd(18)} ${String(t).padStart(3)} / ${String(f).padStart(3)} / ${String(n).padStart(3)}`);
}
const provTally: Record<string, number> = {};
for (const p of parsed) for (const v of Object.values(p.provenance)) provTally[v] = (provTally[v] ?? 0) + 1;
console.log(`\nprovenance tags ${Object.entries(provTally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`);

const syn = parsed.filter((p) => byId.get(p.id)?.rec?.__meta?.synthetic === true).length;
console.log(`\ndemo flags  synthetic ${syn} · real/approximate ${parsed.length - syn}`);
console.log(`hours       absent ${parsed.filter((p) => p.hours.status === "absent").length} · unparsable ${parsed.filter((p) => p.hours.status === "unparsable").length} · partial ${parsed.filter((p) => p.hours.status === "partial").length}`);
console.log(`weather     any ${parsed.filter((p) => p.weatherSensitive === "any").length} · rain ${parsed.filter((p) => p.weatherSensitive === "rain").length} · heat ${parsed.filter((p) => p.weatherSensitive === "heat").length} · none ${parsed.filter((p) => p.weatherSensitive === "none").length}`);
console.log(`booking     walk-in ${parsed.filter((p) => p.booking.walkIn).length} · booking required ${parsed.filter((p) => p.booking.required).length}`);
console.log(`\nreviews     ${revLines.length} across ${revByExp.size} experiences · ${coldStart} experiences intentionally ratingless (cold start)`);
console.log(`events      ${evtLines.length}`);
console.log(`scenarios   ${scnLines.length}`);

if (argv.has("--index")) {
  const rows = [...parsed]
    .sort((a, b) => (a.neighbourhood ?? "").localeCompare(b.neighbourhood ?? "") || a.id.localeCompare(b.id))
    .map((p) => {
      const m = byId.get(p.id)!.rec!.__meta as Record<string, unknown>;
      return `| \`${p.id}\` | ${p.name} | ${p.neighbourhood} | ${p.category} | ${p.durationMin} | ${p.pricePerPerson ? `₹${p.pricePerPerson.minor / 100}` : "free"} | ${p.indoorOutdoor} | ${m.synthetic ? "synthetic" : "real / approx"} |`;
    });
  const out = [
    "# EXPERIENCE INDEX",
    "",
    "> **Generated. Do not edit by hand.** Regenerate with",
    "> `npx tsx content/tools/validate-content.ts --index`.",
    "",
    "Read `content/experiences/README.md` for the provenance policy and the list",
    "of things in this file that are invented. Short version: `synthetic` means",
    "the operator name is invented for the demo; `real / approx` means the place",
    "exists and the name is real, but every operational number on it is an",
    "estimate, not a survey.",
    "",
    `**${parsed.length} records.**`,
    "",
    "| id | name | locality | category | min | price | indoor | origin |",
    "|---|---|---|---|--:|--:|---|---|",
    ...rows,
    "",
  ].join("\n");
  const target = join(ROOT, "content/experiences/INDEX.md");
  writeFileSync(target, out, "utf8");
  console.log(`\nwrote ${target.slice(ROOT.length + 1)}`);
}

console.log();
if (problems.length === 0) {
  console.log(`OK — 0 problems. ${fixes.length ? `wrote ${fixes.length} corrected rating blocks` : "no rewrites needed"}\n`);
  process.exit(0);
}
console.log(`${problems.length} problem(s):`);
for (const p of problems) console.log(`  · ${p}`);
console.log();
process.exit(1);
