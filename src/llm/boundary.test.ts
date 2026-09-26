/**
 * The architecture, enforced.
 *
 * These are the cheapest tests in the repository and they are the ones that stop
 * the whole thesis from quietly eroding: a review comment saying "the LLM must
 * not be in the decision path" protects nothing, a failing test does. Borrowed
 * from FloatTrip, which fails its own build if `app/chat` imports the API layer.
 *
 * Two rules:
 *   1. `src/engine/**` never imports an LLM SDK. That is Abhijit's directory, so
 *      this only asserts; it does not edit.
 *   2. `src/llm/**` never imports the engine, the database, or a component. The
 *      understanding layer may read a `DiscoveryContext` and hand back a patch.
 *      It may not pack, score, validate or persist a plan.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONTRACT_VERSION, DialogueDecision } from "../contracts";
import { InferenceSchema } from "./enrich";
import { NLU_PATCH_SCHEMA } from "./nlu";

const ROOT = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

const LLM_SDK = [/from ["']ai["']/, /@ai-sdk\//, /from ["']openai["']/, /from ["']@google\/generative-ai["']/];
const ENGINE_OR_APP = [/from ["'][^"']*\/engine\//, /from ["']@\/engine/, /from ["'][^"']*\/db\//, /from ["'][^"']*\/components\//, /from ["'][^"']*\/app\//];

describe("import boundaries", () => {
  it("the engine never imports an LLM SDK", () => {
    const bad = walk(join(ROOT, "src", "engine"))
      .filter((f) => LLM_SDK.some((re) => re.test(readFileSync(f, "utf8"))))
      .map((f) => f.slice(ROOT.length + 1));
    expect(bad).toEqual([]);
  });

  it("the LLM layer never imports the engine, the database or a component", () => {
    const bad = walk(join(ROOT, "src", "llm"))
      .filter((f) => ENGINE_OR_APP.some((re) => re.test(readFileSync(f, "utf8"))))
      .map((f) => f.slice(ROOT.length + 1));
    expect(bad).toEqual([]);
  });

  it("the LLM layer reads the frozen contract and nothing else from src", () => {
    const imports = walk(join(ROOT, "src", "llm")).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/from ["'](\.\.?\/[^"']+)["']/g)].map((m) => m[1] ?? ""),
    );
    const escapes = imports.filter((spec) => {
      const resolved = resolveIn("src/llm", spec);
      return !resolved.startsWith("src/llm") && resolved !== "src/contracts";
    });
    expect([...new Set(escapes)]).toEqual([]);
  });
});

function resolveIn(fromDir: string, spec: string): string {
  const parts = join(fromDir).split(/[\\/]/).filter(Boolean);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

describe("the contract itself", () => {
  it("is the version this layer was written against", () => {
    expect(CONTRACT_VERSION).toBe("1.0.0");
  });

  it("exposes exactly the four keys a dialogue decision may carry", () => {
    expect(Object.keys(DialogueDecision.shape).sort()).toEqual(["confidence", "contextPatch", "reply", "suggestions"]);
  });

  it("exposes exactly the eight keys a context patch may carry", () => {
    // `contextPatch` is wrapped in a default, so read the shape through the JSON
    // schema rather than reaching into zod internals that may move.
    const patch = z.toJSONSchema(DialogueDecision) as unknown as { properties: { contextPatch: { properties: object } } };
    expect(Object.keys(patch.properties.contextPatch.properties).sort()).toEqual([
      "accessNeeds",
      "availableMin",
      "avoid",
      "budgetMinor",
      "indoorOnly",
      "interests",
      "mood",
      "partySize",
    ]);
  });

  it("keeps the NLU's local mirror of that patch schema identical to the contract", () => {
    // The contract declares the patch inline, so the model-facing schema has to
    // restate it. This assertion is what stops that restatement from rotting: a
    // widened contract fails here rather than silently widening what a model can
    // put into a traveller's context.
    const contract = z.toJSONSchema(DialogueDecision) as unknown as {
      properties: { contextPatch: { properties: object } };
    };
    const mirror = z.toJSONSchema(NLU_PATCH_SCHEMA) as unknown as { properties: object };
    expect(Object.keys(mirror.properties).sort()).toEqual(
      Object.keys(contract.properties.contextPatch.properties).sort(),
    );
  });
});

/**
 * `@ai-sdk/provider-utils` serialises our zod schema with `io: "input"`, so an
 * optional or defaulted property is left out of `required` — and the provider is
 * asked for that schema with `strict: true`. OpenAI's strict mode rejects any
 * object that does not list every property in `required`, so a single
 * `.optional()` here costs a 400 on EVERY structured call, which `runChain` does
 * not retry. The whole LLM path dies quietly and the deterministic floor covers
 * for it, so nothing looks broken.
 *
 * This renders the schemas exactly the way the SDK does and fails on the first
 * property that is not required.
 */
type JsonNode = {
  type?: string;
  properties?: Record<string, JsonNode>;
  required?: string[];
  items?: JsonNode;
  anyOf?: JsonNode[];
  additionalProperties?: JsonNode | boolean;
};

function unrequiredProperties(node: JsonNode, path = "$"): string[] {
  if (node.properties) {
    const required = new Set(node.required ?? []);
    const missing = Object.keys(node.properties)
      .filter((key) => !required.has(key))
      .map((key) => `${path}.${key}`);
    for (const [key, child] of Object.entries(node.properties)) {
      missing.push(...unrequiredProperties(child, `${path}.${key}`));
    }
    return missing;
  }
  if (node.items) return unrequiredProperties(node.items, `${path}[]`);
  if (node.anyOf) return node.anyOf.flatMap((child, i) => unrequiredProperties(child, `${path}|${i}`));
  return [];
}

const strictUnsafe = (schema: z.ZodType): string[] =>
  unrequiredProperties(z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as JsonNode);

describe("the model-facing schemas", () => {
  it("are strict-compatible: every property is required", () => {
    expect({ nlu: strictUnsafe(NLU_PATCH_SCHEMA) }).toEqual({ nlu: [] });
    expect({ enrich: strictUnsafe(InferenceSchema) }).toEqual({ enrich: [] });
  });
});
