import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Vitest config.
 *
 * Exists mainly for the `@/*` alias. `tsconfig.json` maps it for `tsc`, but
 * Vitest does not read `paths` on its own — without this, every test that
 * imports from the frozen contract fails to resolve and the suite is
 * unrunnable, which is the worst possible reason for a test suite to not run.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(root, "src"),
    },
  },
  // Persist Vite's transform cache to disk between runs. Without this, every
  // invocation re-transforms the whole module graph from scratch — 42-102s of
  // the suite's wall clock — and because that work is spread across parallel
  // workers, a cold first run intermittently pushed
  // `tests/engine-seam.test.ts` past Vitest's default 5s per-test timeout. The
  // symptom was three unrelated-looking timeouts that passed in isolation and on
  // most runs, which is the worst shape of flake: a gate that cries wolf.
  cacheDir: resolve(root, "node_modules/.vite"),
  test: {
    // Node environment, not jsdom: every test in this suite is about module
    // resolution and export shape, and none of them render.
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    // A cold first run still has to transform the engine graph before the
    // dynamic `import("@/engine")` in the seam test resolves, and on a busy
    // machine that exceeds 5s even with the cache above. A gate that is
    // intermittently red gets ignored, so the ceiling is raised rather than
    // left to chance. 60s is still far below "hung".
    testTimeout: 60_000,
  },
});
