# Contributing

Thank you for considering a contribution. This project is in alpha — see [`plan/`](./plan/README.md) for the active multi-phase development plan. Most large changes are already scheduled.

## Before you start

1. Read [`plan/PROGRESS.md`](./plan/PROGRESS.md) to see what phase is currently active.
2. Read the phase's MD file under [`plan/PHASES/`](./plan/PHASES/) to understand the scope.
3. For new ideas, open an issue first to discuss.

## Local development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

## Branch / commit / PR conventions

- Branch off `main`.
- Use conventional commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`, `ci:`.
- Add a changeset for any user-visible change: `pnpm changeset`.
- All PRs must pass CI (typecheck, lint, build, test) on Node 20 and Node 22.

## Licensing of contributions

By submitting code you agree your contributions are licensed under the same dual-license as the project (BSL 1.1 with Apache 2.0 conversion on 2030-05-13). If your contribution requires a different arrangement, raise it in the PR.

## Code of conduct

See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
