# Contributing

Thank you for considering a contribution. See [`CHANGELOG.md`](./CHANGELOG.md) for the project's release history.

## Before you start

1. For new ideas or non-trivial changes, open an issue first to discuss.
2. **Security issues never go in a public issue.** See [`SECURITY.md`](./SECURITY.md).

## Local development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

Use Node 20 or 22 — CI runs both, on Ubuntu and macOS.

## Branch, commit, and PR conventions

- Branch off `main`. Use a descriptive branch name (`fix/qr-tlv-length`, `feat/csr-helper`, …).
- **Sign your commits.** `main` requires a verified signature (GPG or SSH). See
  [GitHub's guide](https://docs.github.com/authentication/managing-commit-signature-verification).
  Quick sanity check: `git log --show-signature -1` should print `Good signature`.
- Use conventional commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:`, `perf:`, `ci:`. Use `feat!:` / `fix!:` (or a `BREAKING CHANGE:` footer) for
  breaking changes.
- Keep a linear history. Rebase on top of `main` instead of merging it in.
- Add a changeset (`pnpm changeset`) for any user-visible change.
- Fill in the PR template, including the **security & supply-chain impact** section.

## Code review and merging

- Every change to `main` goes through a pull request — direct pushes are blocked.
- CI must be green on Node 20 and Node 22, on Ubuntu and macOS, plus the
  CodeQL and dependency-review scans. GitHub's built-in secret scanning
  with push protection guards against committed credentials.
- Conversations must be resolved before merge.
- Only **squash-merge** is enabled. The squash commit subject is the PR title — make
  sure it follows the conventional-commit prefix above.
- The head branch is auto-deleted after merge.
- Force-pushing or deleting `main` is disabled for everyone.

## Dependency policy

- Add a new runtime dependency only when there is no reasonable in-tree alternative.
- Dev dependencies are looser, but justify large additions in the PR description.
- Dependabot opens grouped PRs weekly; high-severity findings from
  `dependency-review-action` will fail CI.
- Avoid licences incompatible with the project's BSL 1.1 + future Apache 2.0
  conversion (AGPL, GPL). See `.github/workflows/dependency-review.yml`.

## Licensing of contributions

By submitting code you agree your contributions are licensed under the same
dual-license as the project (BSL 1.1 with Apache 2.0 conversion on 2030-05-13).
If your contribution requires a different arrangement, raise it in the PR.

## Code of conduct

See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Reports go to
`zatca@dokhna.tech`.
