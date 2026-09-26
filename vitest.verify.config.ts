import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Verification-only. Not the repo config, and not a proposal for it.
 *
 * `vitest.config.ts` (Abhijit's path, per TASKS.md) sets its `include` glob to
 * the `tests` directory alone. Every test in this repository before that file
 * existed lives BESIDE the code it covers, under `src/features` and `src/llm`, so
 * that glob silently stops running them. A suite goes from hundreds of tests to one
 * without a single failure, which is the worst possible way for a suite to break.
 *
 * This mirrors the repo config and widens the glob to both, so the repair work can
 * actually be run. Delete it once `include` is fixed.
 */
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": resolve(root, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/.next/**"],
  },
});
