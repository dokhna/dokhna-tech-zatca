# @dokhna-tech/zatca

## 4.0.1

### Patch Changes

- a7c056f: Fix ZATCA IssueTime timezone warning and enable production onboarding.

  - **IssueTime UTC `Z`**: invoice `issueTime` is now normalized to `HH:mm:ssZ` in the builder constructors, so the XML `<cbc:IssueTime>`, the QR timestamp (tag 3), and the XAdES `SigningTime` all carry the UTC designator and agree. This clears the UBL 2.1 timezone warning and fixes a host-timezone drift in `SigningTime` on non-UTC servers. The public input contract is unchanged — callers may still pass a bare `HH:mm:ss` (the `Z` is appended) or `HH:mm:ssZ`.
  - **Production onboarding**: `onboard()` now accepts `environment: "production"` (previously it threw). It issues the CSR against the `ZATCA-Code-Signing` profile and runs the compliance scenarios on the live `core` gateway as part of production CSID issuance — verified end-to-end against ZATCA production. The server onboarding route and types accept `production` accordingly, and the onboarding docs document the real go-live steps.

## 4.0.0

## 3.0.0

### Minor Changes

- Add optional `onProgress` callback to `onboard()` and `runComplianceTests()`.

  The callback fires after each compliance scenario settles (passed or failed) with `{ scenarioName, invoiceKind, passed, errors, completedCount, totalCount }`. Exceptions thrown inside the callback are swallowed — the hook is observational and never aborts the run. The runner awaits async callbacks sequentially so per-scenario state can be persisted to a tenant store before the next scenario fires.

  This is the integration seam that `@dokhna-tech/zatca-server` uses to surface real onboarding progress via `GET /tenants/:ref/status` even when the originating HTTP socket has dropped.

  New exports from the public API: `ComplianceProgressCallback`, `ComplianceProgressEvent`.

  No behaviour change for callers that omit `onProgress`. The change itself is purely additive; the surrounding 3.0.0 major version reflects the lockstep release of the new `@dokhna-tech/zatca-server` package and the resulting fixed-group propagation, not a breaking change in this package.

## 2.0.4

### Patch Changes

- b8b1615: Documentation hygiene release. No runtime behaviour change; all tests pass and golden-vector fixtures remain byte-identical.

  - Source comments across the core package and storage adapters that previously named a specific helper-of-origin now refer to it generically as "the legacy helper" / "legacy in-tree helper". Behaviour is unchanged — only prose was rewritten.
  - `packages/core/src/fixtures/README.md` rewritten to drop personal-machine absolute paths and any specific helper name.
  - TypeDoc HTML regenerated so the published API reference reflects the updated source comments.
  - `plan/` directory removed from the repo and gitignored.
  - Fixed a stale migration-doc filename reference in the historical `[1.0.0]` `CHANGELOG.md` entry and in `RELEASE-NOTES-v1.0.0.md` — it now points at the actual filename `docs/migration-from-existing-helper.md`.

- 060e36d: Toolchain refresh. No runtime behaviour change; all 332 tests pass.

  Consumer-visible manifest changes:

  - `engines.node` raised from `>=20.0.0` to `>=20.19.0` on all four published packages. Node 20.19 (April 2025) is the floor required by mongoose 9 and mongodb-memory-server 11; the previous range had been silently understating the real minimum. Node 20.19 is still inside the Node 20 LTS line.
  - `@dokhna-tech/zatca-storage-mongo` `peerDependencies.mongoose` widened from `>=8.0.0` to `>=9.0.0`. The package was already developed and tested against mongoose 9.x; the peer range now matches reality. Consumers still on mongoose 8 should pin `@dokhna-tech/zatca-storage-mongo@<2.x` until they can upgrade mongoose.
  - `@dokhna-tech/zatca` `peerDependencies.vitest` widened from `"^2.0.0 || ^3.0.0"` to `"^2.0.0 || ^3.0.0 || ^4.0.0"` (the `test-helpers/storage-adapter-conformance` suite). No consumer action required — vitest 2/3 still work.

  Internal toolchain bumps (no consumer impact):

  - tsup 8.3 → 8.5.1, tsx 4.21 → 4.22, @changesets/cli 2.27 → 2.31, typedoc 0.28.0 → 0.28.19, pg-mem 3.0.5 → 3.0.14 (dev).
  - vitest 2 → 4 (root `vitest.workspace.json` replaced with a root `vitest.config.ts` using `test.projects`).
  - @biomejs/biome 1.9 → 2.4 (config migrated via `biome migrate --write`).
  - typescript 5.6 → 6.0.3, with `ignoreDeprecations: "6.0"` set in `tsconfig.base.json` to absorb tsup's still-injected `baseUrl` until tsup catches up.

## 2.0.3

### Patch Changes

- 540d182: ### Fixed

  - **npm README links and CI badge.** The CI badge URL pointed at `github.com/dokhna-tech/zatca` (a repo that does not exist) and rendered as a broken image on npmjs; corrected to `github.com/dokhna/dokhna-tech-zatca`. All relative links in the root `README.md` (which `@dokhna-tech/zatca` copies verbatim at `prepack` time) resolved against `npmjs.com/package/...` and 404'd — every `./docs/...`, `./packages/...`, `./examples/...`, `./LICENSE`, `./LICENSES/COMMERCIAL.md`, `./CONTRIBUTING.md`, `./SECURITY.md`, `./CHANGELOG.md`, and `./plan/` link is now an absolute `https://github.com/dokhna/dokhna-tech-zatca/blob|tree/main/...` URL.

  ### Changed

  - **Added npm package metadata to all four publishable packages.** `repository` (with `directory` field per the npm monorepo convention), `homepage`, and `bugs` fields are now set on `@dokhna-tech/zatca`, `…-storage-memory`, `…-storage-mongo`, and `…-storage-postgres`. This wires up the GitHub / Issues / Homepage sidebar links on each package's npmjs page.

## 2.0.2

### Patch Changes

- 940b22e: adding readme files to packages

## 1.0.0

### Major Changes

- Initial v1.0.0 release.

  This is the first stable release of the `@dokhna-tech/zatca` family.
  It provides a complete, audited implementation of Saudi Arabia's
  ZATCA Phase 2 e-invoicing requirements for Node.js: UBL XML build,
  XMLDSig signing, ZATCA SHA-256 hashing with byte-identity golden
  vectors, TLV QR generation, full ZATCA API client (onboarding,
  compliance, clearance, reporting, status, cancellation), and three
  optional storage adapters (memory / mongo / postgres) sharing a
  single `StorageAdapter` contract.

  See `CHANGELOG.md` for the full feature list.
