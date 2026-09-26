import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Experience } from "../contracts";
import { resetBreakers } from "./client";
import { startFakeOpenRouter, valid, type FakeOpenRouter } from "./fake-openrouter";
import { BLOB, experience } from "./fixtures";
import { applyInference, candidateBlob, enrichMany, enrichOne, validateInference, type EnrichCandidate } from "./enrich";

const ENV_KEYS = [
  "LLM_OFF",
  "ANANTA_LLM_OFF",
  "LLM",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "ANANTA_LLM_RETRIES",
  "ANANTA_LLM_TIMEOUT_MS",
  "ANANTA_ENRICHER_MODEL",
  "ANANTA_ENRICHER_FALLBACK",
  "ANANTA_LOG",
];

let saved: Record<string, string | undefined> = {};
let fake: FakeOpenRouter | undefined;

const CANDIDATE: EnrichCandidate = {
  experienceId: "exp-longtail",
  name: "Kannada Kitchen at Fort",
  category: "restaurant",
  blurb: "A Kannada dosa place on a quiet lane in Fort, open from noon.",
  neighbourhood: "Fort",
};

/** A model answer that is quotable, in range, and confident. */
const GOOD = {
  duration_min: 60,
  price_minor: 50_000,
  indoor: "indoor",
  category: "restaurant",
  kid_friendly: true,
  step_free: null,
  tags: ["dosa", "kannada"],
  evidence: [
    { field: "duration_min", quote: "open from noon" },
    { field: "price_minor", quote: "a Kannada dosa place" },
    { field: "indoor", quote: "quiet lane" },
    { field: "category", quote: "Kannada Kitchen" },
    { field: "kid_friendly", quote: "quiet lane" },
    { field: "tags", quote: "dosa" },
  ],
  confidence: 0.9,
  abstain_reason: null,
};

async function useModel(payload: unknown): Promise<void> {
  fake = await startFakeOpenRouter([valid(payload)]);
  process.env.OPENROUTER_API_KEY = "sk-or-v1-testtesttesttest";
  process.env.OPENROUTER_BASE_URL = fake.baseUrl;
  process.env.ANANTA_ENRICHER_MODEL = "fake/enricher";
  process.env.ANANTA_LLM_RETRIES = "0";
  process.env.ANANTA_LLM_TIMEOUT_MS = "3000";
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetBreakers();
});

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetBreakers();
});

describe("inference validation", () => {
  it("accepts a value only when its quote is verbatim in the source", () => {
    const v = validateInference(GOOD, BLOB);
    expect("error" in v).toBe(false);
    if ("error" in v) return;
    expect(v.accepted).toContain("duration_min");
    expect(v.rejections).toEqual([]);
  });

  it("rejects a quote the model made up", () => {
    const v = validateInference(
      { ...GOOD, evidence: [{ field: "duration_min", quote: "a three hour tasting" }] },
      BLOB,
    );
    expect("error" in v).toBe(false);
    if ("error" in v) return;
    expect(v.accepted).not.toContain("duration_min");
    expect(v.rejections.some((r) => "code" in r && r.code === "EVIDENCE_NOT_VERBATIM")).toBe(true);
  });

  it("rejects a value with no evidence at all", () => {
    const v = validateInference({ ...GOOD, evidence: [] }, BLOB);
    if ("error" in v) throw new Error("unexpected");
    expect(v.accepted).toEqual([]);
    expect(v.rejections.filter((r) => "code" in r && r.code === "EVIDENCE_MISSING").length).toBeGreaterThan(0);
  });

  it("applies a much higher bar to an accessibility claim than to a duration", () => {
    const v = validateInference({ ...GOOD, confidence: 0.7, step_free: true, evidence: [...GOOD.evidence, { field: "step_free", quote: "quiet lane" }] }, BLOB);
    if ("error" in v) throw new Error("unexpected");
    expect(v.accepted).toContain("duration_min");
    expect(v.accepted).not.toContain("step_free");
    expect(v.rejections.some((r) => "code" in r && r.code === "LOW_CONFIDENCE" && r.field === "step_free")).toBe(true);
  });

  it("lets an OSM tag overrule the model", () => {
    const v = validateInference(
      { ...GOOD, step_free: false, evidence: [...GOOD.evidence, { field: "step_free", quote: "quiet lane" }] },
      BLOB,
      { wheelchair: "yes" },
    );
    if ("error" in v) throw new Error("unexpected");
    expect(v.accepted).not.toContain("step_free");
    expect(v.rejections.some((r) => "code" in r && r.code === "CONTRADICTS_OSM_TAG")).toBe(true);
  });

  it("drops a category that is not in the contract's enum", () => {
    const v = validateInference({ ...GOOD, category: "gastro_temple" }, BLOB);
    if ("error" in v) throw new Error("unexpected");
    expect(v.rejections.some((r) => "code" in r && r.code === "UNKNOWN_CATEGORY")).toBe(true);
  });

  it("rejects output that does not match the schema at all", () => {
    const v = validateInference({ duration_min: "sixty" }, BLOB);
    expect("error" in v).toBe(true);
  });

  it("treats nulls and 'unknown' as the correct answer, not as a defect", () => {
    const v = validateInference(
      { ...GOOD, duration_min: null, price_minor: null, indoor: "unknown", kid_friendly: null, tags: [], evidence: [], confidence: 0.2 },
      BLOB,
    );
    if ("error" in v) throw new Error("unexpected");
    expect(v.accepted).toEqual([]);
  });
});

describe("applying inference to a catalogue row", () => {
  it("writes provenance and confidence for everything it fills", async () => {
    await useModel(GOOD);
    const result = await enrichOne(CANDIDATE);
    const applied = applyInference(experience(), result);
    expect(applied.experience.pricePerPerson).toEqual({ minor: 50_000, currency: "INR" });
    expect(applied.experience.provenance.pricePerPerson).toBe("inferred");
    expect(applied.confidence.pricePerPerson).toBeCloseTo(0.9);
    expect(applied.source).toMatch(/^llm:/);
  });

  it("refuses to overwrite a curated or provider-supplied fact", async () => {
    await useModel(GOOD);
    const curated = Experience.parse({ ...experience(), pricePerPerson: { minor: 30_000, currency: "INR" }, provenance: { pricePerPerson: "curated" } });
    const result = await enrichOne(CANDIDATE);
    const applied = applyInference(curated, result);
    expect(applied.experience.pricePerPerson).toEqual({ minor: 30_000, currency: "INR" });
    expect(applied.skipped).toContain("pricePerPerson");
  });

  it("is idempotent: a second run with the same answer changes nothing further", async () => {
    await useModel(GOOD);
    const first = applyInference(experience(), await enrichOne(CANDIDATE));
    const second = applyInference(first.experience, await enrichOne(CANDIDATE));
    expect(second.applied).toEqual([]);
    expect(second.experience).toEqual(first.experience);
  });

  it("appends tags without dropping the curated keywords", async () => {
    await useModel(GOOD);
    const base = experience({ keywords: ["dosa", "fort"] });
    const applied = applyInference(base, await enrichOne(CANDIDATE));
    expect(applied.experience.keywords).toEqual(expect.arrayContaining(["fort", "dosa", "kannada"]));
    expect(applied.experience.keywords.filter((k) => k === "dosa")).toHaveLength(1);
  });
});

describe("enrichment with no model", () => {
  it("abstains on every record and writes nothing", async () => {
    process.env.LLM_OFF = "1";
    const results = await enrichMany([CANDIDATE, { ...CANDIDATE, experienceId: "exp-2" }]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.degraded).toBe(true);
      expect(r.applied).toEqual([]);
      expect(r.inference).toBeNull();
      expect(r.rejections[0]).toMatchObject({ code: "ABSTAINED" });
      expect(applyInference(experience(), r).experience).toEqual(experience());
    }
  });

  it("abstains rather than guessing when the response is malformed", async () => {
    fake = await startFakeOpenRouter([{ status: 200, body: "not json at all" }]);
    process.env.OPENROUTER_API_KEY = "sk-or-v1-testtesttesttest";
    process.env.OPENROUTER_BASE_URL = fake.baseUrl;
    process.env.ANANTA_LLM_RETRIES = "0";
    const result = await enrichOne(CANDIDATE);
    expect(result.applied).toEqual([]);
    expect(result.degraded).toBe(true);
  });
});

describe("the blob is the only evidence", () => {
  it("is built from the record's own text and nothing else", () => {
    expect(candidateBlob(CANDIDATE)).toBe(BLOB);
  });
});
