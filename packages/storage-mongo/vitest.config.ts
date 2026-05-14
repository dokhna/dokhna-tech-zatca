import { defineConfig } from "vitest/config";

/**
 * Local vitest config for `@dokhna-tech/zatca-storage-mongo`.
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
    // First-run cold-start has to launch a `mongod` child process and
    // wait for the WiredTiger init log. 60s gives plenty of headroom
    // for CI hosts under load; warm runs finish in ~300ms.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
