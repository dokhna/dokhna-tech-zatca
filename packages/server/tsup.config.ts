import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    resolve: true,
    entry: {
      index: "src/index.ts",
    },
  },
  clean: true,
  sourcemap: true,
  target: "es2023",
  outDir: "dist",
  tsconfig: "./tsconfig.build.json",
  external: [
    "@dokhna-tech/zatca",
    "@dokhna-tech/zatca-storage-mongo",
    "@dokhna-tech/zatca-storage-postgres",
    "mongoose",
    "pg",
  ],
});
