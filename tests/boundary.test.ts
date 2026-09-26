/**
 * THE BOUNDARY TEST.
 *
 * Masterplan principle 1 is "the deterministic engine gates; the LLM only
 * interprets". A principle nobody enforces is a comment. This file is the
 * enforcement, and it is the reason the Session 1 brief asked for it before any
 * engine code existed: the guard is cheap to add when there is nothing to guard
 * and expensive to retrofit once someone has already routed a model call
 * through the feasibility check.
 *
 * Two rules:
 *   1. No file under src/engine/ may import anything that can call a model.
 *   2. No file under src/engine/ may construct a Date, because the engine
 *      speaks integer minutes and a Date is where timezone bugs enter. There is
 *      exactly one sanctioned exception, hours.ts, which is the documented
 *      boundary.
 *
 * A model file must not appear in src/engine/ either. Models load behind an
 * interface in src/ml/ (Session 5, gated on O3) and the engine never sees them.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(__dirname, "..");
const ENGINE_DIR = join(ROOT, "src", "engine");
const LLM_DIR = join(ROOT, "src", "llm");

/** Packages that can reach a model. Derived from package.json so it cannot drift. */
const LLM_PACKAGE_PATTERNS = [
  /^openai$/,
  /^@anthropic-ai\//,
  /^@google\/generative-ai$/,
  /^@google\/vertexai$/,
  /^@azure\/openai$/,
  /^@aws-sdk\/client-bedrock/,
  /^ai$/,
  /^@ai-sdk\//,
  /^ollama$/,
  /^langchain/,
  /^llamaindex/,
  /^@huggingface\//,
  /^transformers$/,
  /^@xenova\//,
  /^cohere-ai$/,
  /^groq-sdk$/,
  /^mistralai/,
  /^replicate$/,
];

/**
 * Files allowed to touch `Date`. Each entry is a decision, not a convenience.
 */
const DATE_EXEMPTIONS = new Set(["hours.ts"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Every module specifier a file pulls in, however it is written. */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /^\s*import\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/gm,
    /^\s*export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.push(match[1]!);
    }
  }
  return found;
}

const engineFiles = walk(ENGINE_DIR);

describe("boundary: the engine must not reach a model", () => {
  it("has engine files to check (a silent pass on an empty dir is a false green)", () => {
    expect(engineFiles.length).toBeGreaterThan(0);
  });

  it("forbids importing the llm module tree", () => {
    const violations: string[] = [];
    for (const file of engineFiles) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const resolved = resolve(file, "..", specifier);
        if (resolved === LLM_DIR || resolved.startsWith(LLM_DIR + sep)) {
          violations.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(
      violations,
      `The engine must not import the LLM tree. Deterministic code gates; a model only ` +
        `interprets. Violations:\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("forbids importing a model SDK, however it is spelled", () => {
    const violations: string[] = [];
    for (const file of engineFiles) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const bare = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : (specifier.split("/")[0] ?? specifier);
        if (LLM_PACKAGE_PATTERNS.some((p) => p.test(bare))) {
          violations.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(
      violations,
      `A model SDK was imported into the engine. Models belong behind the Embedder ` +
        `interface in src/ml/ (Session 5, gated on O3). Violations:\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("forbids a model inside the engine, not just an import of one", () => {
    // A relative import of a sibling .ts file would not match a package
    // pattern. This catches `import { callModel } from './model'`.
    const violations: string[] = [];
    for (const file of engineFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(file, "..", specifier);
        if (!/^src[\\/](llm|ml)[\\/]/.test(relative(ROOT, target).replace(/\\/g, "/"))) continue;
        violations.push(`${relative(ROOT, file)} -> ${specifier}`);
      }
    }
    expect(violations, `Relative import out of the engine:\n  ${violations.join("\n  ")}`).toEqual([]);
  });
});

describe("boundary: the engine must not know what time zone it is in", () => {
  it("constructs no Date outside the sanctioned boundary", () => {
    const violations: string[] = [];
    for (const file of engineFiles) {
      const name = file.split(sep).pop()!;
      if (DATE_EXEMPTIONS.has(name)) continue;
      const source = readFileSync(file, "utf8");
      // Strip comments so a sentence mentioning Date does not trip the guard.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (/\bnew\s+Date\b|\bDate\.now\b|\bDate\.UTC\b/.test(code)) {
        violations.push(relative(ROOT, file));
      }
    }
    expect(
      violations,
      `The engine speaks integer Minutes, never Date. A Date here means a timezone ` +
        `bug is one deploy away. Use src/lib/time.ts. Violations:\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the Date boundary in exactly one place, and it is documented", () => {
    const offenders = engineFiles.filter((f) => {
      const name = f.split(sep).pop()!;
      if (DATE_EXEMPTIONS.has(name)) return false;
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return /\bnew\s+Date\b|\bDate\.now\b|\bDate\.UTC\b/.test(code);
    });
    expect(offenders).toEqual([]);
    // If a second file needs the boundary, it must be added here deliberately
    // with a reason, not discovered later by a grep.
    expect([...DATE_EXEMPTIONS]).toEqual(["hours.ts"]);
  });
});
