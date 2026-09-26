/**
 * Harvest invariants, proven WITHOUT a network.
 *
 * The single rule that matters here is RULE 1: a response carrying an Overpass
 * `remark` must never be persisted. Overpass returns HTTP 200 with a plausible
 * `elements` array alongside that remark, so a naive client caches a truncated
 * city and — because the cache key is content-derived — never notices.
 *
 * These run offline on purpose. A rule that can only be tested against a live
 * mirror is a rule that gets skipped when the mirror is down, which is exactly
 * when you need it.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseOverpassResponse, normaliseBbox } from "../scripts/harvest-osm";

const CACHE_DIR = "data/cache/osm";

function withTempCache<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "tb-harvest-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("harvest: a remark is never persisted", () => {
  it("rejects a partial response that still looks successful", () => {
    // This is the exact shape Overpass returns when a query times out: HTTP 200,
    // some elements, and a remark explaining that the result is incomplete.
    const partial = {
      version: 0.6,
      generator: "Overpass API 0.7.56",
      remark: "runtime error: Query timed out in 'query' at line 3, after 180 ms.",
      elements: [
        { type: "node", id: 1, lat: 19.05, lon: 72.83, tags: { name: "A" } },
        { type: "node", id: 2, lat: 19.06, lon: 72.84, tags: { name: "B" } },
      ],
    };
    expect(() => parseOverpassResponse(partial)).toThrow(/remark/);
    expect(() => parseOverpassResponse(partial)).toThrow(/timed out/);
  });

  it("rejects the memory-exhaustion remark too", () => {
    const partial = {
      remark: "runtime error: Query ran out of memory in 'query'.",
      elements: [],
    };
    expect(() => parseOverpassResponse(partial)).toThrow(/out of memory/);
  });

  it("accepts a clean response", () => {
    const clean = {
      version: 0.6,
      osm3s: { timestamp_osm_base: "2026-01-05T00:00:00Z" },
      elements: [{ type: "node", id: 1, tags: { name: "Candy's" } }],
    };
    const parsed = parseOverpassResponse(clean);
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.osm3s?.timestamp_osm_base).toBe("2026-01-05T00:00:00Z");
  });

  it("treats an empty remark string as clean, not as a failure", () => {
    expect(parseOverpassResponse({ remark: "", elements: [] }).elements).toEqual([]);
  });

  it("rejects a response with no elements array", () => {
    expect(() => parseOverpassResponse({ version: 0.6 })).toThrow(/no elements/);
    expect(() => parseOverpassResponse({ elements: "nope" })).toThrow(/no elements/);
  });

  it("rejects a non-object body", () => {
    expect(() => parseOverpassResponse(null)).toThrow(/not a JSON object/);
    expect(() => parseOverpassResponse("rate limited")).toThrow(/not a JSON object/);
    expect(() => parseOverpassResponse(42)).toThrow(/not a JSON object/);
  });
});

describe("harvest: the cache key is float-noise proof", () => {
  it("collapses 6dp-equivalent bboxes to one key", () => {
    // Raw float bbox arithmetic differs in the 15th digit. Without rounding,
    // the cache never hits and the rate limiter eats the quota for nothing.
    const a = normaliseBbox([72.775, 18.875, 72.99, 19.265]);
    const b = normaliseBbox([72.77500000001, 18.87499999999, 72.990000000001, 19.26500000001]);
    expect(a).toBe(b);
    expect(a).toBe("72.775,18.875,72.99,19.265");
  });

  it("still distinguishes genuinely different areas", () => {
    expect(normaliseBbox([72.775, 18.875, 72.99, 19.265])).not.toBe(
      normaliseBbox([72.80, 18.90, 72.95, 19.20]),
    );
  });

  it("rejects a non-finite coordinate rather than writing a NaN key", () => {
    expect(() => normaliseBbox([Number.NaN, 18.875, 72.99, 19.265])).toThrow(/not finite/);
  });
});

describe("harvest: nothing poisoned reached the cache on disk", () => {
  it("finds no cached response carrying a remark", () => {
    // The real regression guard. If a future change writes the response before
    // checking for a remark, this fails against whatever is actually on disk.
    if (!existsSync(CACHE_DIR)) return;
    const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const body = JSON.parse(readFileSync(join(CACHE_DIR, file), "utf8"));
      expect(
        body.remark,
        `data/cache/osm/${file} was cached despite carrying a remark. A partial ` +
          `Overpass result must never be persisted: the key is content-derived, so ` +
          `the truncation would be permanent.`,
      ).toBeUndefined();
      expect(Array.isArray(body.elements)).toBe(true);
    }
  });

  it("keeps the temp-dir helper honest", () => {
    withTempCache((dir) => {
      expect(existsSync(dir)).toBe(true);
    });
  });
});
