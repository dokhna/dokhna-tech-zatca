---
"@dokhna-tech/zatca-server": minor
---

DB-backed registry drivers — Mongo + Postgres implementations of `TenantStore`, `CredentialVault`, `ApiKeyStore`, and `AuditLog`.

New exports:

- **Postgres** — `createPostgresRegistry`, `createPostgresTenantStore`, `createPostgresCredentialVault`, `createPostgresApiKeyStore`, `createPostgresAuditLog`. Use any `pg`-compatible pool (also accepts the same `Pool` already passed to `@dokhna-tech/zatca-storage-postgres`). Companion DDL ships at `migrations/postgres/001_initial.sql`. `withPgTransaction` helper wraps a callback in `BEGIN/COMMIT/ROLLBACK` so callers can bundle a mutation + audit-row write into a single atomic transaction.
- **Mongo** — `createMongoRegistry`, `createMongoTenantStore`, `createMongoCredentialVault`, `createMongoApiKeyStore`, `createMongoAuditLog`. Use any `mongoose.Connection` (the same one passed to `@dokhna-tech/zatca-storage-mongo` works). `buildServerModels` exposes the underlying Mongoose models for callers who need to add their own indexes or sessions. Atomic CAS on `setState` is implemented via `findOneAndUpdate` with a state predicate. Multi-document transactional audit writes require a replica set; the HTTP layer in the upcoming PR3 manages sessions explicitly.

Both implementations satisfy the same interfaces as the in-memory reference impls — caller code that holds a `TenantStore` / `CredentialVault` / `ApiKeyStore` works against any backend without modification.

Peer-dependency footprint widens: `mongoose` and `pg` join `@dokhna-tech/zatca` as optional peers. Storage adapter packages also become optional peers so callers can mix-and-match without forced dependencies.

Token storage shape: API-key `token_hash` and `salt` are persisted as base64-encoded `TEXT` (not `BYTEA`) — the 33% size overhead is the cost of portable round-tripping across Postgres dialects and through pg-mem's test harness, which mangles non-ASCII bytes.

Postgres index footprint: the 001 migration creates a composite `(state, production_certificate_expires_at)` index on `zatca_server_tenants` that serves both state-filtered listing and the "expiring within N days" admin query. Partial-predicate variants are intentionally avoided for pg-mem compatibility; production deployers wanting partial indexes can layer them in a 002 migration without affecting correctness.
