import { defineConfig } from "vitest/config";

/**
 * Local vitest config for `@dokhna-tech/zatca` (core).
 *
 * Pins the Node environment so a parent directory's
 * `vitest.config.mts` (e.g. one configured for
 * `@cloudflare/vitest-pool-workers`) cannot bleed into the unit test
 * run. Without this, `vitest` walks upward and may pick up a sibling
 * project's config.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "threads",
    root: ".",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/test-helpers/**",
        "src/fixtures/**",
        "src/**/_test-helpers.ts",
      ],
    },
  },
});
