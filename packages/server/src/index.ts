/**
 * `@dokhna-tech/zatca-server` — public entrypoint.
 *
 * Standalone multi-tenant ZATCA Phase 2 server. Distributes as a
 * runnable artifact (Docker image, landing in PR4) and as a library
 * so adopters who want to embed the same primitives in their own host
 * can do so.
 *
 * This PR (foundation) ships:
 *
 * - Error hierarchy (`ZatcaServerError` + subclasses).
 * - `SecretCipher` interface + `aes-256-gcm` kid-versioned impl + dev
 *   no-op cipher.
 * - Three split tenant interfaces — `TenantStore`, `CredentialVault`,
 *   `ApiKeyStore` — plus an in-memory reference implementation.
 * - Pure-logic auth helpers: admin-key list verifier and tenant-bearer
 *   verifier (no Fastify dep).
 * - Append-only `AuditLog` interface + in-memory impl + a deep-walking
 *   `redactSecrets` helper.
 * - `runOnboarding` — tenant-aware wrapper around `core.onboard` that
 *   acquires a per-tenant lock, persists per-scenario progress (via
 *   the additive `onProgress` callback landed in core 2.1.0), writes
 *   to the vault, transitions lifecycle state, and writes the audit
 *   row in both success and failure paths.
 *
 * Fastify app factory, route handlers, DB-backed registry impls
 * (Mongo + Postgres), Dockerfile, and the standalone-server example
 * land in subsequent PRs.
 */

export * from "./audit/index.js";
export * from "./auth/index.js";
export * from "./crypto/index.js";
export * from "./errors.js";
export * from "./onboarding/index.js";
export * from "./tenants/index.js";
