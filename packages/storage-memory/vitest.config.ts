import { defineConfig } from "vitest/config";

/**
 * Local vitest config for `@dokhna-tach/zatca-storage-memory`.
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
  },
});
