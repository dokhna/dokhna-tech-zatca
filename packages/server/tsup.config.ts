import { defineConfig } from "tsup";

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
  external: ["@dokhna-tech/zatca"],
});
