import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBreakers } from "./client";
import { chatCompletion, startFakeOpenRouter, type FakeOpenRouter } from "./fake-openrouter";
import { LABELS, context, plan } from "./fixtures";
import { unsupportedFigures } from "./guardrails";
import { buildFactSheet, deterministicNarration, narrate, narrateDetailed } from "./narrate";

const ENV_KEYS = [
  "LLM_OFF",
  "ANANTA_LLM_OFF",
  "LLM",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "ANANTA_LLM_RETRIES",
  "ANANTA_LLM_TIMEOUT_MS",
  "ANANTA_NARRATOR_MODEL",
  "ANANTA_NARRATOR_FALLBACK",
  "ANANTA_LOG",
];

let saved: Record<string, string | undefined> = {};
let fake: FakeOpenRouter | undefined;

async function useModel(content: string): Promise<void> {
  fake = await startFakeOpenRouter([chatCompletion(content)]);
  process.env.OPENROUTER_API_KEY = "sk-or-v1-testtesttesttest";
  process.env.OPENROUTER_BASE_URL = fake.baseUrl;
  process.env.ANANTA_NARRATOR_MODEL = "fake/narrator";
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

describe("deterministic narration", () => {
  const text = deterministicNarration(plan(), context(), LABELS);

  it("states the time and how much of the window it uses", () => {
    expect(text).toMatch(/2 h 10 min/);
    expect(text).toMatch(/54%/);
  });

  it("states the cost against the traveller's ceiling, in rupees", () => {
    expect(text).toMatch(/₹800/);
    expect(text).toMatch(/₹2,000/);
  });

  it("explains the travel between stops", () => {
    expect(text).toMatch(/1 leg/);
    expect(text).toMatch(/9 min by walk/);
  });

  it("quotes the engine's own why-lines instead of inventing reasons", () => {
    expect(text).toContain("Bandra Fort");
    expect(text).toContain("short hop from where you are");
  });

  it("names the tradeoff and the relaxation that was applied", () => {
    expect(text).toMatch(/Dropped the minimum stay/);
    expect(text).toMatch(/1 candidate did not make it/);
  });

  it("ends with an actionable caveat", () => {
    expect(text).toMatch(/heaviest strain is walking/);
    expect(text).toMatch(/swap the second stop/);
  });

  it("says nothing about a ceiling when there is none", () => {
    const text2 = deterministicNarration(plan(), context({ budget: null }), LABELS);
    expect(text2).toMatch(/no ceiling set/);
    expect(text2).not.toMatch(/ceiling,/);
  });

  it("handles an empty plan without pretending there is one", () => {
    const empty = deterministicNarration(plan({ stops: [], legs: [], totalMin: 0, utilisation: 0 }), context(), LABELS);
    expect(empty).toMatch(/Nothing fits/);
  });

  it("never names a stop it was not given a label for", () => {
    const unlabelled = deterministicNarration(plan(), context());
    expect(unlabelled).toContain("stop 1");
    expect(unlabelled).not.toContain("Bandra Fort");
  });

  it("passes its own figure check, which is the invariant the model is held to", () => {
    const sheet = buildFactSheet(plan(), context(), LABELS);
    expect(unsupportedFigures(deterministicNarration(plan(), context(), LABELS), sheet.figures)).toEqual([]);
  });
});

describe("narration degradation", () => {
  it("returns the deterministic narration with no key at all", async () => {
    const result = await narrateDetailed(plan(), context(), { labels: LABELS });
    expect(result.degraded).toBe(true);
    expect(result.text).toBe(deterministicNarration(plan(), context(), LABELS));
  });

  it("returns the deterministic narration under LLM_OFF", async () => {
    process.env.LLM_OFF = "1";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-testtesttesttest";
    const out = await narrate(plan(), context(), { labels: LABELS });
    expect(out).toMatch(/2 h 10 min/);
  });

  it("uses the model's prose when every figure in it is grounded", async () => {
    const model = "Two stops, 2 h 10 min in total, using 54% of the 4 h you have. Bandra Fort first because it is a short hop. ₹800 of the ₹2,000 ceiling is unspent.";
    await useModel(model);
    const result = await narrateDetailed(plan(), context(), { labels: LABELS });
    expect(result.degraded).toBe(false);
    expect(result.text).toBe(model);
  });

  it("throws away prose that invents a number", async () => {
    await useModel("Two stops, and the walk is only 25 minutes because the park is close.");
    const result = await narrateDetailed(plan(), context(), { labels: LABELS });
    expect(result.degraded).toBe(true);
    expect(result.rejected).toMatch(/25 minutes/);
    expect(result.text).toBe(deterministicNarration(plan(), context(), LABELS));
  });

  it("throws away prose that invents a price", async () => {
    await useModel("Entry is around ₹750 per person, so keep some cash.");
    const result = await narrateDetailed(plan(), context(), { labels: LABELS });
    expect(result.degraded).toBe(true);
    expect(result.text).toBe(deterministicNarration(plan(), context(), LABELS));
  });

  it("never receives a plan the model could argue with, only a fact sheet", async () => {
    await useModel("Fine.");
    await narrateDetailed(plan(), context(), { labels: LABELS });
    const sent = JSON.stringify(fake?.requests ?? []);
    expect(sent).toContain("data-only");
    expect(sent).toContain("Bandra Fort");
    expect(sent).not.toContain("book");
  });
});
