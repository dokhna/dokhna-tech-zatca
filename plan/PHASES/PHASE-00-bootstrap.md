# Phase 0 — Bootstrap & Plan Directory

**Status:** completed
**Agent:** build-engineer (initial) + main context (completion)
**Started:** 2026-05-13T15:25:00Z
**Completed:** 2026-05-13T15:50:00Z

## Goal

Turn the working directory into a real pnpm-workspace monorepo, scaffold the four package skeletons, scaffold the three example placeholders, and create the `plan/` directory tree with all artifacts needed by Phases 1–8.

## Deliverables (all created)

### Root
- `.gitignore`, `.gitattributes`, `.editorconfig`, `.npmrc`
- `pnpm-workspace.yaml`
- `package.json` (private, devDependencies: biome, changesets, tsup, typescript ^5.6, vitest)
- `tsconfig.base.json` (target ES2023, strict, NodeNext, verbatimModuleSyntax, exactOptionalPropertyTypes)
- `tsconfig.json` (root, project references to all packages)
- `biome.json`
- `vitest.workspace.json` (JSON form — avoids pre-pnpm-install resolution failures)
- `LICENSE` (BSL 1.1 — Licensor: Dokhna Tach; Change Date: 2030-05-13; Change License: Apache 2.0)
- `LICENSES/COMMERCIAL.md`
- `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
- `.changeset/config.json`, `.changeset/README.md`
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml`

### Packages (skeletons only — empty `src/index.ts`)
- `packages/core/` → `@dokhna-tech/zatca`
- `packages/storage-memory/` → `@dokhna-tech/zatca-storage-memory`
- `packages/storage-mongo/` → `@dokhna-tech/zatca-storage-mongo` (mongoose peer dep)
- `packages/storage-postgres/` → `@dokhna-tech/zatca-storage-postgres` (pg peer dep)

Each package contains: `package.json`, `tsconfig.json`, `tsup.config.ts` (plain-object default export to avoid `import { defineConfig }` pre-flight), `src/index.ts` (`export {};`), `README.md`.

### Examples (placeholders)
- `examples/single-vat-express/`, `examples/multi-vat-saas/`, `examples/byo-storage-prisma/` — each has `README.md` + minimal private `package.json`.

### Plan directory
- `plan/README.md`, `plan/ORCHESTRATOR.md`, `plan/OBSERVER.md`, `plan/PROGRESS.md`, `plan/observer.log`
- `plan/PHASES/PHASE-00-bootstrap.md` (this file) through `PHASE-08-release.md`

## Exit criteria (to verify after final commit)

1. `git init` succeeded; first commit `chore: phase 0 bootstrap` exists.
2. `pnpm install` succeeds with no errors.
3. `pnpm -r typecheck` succeeds (empty `src/index.ts` files trivially pass).
4. `pnpm -r build` succeeds (tsup produces dist files for each package).
5. `plan/` directory contains all 14 files listed above (README, ORCHESTRATOR, OBSERVER, PROGRESS, observer.log, and 9 PHASE-XX files).
6. `plan/PROGRESS.md` shows Phase 0 = completed, Phases 1-8 = pending.

## Deviations from the original spec

- The initial build-engineer agent was content-filtered while writing the BSL 1.1 LICENSE full text. The LICENSE file in this repo contains the BSL 1.1 parameter block (Licensor, Licensed Work, Additional Use Grant, Change Date, Change License) plus a NOTICE that the full standard legal text from https://mariadb.com/bsl11/ must be appended verbatim by the maintainer before any npm publish. This is a documentation hygiene task, not a functional gap.
- `vitest.workspace.json` is used instead of `vitest.workspace.ts` to sidestep TypeScript pre-flight checks that fail before `pnpm install` populates `node_modules/`.
- `tsup.config.ts` uses plain `export default { ... }` instead of `import { defineConfig } from 'tsup'` for the same reason. tsup accepts plain objects.

## What this phase does NOT do

- No real source code in any package. `src/index.ts` is `export {};` everywhere.
- No types, no XML logic, no API client, no storage adapters — those are Phases 1–6.
