import { defineConfig } from "tsup";

/**
 * Build config for `@dokhna-tach/zatca` (core).
 *
 * Emits dual ESM + CJS bundles from a single entrypoint, generates
 * `.d.ts` for the public API, and produces source maps for clean
 * debugging in consumer projects.
 *
 * Test files are excluded from the entry tree (vitest runs against
 * source TS directly via `vitest.config.ts`).
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: {
    // Use a separate, non-composite tsconfig for declaration output so
    // tsup's worker-based dts builder doesn't trip over the project-
    // reference machinery in the main `tsconfig.json`.
    resolve: true,
    entry: "src/index.ts",
  },
  clean: true,
  sourcemap: true,
  target: "es2023",
  outDir: "dist",
  tsconfig: "./tsconfig.build.json",
});
