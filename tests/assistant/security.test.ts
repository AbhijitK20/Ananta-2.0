/**
 * Security tests for the assistant.
 *
 * Two kinds, and the split matters:
 *
 *   - **Behavioural** — what the code does with hostile input. Cross-user access,
 *     injection, XSS, oversized bodies, rate limits. Most of these live in
 *     `integration.test.ts` next to the code they exercise.
 *   - **Structural** — what the module graph *allows*. `secretIsolation` below is
 *     the one that cannot be tested by calling anything, because the failure mode
 *     is a single stray `import` in a client component and the symptom is a
 *     leaked key in a shipped bundle.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every *value* import specifier in a source file.
 *
 * `import type` is deliberately skipped. TypeScript erases it, so it cannot put a
 * `node:fs` module in a browser bundle — counting it produced three false
 * positives, all of them `import type { PlaceOption }` lines that the production
 * compiler had already removed.
 */
function importsOf(file: string): { spec: string; line: number }[] {
  const text = readFileSync(file, "utf8");
  const out: { spec: string; line: number }[] = [];
  text.split("\n").forEach((raw, index) => {
    if (/^\s*import\s+type\s/.test(raw)) return;
    if (/^\s*export\s+type\s/.test(raw)) return;
    const line = raw.replace(/^\s*(?:import|export)\s+[^;]*?from\s+/, "");
    const match = /["']([^"']+)["']/.exec(line);
    if (match?.[1]) out.push({ spec: match[1], line: index + 1 });
    // `import "./x"` has no `from`.
    const bare = /^\s*import\s+["']([^"']+)["']/.exec(raw);
    if (bare?.[1]) out.push({ spec: bare[1], line: index + 1 });
  });
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  if (spec.startsWith("@/")) return join(SRC, spec.slice(2));
  if (spec.startsWith(".")) return resolve(join(from, ".."), spec);
  return null; // a package, not our code
}

/** Every module reachable from `entry`, following relative and `@/` imports. */
function reachableFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    const edges: string[] = [];
    seen.set(file, edges);
    for (const { spec } of importsOf(file)) {
      const target = resolveSpec(file, spec);
      if (!target) continue;
      let candidates = [target];
      try {
        if (statSync(target).isDirectory()) {
          candidates = [join(target, "index.ts"), join(target, "index.tsx")];
        } else if (!/\.tsx?$/.test(target)) {
          candidates = [`${target}.ts`, `${target}.tsx`];
        }
      } catch {
        // No extension and no such file; try the common suffixes and move on.
        candidates = [`${target}.ts`, `${target}.tsx`, join(target, "index.ts")];
      }
      for (const candidate of candidates) {
        try {
          if (statSync(candidate).isFile()) {
            edges.push(candidate);
            queue.push(candidate);
            break;
          }
        } catch {
          continue;
        }
      }
    }
  }
  return seen;
}

describe("secret isolation", () => {
  const sources = walk(SRC);

  it("reads NUGEN_API_KEY in exactly one assistant module", () => {
    // One place that reads the key means one place to audit, one place to get
    // wrong. A second reader in a component is how a key reaches a bundle.
    //
    // Scoped to the assistant because `src/llm/nugen.ts` legitimately reads the
    // same key for the Digital Twin's hazard calls — that is a separate feature
    // with a separate provider, and the two never share a module.
    const readers = sources
      .filter((file) => file.includes(`${join("features", "assistant")}`))
      .filter((file) => /NUGEN_API_KEY/.test(readFileSync(file, "utf8")));
    expect(readers.map((file) => relative(ROOT, file).replace(/\\/g, "/"))).toEqual([
      "src/features/assistant/provider/config.ts",
    ]);
  });

  it("keeps the provider out of every client module's graph", () => {
    // The real invariant, and the one that cannot be checked by calling a
    // function: no `"use client"` module may transitively reach
    // `provider/config.ts`, because that is where the key is read.
    const forbidden = join(SRC, "features", "assistant", "provider", "config.ts");
    const offenders: string[] = [];

    for (const file of sources.filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))) {
      const text = readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(text)) continue;
      const graph = reachableFrom(file);
      if (graph.has(forbidden)) {
        const path = [...graph.get(forbidden) ?? []].find((edge) => resolveSpec(file, edge) === forbidden);
        offenders.push(`${relative(ROOT, file).replace(/\\/g, "/")} -> ${path ?? "?"}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the database and node builtins out of client graphs", () => {
    // Same class of bug as above, and the build was already broken once by it:
    // a client component importing a barrel that re-exports a `node:fs` module.
    const offenders: string[] = [];
    for (const file of sources.filter((name) => name.endsWith(".tsx"))) {
      const text = readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(text)) continue;
      for (const reached of reachableFrom(file).keys()) {
        const body = readFileSync(reached, "utf8");
        if (/^\s*import\s+[^;]*\bfrom\s+["']node:/m.test(body)) {
          offenders.push(
            `${relative(ROOT, file).replace(/\\/g, "/")} -> ${relative(ROOT, reached).replace(/\\/g, "/")}`,
          );
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never hardcodes a key-shaped literal in source", () => {
    // A key committed to git is a key in every clone. The real value is supplied
    // through the environment, and this is the check that keeps it that way.
    const suspicious = sources.filter((file) => /\bnugen-[0-9a-f]{16,}\b/i.test(readFileSync(file, "utf8")));
    expect(suspicious.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe("markdown safety", () => {
  it("rejects a javascript: href but keeps the words", async () => {
    const { safeHref: safeHrefForTest } = await import("@/features/assistant/links");
    expect(safeHrefForTest("https://example.com")).toBe("https://example.com");
    expect(safeHrefForTest("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeHrefForTest("/plan")).toBe("/plan");
    expect(safeHrefForTest("//evil.example")).toBe("https://evil.example");
    for (const hostile of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(safeHrefForTest(hostile), hostile).toBeNull();
    }
  });
});
