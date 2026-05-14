# Phase 8 — Release Hygiene

**Status:** completed
**Agent:** architect-reviewer (audit pass) → herald (release prep)
**Estimated effort:** 1 session

## Goal

Ship v1.0.0 as a publishable, citable npm release of all four packages with clean CI, audited security posture, and complete release artefacts.

## Tasks

### Security audit pass (architect-reviewer)

1. `grep -RE "console\\.(log|warn|error|info|debug)" packages/*/src` — must return zero matches outside `debug()`-guarded paths.
2. `grep -R -i "TODO\\|FIXME\\|XXX\\|HACK" packages/*/src` — every match must be resolved or have a ticket reference.
3. `grep -RE "api[_-]?secret|private[_-]?key|binarySecurityToken" packages/*/src` — verify no test fixtures or hardcoded credentials leaked into the publishable tree.
4. Audit `LICENSE`: ensure the full BSL 1.1 text is present (replacing the Phase 0 NOTICE).
5. Audit `README.md`: license claim matches `LICENSE`, badges resolve.
6. Audit `SECURITY.md` and `CODE_OF_CONDUCT.md` placeholder emails — replace with real contact addresses.
7. `pnpm audit` clean (or every advisory is documented + risk-accepted).
8. `pnpm licenses list` — confirm all transitive deps are compatible with BSL-1.1 redistribution.

### Release prep (herald)

1. Create initial changesets for all four packages → `1.0.0`.
2. Run `pnpm version-packages` locally; review the diff.
3. Run `pnpm release` in dry-run mode (`--dry-run` if changesets supports; otherwise `pnpm -r publish --dry-run`).
4. Inspect tarballs (`pnpm pack` for each package; verify `files` glob is correct, no `src/` or `*.test.ts` leak in).
5. Write `CHANGELOG.md` at repo root summarising v1.0.0.
6. Write release notes draft for GitHub Release.
7. Write an announcement blog post draft (~500 words) covering: why, what, dual-license rationale, link to docs.

### CI hardening

1. Verify `ci.yml` matrix is green on Node 20 + Node 22 × macOS + Ubuntu.
2. Add a `release.yml` smoke job that runs after merge to main, gates on changesets bot PR.
3. Add Codecov upload to CI (token via repo secret).
4. Add `pnpm audit` step to CI (fail on high/critical).

### Real-world install test

In a sibling directory:

```bash
mkdir -p /tmp/zatca-install-test && cd /tmp/zatca-install-test
npm init -y
npm install /Users/ameensaeed/Documents/Node/dokhna-tech-zatca-phase-2/packages/core/dokhna-tech-zatca-1.0.0.tgz \
            /Users/ameensaeed/Documents/Node/dokhna-tech-zatca-phase-2/packages/storage-memory/dokhna-tech-zatca-storage-memory-1.0.0.tgz
node -e "const z = require('@dokhna-tech/zatca'); console.log(Object.keys(z))"
```

Must succeed without errors and emit the expected public API surface.

## Exit criteria

1. All 8 security-audit items pass.
2. `pnpm release --dry-run` (or equivalent) succeeds for all four packages.
3. Tarballs verified to contain only `dist/`, `README.md`, `LICENSE`.
4. CI is green on the latest commit.
5. Real-world install test passes.
6. CHANGELOG.md, release notes, and announcement draft all exist.

## What this phase does NOT do

- No new features.
- No npm publish to the actual public registry — that is a human decision made AFTER this phase reports success.

## APPENDIX: Audit Findings (Phase 8 outcome)

### Security & quality audit

| Check | Status | Notes |
|-------|--------|-------|
| 1. No `console.*` in `packages/*/src` | PASS | 0 matches |
| 2. No `TODO`/`FIXME`/`XXX`/`HACK` in src | PASS | 0 matches |
| 3. No hardcoded credentials in source | PASS | All hits are `.test.ts` fixtures or a JSDoc `@example` block in `onboard.ts` (test OTP `123456`). No runtime/published-code credential leakage. |
| 4. No `any` outside JSDoc | PASS | 0 matches |
| 5. LICENSE BSL parameter block present | PASS | Licensor, Licensed Work, Additional Use Grant, Change Date (2030-05-13), Change License (Apache 2.0) all present. Verbatim BSL 1.1 upstream body appended in follow-up commit `c94c874`. |
| 6. README license claim matches LICENSE | PASS | Both state BSL 1.1 → Apache 2.0 on 2030-05-13 |
| 7. SECURITY.md / CODE_OF_CONDUCT.md / CONTRIBUTING.md exist | PASS | All three present. Contact emails finalised to `@dokhna.tech` addresses in `c94c874` (`security@`, `licensing@`, `zatca@`). |
| 8. `pnpm audit` clean of high/critical | PASS-with-WARN | 0 high/critical. 2 moderate (both dev-only): vitest→esbuild, vitest→vite. Previous `fast-xml-parser` runtime advisory resolved by bump to `^5.7.0` (resolves `5.8.0`); golden vectors held byte-identical, all 332 tests pass. |
| 9. `pnpm licenses list` — no GPL/AGPL/SSPL/Commons Clause in runtime | PASS | All prod deps are MIT / Apache-2.0 / BSD / ISC / 0BSD / CC0. No copyleft. |
| 10. No workspace dep cycles — storage-* uses core only as peerDep | PASS | All three adapters list `@dokhna-tech/zatca` in `peerDependencies`, not `dependencies`. |

### Tarball inspection

| Package | Tarball size | Files OK | Notes |
|---------|--------------|----------|-------|
| `@dokhna-tech/zatca` | 317 KB (gz) | YES | LICENSE + README + dist (ESM/CJS + .d.ts/.d.cts + test-helpers entry). No src, no tests, no tsconfig. |
| `@dokhna-tech/zatca-storage-memory` | 8.0 KB (gz) | YES | LICENSE + README + dist. |
| `@dokhna-tech/zatca-storage-mongo` | 11.2 KB (gz) | YES | LICENSE + README + dist. |
| `@dokhna-tech/zatca-storage-postgres` | 10.4 KB (gz) | YES | LICENSE + README + dist + `migrations/001_initial.sql` + `migrations/README.md`. |

LICENSE copy is performed by a `prepack` script in each package (`cp ../../LICENSE ./LICENSE`). Verified by inspecting all four `*.tgz` archives.

### Dry-run publish

`pnpm -r publish --dry-run --access public --no-git-checks`:

| Package | Version | Status |
|---------|---------|--------|
| `@dokhna-tech/zatca` | 1.0.0 | would-publish |
| `@dokhna-tech/zatca-storage-memory` | 1.0.0 | would-publish |
| `@dokhna-tech/zatca-storage-mongo` | 1.0.0 | would-publish |
| `@dokhna-tech/zatca-storage-postgres` | 1.0.0 | would-publish |

Three example packages (`single-vat-express`, `multi-vat-saas`, `byo-storage-prisma`) are `"private": true` and correctly skipped.

### Install smoke test

In `/tmp/zatca-install-test`, installed the core + memory tarballs and verified both ESM and CJS imports:

- `import('@dokhna-tech/zatca')` → 120 exports
- `require('@dokhna-tech/zatca')` → 120 exports
- `import('@dokhna-tech/zatca-storage-memory')` → `createMemoryStorageAdapter`

### Known gaps for v1.1.0

- Replace `@fidm/x509` (unmaintained) with `pkijs` for X.509 parsing.
- Pure-JS CSR/key generation path so OpenSSL CLI is no longer a hard runtime dep (currently required for `onboard()`).
- Optional `@dokhna-tech/zatca-pdf` sub-package for PDF/A-3 invoice attachment flows.
- 2 moderate `pnpm audit` advisories remain, both dev-only (vitest→esbuild, vitest→vite). Resolved by upgrading vitest in a v1.0.x bump.

### Action items before public npm publish

1. ✅ ~~Replace placeholder emails.~~ Done in `c94c874` — `security@dokhna.tech`, `licensing@dokhna.tech`, `zatca@dokhna.tech`.
2. ✅ ~~Paste the verbatim BSL 1.1 upstream body.~~ Done in `c94c874`; maintainer-action banner removed.
3. ✅ ~~Bump `fast-xml-parser` to `>=5.7.0`.~~ Bumped to `^5.7.0` (resolves `5.8.0`); audit no longer flags runtime advisories. Source comment in `src/xml/document.ts` refreshed.
4. ✅ ~~Decide on commercial-license contact.~~ Finalised to `licensing@dokhna.tech` in `LICENSES/COMMERCIAL.md`.
5. **Configure repository secrets** for the release workflow:
   - `NPM_TOKEN` (npm publish)
   - `CODECOV_TOKEN` (coverage upload)
6. **Verify Codecov repo enrollment** so the `codecov/codecov-action@v4` step has a target.
7. **Tag and push** — only after the above are done: `git tag v1.0.0 && git push --tags`.

