/**
 * IDs. Every catalogue row gets a stable, human-readable, deterministic id.
 *
 * Why slug-based rather than a database autoincrement or a random UUID:
 *   - a seed file is diffable and reviewable in git (this is a 250-row file
 *     that Abhijit and Vishwesh will both edit)
 *   - a stable id means an `inferred` enrichment cached last week still joins
 *     to the row after a re-seed
 *   - nothing downstream ever needs to know that the id is a slug
 *
 * The OSM fallback (`osm:way/12345`) matters: harvested rows and curated rows
 * live in the same table, and the prefix is how provenance is read at a glance.
 */

const SLUG_ALLOWED = /[^a-z0-9]+/g;

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(SLUG_ALLOWED, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** `mumbai/bandra-west/shore-dive-2` */
export function experienceId(city: string, neighbourhood: string, name: string, ordinal?: number): string {
  const base = [city, neighbourhood, name]
    .map((part) => slugify(part))
    .filter((part) => part.length > 0)
    .join("/");
  return ordinal === undefined ? base : `${base}-${ordinal}`;
}

/** OSM rows are namespaced so they can never collide with a curated slug. */
export function osmId(kind: "node" | "way" | "relation", osmIdValue: number | string): string {
  return `osm:${kind}/${osmIdValue}`;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_V4.test(value);
}

/**
 * Deterministic 32-bit hash. Used for cache keys and stable sharding, NOT for
 * security. FNV-1a: simple, fast, good enough spread for our sizes.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Short, stable, human-typeable cache suffix. */
export function shortHash(input: string): string {
  return fnv1a(input).toString(36).padStart(7, "0");
}

// ---------------------------------------------------------------------------
// Additive: the packer's search and the eval harness need reproducible RNG.
// Appended rather than replacing, so the slug-based id design above is intact.
// ---------------------------------------------------------------------------

import { randomUUID, createHash } from "node:crypto";

/** RFC4122 v4, for rows that are not catalogue experiences. */
export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Deterministic id from content. Same input, same id, always. Used for
 * idempotency keys on booking transitions, so a retried request or a
 * double-click cannot decrement capacity twice.
 */
export function stableId(...parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

/**
 * mulberry32. Small, fast, and fully reproducible — which is the point. The
 * packer's LAHC acceptance and the seed script both need a run with a fixed
 * seed to produce the same output, or an eval table means nothing.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable seed from any set of values. */
export function seedFrom(...parts: (string | number)[]): number {
  return fnv1a(parts.join("|"));
}

// Alliterative slug: the same search always yields the same shareable URL, with
// no database and cacheable as a filename. Borrows the idea from trip-planner.
const ADJECTIVES = [
  "Brave", "Bright", "Calm", "Clever", "Cosmic", "Curious", "Dapper", "Eager",
  "Fancy", "Fluffy", "Funky", "Gentle", "Giddy", "Golden", "Happy", "Jolly",
  "Keen", "Lively", "Lucky", "Merry", "Nifty", "Noble", "Plucky", "Proud",
  "Quiet", "Quick", "Sunny", "Swift", "Tidy", "Witty", "Zesty", "Bold",
];
const NOUNS = [
  "Antelope", "Badger", "Banyan", "Cedar", "Cobra", "Comet", "Dolphin", "Falcon",
  "Fox", "Gecko", "Heron", "Jaguar", "Kite", "Lark", "Lotus", "Mango", "Marlin",
  "Mongoose", "Otter", "Peacock", "Pelican", "Raven", "Sparrow", "Starfish",
  "Tortoise", "Vulture", "Whale", "Wombat", "Yak", "Zebra", "Kingfisher", "Panther",
];

export function slugFor(seed: number): string {
  const rand = seededRandom(seed);
  const adj = ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(rand() * NOUNS.length)];
  return `${adj}${noun}`;
}
