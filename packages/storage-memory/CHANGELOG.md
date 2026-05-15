# @dokhna-tech/zatca-storage-memory

## 2.0.3

### Patch Changes

- 540d182: ### Fixed

  - **npm README links and CI badge.** The CI badge URL pointed at `github.com/dokhna-tech/zatca` (a repo that does not exist) and rendered as a broken image on npmjs; corrected to `github.com/dokhna/dokhna-tech-zatca`. All relative links in the root `README.md` (which `@dokhna-tech/zatca` copies verbatim at `prepack` time) resolved against `npmjs.com/package/...` and 404'd — every `./docs/...`, `./packages/...`, `./examples/...`, `./LICENSE`, `./LICENSES/COMMERCIAL.md`, `./CONTRIBUTING.md`, `./SECURITY.md`, `./CHANGELOG.md`, and `./plan/` link is now an absolute `https://github.com/dokhna/dokhna-tech-zatca/blob|tree/main/...` URL.

  ### Changed

  - **Added npm package metadata to all four publishable packages.** `repository` (with `directory` field per the npm monorepo convention), `homepage`, and `bugs` fields are now set on `@dokhna-tech/zatca`, `…-storage-memory`, `…-storage-mongo`, and `…-storage-postgres`. This wires up the GitHub / Issues / Homepage sidebar links on each package's npmjs page.

- Updated dependencies [540d182]
  - @dokhna-tech/zatca@2.0.3

## 2.0.2

### Patch Changes

- 940b22e: adding readme files to packages
- Updated dependencies [940b22e]
  - @dokhna-tech/zatca@2.0.2

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

### Patch Changes

- Updated dependencies
  - @dokhna-tech/zatca@1.0.0
