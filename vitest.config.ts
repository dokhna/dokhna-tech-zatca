import { defineConfig } from "vitest/config";

/**
 * Root Vitest config. Replaces `vitest.workspace.json` (removed in
 * Vitest 4 — the workspace option was renamed to `test.projects` in
 * Vitest 3.2 and the legacy workspace file is no longer supported).
 *
 * Each listed glob is resolved against its own per-package
 * `vitest.config.ts`, which pins Node environment, include patterns,
 * pool, and per-suite timeouts.
 */
export default defineConfig({
  test: {
    projects: ["./packages/*", "./examples/*"],
  },
});
