# @dokhna-tech/zatca-server

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
