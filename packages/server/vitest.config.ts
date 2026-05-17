import { defineConfig } from "vitest/config";

/**
 * Local vitest config for `@dokhna-tech/zatca-server`.
 * Pins the Node environment so a parent directory's vitest config
 * cannot bleed in.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "threads",
    root: ".",
    passWithNoTests: true,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts"],
    },
  },
});
