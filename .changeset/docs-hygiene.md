---
"@dokhna-tech/zatca": patch
"@dokhna-tech/zatca-storage-memory": patch
"@dokhna-tech/zatca-storage-mongo": patch
"@dokhna-tech/zatca-storage-postgres": patch
---

Documentation hygiene release. No runtime behaviour change; all tests pass and golden-vector fixtures remain byte-identical.

- Source comments across the core package and storage adapters that previously named a specific helper-of-origin now refer to it generically as "the legacy helper" / "legacy in-tree helper". Behaviour is unchanged — only prose was rewritten.
- `packages/core/src/fixtures/README.md` rewritten to drop personal-machine absolute paths and any specific helper name.
- TypeDoc HTML regenerated so the published API reference reflects the updated source comments.
- `plan/` directory removed from the repo and gitignored.
- Fixed a stale migration-doc filename reference in the historical `[1.0.0]` `CHANGELOG.md` entry and in `RELEASE-NOTES-v1.0.0.md` — it now points at the actual filename `docs/migration-from-existing-helper.md`.
