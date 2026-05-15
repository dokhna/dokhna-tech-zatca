---
"@dokhna-tech/zatca": minor
"@dokhna-tech/zatca-storage-memory": minor
"@dokhna-tech/zatca-storage-mongo": minor
"@dokhna-tech/zatca-storage-postgres": minor
---

Toolchain refresh. No runtime behaviour change; all 332 tests pass.

Consumer-visible manifest changes:

- `engines.node` raised from `>=20.0.0` to `>=20.19.0` on all four published packages. Node 20.19 (April 2025) is the floor required by mongoose 9 and mongodb-memory-server 11; the previous range had been silently understating the real minimum. Node 20.19 is still inside the Node 20 LTS line.
- `@dokhna-tech/zatca-storage-mongo` `peerDependencies.mongoose` widened from `>=8.0.0` to `>=9.0.0`. The package was already developed and tested against mongoose 9.x; the peer range now matches reality. Consumers still on mongoose 8 should pin `@dokhna-tech/zatca-storage-mongo@<2.x` until they can upgrade mongoose.
- `@dokhna-tech/zatca` `peerDependencies.vitest` widened from `"^2.0.0 || ^3.0.0"` to `"^2.0.0 || ^3.0.0 || ^4.0.0"` (the `test-helpers/storage-adapter-conformance` suite). No consumer action required — vitest 2/3 still work.

Internal toolchain bumps (no consumer impact):

- tsup 8.3 → 8.5.1, tsx 4.21 → 4.22, @changesets/cli 2.27 → 2.31, typedoc 0.28.0 → 0.28.19, pg-mem 3.0.5 → 3.0.14 (dev).
- vitest 2 → 4 (root `vitest.workspace.json` replaced with a root `vitest.config.ts` using `test.projects`).
- @biomejs/biome 1.9 → 2.4 (config migrated via `biome migrate --write`).
- typescript 5.6 → 6.0.3, with `ignoreDeprecations: "6.0"` set in `tsconfig.base.json` to absorb tsup's still-injected `baseUrl` until tsup catches up.
