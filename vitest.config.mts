import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // node:sqlite is a built-in. If the engine unit tests start needing a
    // native module, something has gone wrong with the storage decision in
    // DECISIONS D2 and this should fail loudly rather than need a rebuild.
    globals: false,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
