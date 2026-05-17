---
"@dokhna-tech/zatca-server": minor
---

HTTP surface — Fastify routes, auth middleware, idempotency, observability, CLI bootstrap.

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
