# @dokhna-tech/zatca-server

## 4.0.0

### Minor Changes

- d321cf6: DB-backed registry drivers — Mongo + Postgres implementations of `TenantStore`, `CredentialVault`, `ApiKeyStore`, and `AuditLog`.

  New exports:

  - **Postgres** — `createPostgresRegistry`, `createPostgresTenantStore`, `createPostgresCredentialVault`, `createPostgresApiKeyStore`, `createPostgresAuditLog`. Use any `pg`-compatible pool (also accepts the same `Pool` already passed to `@dokhna-tech/zatca-storage-postgres`). Companion DDL ships at `migrations/postgres/001_initial.sql`. `withPgTransaction` helper wraps a callback in `BEGIN/COMMIT/ROLLBACK` so callers can bundle a mutation + audit-row write into a single atomic transaction.
  - **Mongo** — `createMongoRegistry`, `createMongoTenantStore`, `createMongoCredentialVault`, `createMongoApiKeyStore`, `createMongoAuditLog`. Use any `mongoose.Connection` (the same one passed to `@dokhna-tech/zatca-storage-mongo` works). `buildServerModels` exposes the underlying Mongoose models for callers who need to add their own indexes or sessions. Atomic CAS on `setState` is implemented via `findOneAndUpdate` with a state predicate. Multi-document transactional audit writes require a replica set; the HTTP layer in the upcoming PR3 manages sessions explicitly.

  Both implementations satisfy the same interfaces as the in-memory reference impls — caller code that holds a `TenantStore` / `CredentialVault` / `ApiKeyStore` works against any backend without modification.

  Peer-dependency footprint widens: `mongoose` and `pg` join `@dokhna-tech/zatca` as optional peers. Storage adapter packages also become optional peers so callers can mix-and-match without forced dependencies.

  Token storage shape: API-key `token_hash` and `salt` are persisted as base64-encoded `TEXT` (not `BYTEA`) — the 33% size overhead is the cost of portable round-tripping across Postgres dialects and through pg-mem's test harness, which mangles non-ASCII bytes.

  Postgres index footprint: the 001 migration creates a composite `(state, production_certificate_expires_at)` index on `zatca_server_tenants` that serves both state-filtered listing and the "expiring within N days" admin query. Partial-predicate variants are intentionally avoided for pg-mem compatibility; production deployers wanting partial indexes can layer them in a 002 migration without affecting correctness.

- d321cf6: HTTP surface — Fastify routes, auth middleware, idempotency, observability, CLI bootstrap.

  New exports:

  - **App factory** — `buildApp` composes config + DI into a fully wired Fastify instance ready to `listen()` or `inject()`.
  - **CLI** — `bin/zatca-server` reads env + boots against `memory | mongo | postgres` storage drivers (resolved by `STORAGE_DRIVER`).
  - **Routes** — admin tenant CRUD, onboarding/credentials-rotate/status/unlock, API-key management, tenant invoice issue/cancel/status/check-compliance, ops (`/healthz`, `/readyz`, `/metrics`).
  - **Middleware** — error→HTTP mapping (`mapErrorToResponse`), in-memory idempotency store (Redis-compatible interface), cache-key builder.
  - **Observability** — `createLogger` (pino with project-wide secret redaction), `createMetrics` (prom-client registry with the curated counter/histogram/gauge set).
  - **Config** — `loadConfig` reads env, validates with zod, fails eagerly with structured errors on misconfiguration.

  API contract highlights:

  - Admin endpoints authenticate against a list of labelled keys (`ZATCA_SERVER_ADMIN_KEYS=label:key,...`); matched label is recorded in every audit row for attribution.
  - Tenant invoice endpoints require `Authorization: Bearer zts_<env>_<tenantRef>_<32 base32>`; mismatch between bearer's tenantRef and URL's `:ref` yields 403, not 401.
  - Error responses always have shape `{ error: { name, message, zatcaRequestId?, validationResults? } }`; ZATCA `requestId` is also surfaced as the `X-Zatca-Request-Id` response header.
  - Onboarding routes are synchronous and may block up to `ZATCA_SERVER_ONBOARDING_TIMEOUT_MS` (default 180s); HTTP connection + read timeouts auto-adjust.

  53 new tests cover config validation, idempotency semantics, error mapping, and a black-box integration suite that exercises the major flows via `app.inject()` against an in-memory stack.

  The CLI lands at this version but the Docker image + standalone-server example land in PR4.

### Patch Changes

- d321cf6: Ship the package as a Docker image + a docker-compose-driven walkthrough.

  - `packages/server/Dockerfile` — multi-stage build on `node:20-slim` (NOT distroless — OpenSSL CLI is required by the onboarding CSR + keygen probe), tini as PID 1, non-root user, baked-in health check against `/healthz`.
  - `examples/standalone-server/` — two docker-compose profiles (`docker-compose.mongo.yml` boots a 1-node Mongo replica set + the server; `docker-compose.postgres.yml` boots Postgres + a migrations runner + the server), `.env.example` with key-generation hints, a curl-driven `README.md` walkthrough, and an `onboard-and-issue.http` request collection for the VS Code REST Client.
  - Root README + `examples/multi-vat-saas/README` updated to point new operators at the standalone-server example as the recommended turnkey path; the SDK-embedded approach remains documented for shops that want full control over their own server process.

  No public-API change — the package's behaviour and types are unchanged. The `patch` declaration is honest to that, but per the project's fixed-group changeset semantics the family ships together at whatever tier the highest-bumped PR in the release cycle resolves to.

  - @dokhna-tech/zatca@4.0.0
  - @dokhna-tech/zatca-storage-memory@4.0.0
  - @dokhna-tech/zatca-storage-mongo@4.0.0
  - @dokhna-tech/zatca-storage-postgres@4.0.0

## 3.0.0

### Major Changes

- Initial release of `@dokhna-tech/zatca-server` — the foundation layer for the standalone multi-tenant ZATCA server. Lands as part of the 3.0.0 lockstep bump across the package family.

  Ships:

  - `SecretCipher` interface with a kid-versioned AEAD envelope `{ kid, alg, iv, ct, tag }`. Built-in `aes-256-gcm` impl backed by a master-key ring; rotating the active kid is zero-downtime — new writes flip immediately while old envelopes still decrypt under retired kids. Dev-only `noop` cipher for local boot.
  - Three split tenant interfaces — `TenantStore` (identity + lifecycle), `CredentialVault` (encrypted signing material), `ApiKeyStore` (bearer tokens, `zts_<env>_<tenantRef>_<32 base32>` shape, scrypt-hashed). In-memory reference implementations of all three, plus a `createMemoryRegistry` convenience.
  - Pure-logic auth helpers: admin-key list verifier (`label:key,label:key`, constant-time comparison, attribution-friendly) and tenant-bearer verifier (resolves through `ApiKeyStore`, returns 401 / 403 distinguished by `statusHint`).
  - Append-only `AuditLog` interface with an in-memory impl, plus `redactSecrets` — a deep-walking helper that scrubs OTPs, private keys, BSTs, api secrets, and bearer tokens out of payloads before they land in a row.
  - `runOnboarding` — tenant-aware wrapper around `core.onboard()`. Acquires a per-tenant lock with a configurable TTL, threads the new `onProgress` hook from core to persist per-scenario progress, writes the encrypted vault row, parses the production-CSID `notAfter` via core's `getCertificateExpirationDate`, transitions the tenant to `production-ready` (or `failed` with `lastError`), and writes an audit row on both paths.

  HTTP routes (Fastify), DB-backed Mongo + Postgres registry drivers, and the Dockerfile + standalone-server example land in subsequent PRs against this same 3.x line.

### Patch Changes

- Updated dependencies
  - @dokhna-tech/zatca@3.0.0
