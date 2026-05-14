---
"@dokhna-tech/zatca": patch
"@dokhna-tech/zatca-storage-memory": patch
"@dokhna-tech/zatca-storage-mongo": patch
"@dokhna-tech/zatca-storage-postgres": patch
---

### Fixed

- **npm README links and CI badge.** The CI badge URL pointed at `github.com/dokhna-tech/zatca` (a repo that does not exist) and rendered as a broken image on npmjs; corrected to `github.com/dokhna/dokhna-tech-zatca`. All relative links in the root `README.md` (which `@dokhna-tech/zatca` copies verbatim at `prepack` time) resolved against `npmjs.com/package/...` and 404'd — every `./docs/...`, `./packages/...`, `./examples/...`, `./LICENSE`, `./LICENSES/COMMERCIAL.md`, `./CONTRIBUTING.md`, `./SECURITY.md`, `./CHANGELOG.md`, and `./plan/` link is now an absolute `https://github.com/dokhna/dokhna-tech-zatca/blob|tree/main/...` URL.

### Changed

- **Added npm package metadata to all four publishable packages.** `repository` (with `directory` field per the npm monorepo convention), `homepage`, and `bugs` fields are now set on `@dokhna-tech/zatca`, `…-storage-memory`, `…-storage-mongo`, and `…-storage-postgres`. This wires up the GitHub / Issues / Homepage sidebar links on each package's npmjs page.
