# Phase 7 — Documentation & Examples

**Status:** pending
**Agent:** typescript-pro (write) → architect-reviewer (review pass)
**Estimated effort:** 1–2 sessions

## Goal

Make the package adoptable by an engineer who has never seen the codebase. Ship a complete `docs/` set, three working `examples/` projects, and a `README.md` that gets someone to a signed invoice in 15 minutes.

## Files to create

### Docs (`docs/`)

```
docs/
├── getting-started.md             # install, OpenSSL prereq, first signed invoice
├── single-vat.md                  # wire-up for a single VAT number
├── multi-vat-saas.md              # TenantScope pattern, certificate isolation, encryption at rest
├── storage-adapters.md            # contract reference + how to write your own (Drizzle worked example)
├── onboarding.md                  # CSR generation, OTP flow, compliance vs production CSIDs, renewal
├── compliance-tests.md            # running runComplianceTests, interpreting results
├── migration-from-existing-helper.md  # explicit function-by-function mapping for rwiqha helper users
├── troubleshooting.md             # common ZATCA error codes and fixes
├── security.md                    # cert storage, secret rotation, OpenSSL, what we log (nothing)
└── api-reference.md               # typedoc-generated reference (link out to ./typedoc/)
```

### Examples (replace Phase 0 placeholders with real, working code)

#### `examples/single-vat-express/`
- `package.json` — express, dotenv, @dokhna-tach/zatca, @dokhna-tach/zatca-storage-memory
- `src/server.ts` — Express app with POST `/invoices` that builds + signs + records
- `src/zatca-client.ts` — wires up storage-memory and the issuer
- `.env.example` — VAT_NUMBER, EGS_UUID, CERT_PEM_PATH, etc.
- `README.md` — copy-paste quickstart

#### `examples/multi-vat-saas/`
- `package.json` — fastify, @dokhna-tach/zatca, @dokhna-tach/zatca-storage-mongo, mongoose
- `src/server.ts` — Fastify with per-tenant route guards
- `src/tenant-router.ts` — resolves `TenantScope` from request headers
- `src/zatca-mongo.ts` — MongoStorageAdapter setup
- `docker-compose.yml` — MongoDB for local dev
- `.env.example`
- `README.md`

#### `examples/byo-storage-prisma/`
- `package.json` — prisma, @dokhna-tach/zatca, @prisma/client
- `prisma/schema.prisma` — schema matching `InvoiceRecord` + `CounterRecord`
- `src/prisma-adapter.ts` — implements `StorageAdapter` against Prisma
- `src/index.ts` — short demo
- `README.md`

## Documentation style guide

- Lead with code in every doc — show then explain.
- Every public API mention is hyperlinked to typedoc.
- Multi-VAT and single-VAT docs are SHORT and FOCUSED — the user picks one based on their situation.
- Troubleshooting page is keyed by ZATCA error code (e.g., `BR-KSA-02`, `BR-KSA-09`) — list common codes and what they mean in practice. Capture these from rwiqha's compliance test runs.
- Migration doc has a function-by-function table: `rwiqha-backend function name` → `@dokhna-tach/zatca function name` → notes on signature changes.

## Typedoc setup

Add `typedoc` to devDeps. Configure `typedoc.json` at repo root to emit `docs/typedoc/` HTML from `packages/core/src/index.ts`. Run as `pnpm docs:api` (script in root `package.json`). Commit the generated HTML for GitHub Pages publishing.

## Exit tests

1. `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test` pass — examples are part of the workspace and must build.
2. Each of the three examples has its own working `pnpm dev` or `pnpm start` and a README that runs without modification (with a `.env` populated).
3. `pnpm --filter @dokhna-tach-examples/single-vat-express start` boots, accepts a POST, returns a signed XML body.
4. `pnpm docs:api` generates typedoc HTML without errors.
5. Manual review by the architect-reviewer agent — score docs across: clarity, completeness, copy-pasteability, accuracy.

## What this phase does NOT do

- No release prep — Phase 8.
- No new core features.
