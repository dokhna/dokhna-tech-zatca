import { defineConfig } from "vitest/config";

/**
 * Local vitest config for `@dokhna-tech/zatca-storage-memory`.
 * Pins the Node environment so a parent directory's vitest config
 * (e.g. a Cloudflare Workers pool config) cannot bleed in.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "threads",
    root: ".",
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
