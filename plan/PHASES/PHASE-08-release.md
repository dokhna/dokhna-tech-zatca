# Phase 8 — Release Hygiene

**Status:** pending
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
npm install /Users/ameensaeed/Documents/Node/dokhna-tach-zatca-phase-2/packages/core/dokhna-tach-zatca-1.0.0.tgz \
            /Users/ameensaeed/Documents/Node/dokhna-tach-zatca-phase-2/packages/storage-memory/dokhna-tach-zatca-storage-memory-1.0.0.tgz
node -e "const z = require('@dokhna-tach/zatca'); console.log(Object.keys(z))"
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
