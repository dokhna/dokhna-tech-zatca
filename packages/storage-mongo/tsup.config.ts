import { defineConfig } from "tsup";

/**
 * Build config for `@dokhna-tech/zatca-storage-mongo`.
 * Uses a non-composite `tsconfig.build.json` for the DTS worker.
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
  // `mongoose` is a peer dep; never inline into the bundle.
  external: ["mongoose"],
});
