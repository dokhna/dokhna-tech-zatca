import { defineConfig } from "tsup";

/**
 * Build config for `@dokhna-tach/zatca-storage-memory`.
 * Uses a non-composite `tsconfig.build.json` for the DTS worker;
 * the main `tsconfig.json` is composite (for project references).
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: {
    resolve: true,
    entry: "src/index.ts",
  },
  clean: true,
  sourcemap: true,
  target: "es2023",
  outDir: "dist",
  tsconfig: "./tsconfig.build.json",
});
