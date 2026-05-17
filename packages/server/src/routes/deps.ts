/**
 * Shared dependency-injection container passed to every route plugin.
 *
 * The Fastify app factory builds this once at boot and threads it to
 * each registered plugin via the `opts` argument. Tests build a
 * RouteDeps from in-memory stores; production from real DB-backed
 * stores.
 */

import type { onboard, StorageAdapter } from "@dokhna-tech/zatca";

import type { AuditLog } from "../audit/index.js";
import type { AdminKeyVerifier, TenantBearerVerifier } from "../auth/index.js";
import type { ServerConfig } from "../config.js";
import type { SecretCipher } from "../crypto/index.js";
import type { IdempotencyStore } from "../middleware/index.js";
import type { ServerMetrics } from "../observability/index.js";
import type { ApiKeyStore } from "../tenants/api-key-store.js";
import type { CredentialVault } from "../tenants/credential-vault.js";
import type { TenantStore } from "../tenants/store.js";

/**
 * Bundle of stores + audit log scoped to a single atomic unit of
 * work. Passed to the {@link RouteDeps.withUnitOfWork} callback —
 * route handlers do mutations + the matching audit-log write against
 * this bundle so both land in (or roll back from) the same DB
 * transaction.
 *
 * For backends that can offer true multi-statement atomicity
 * (Postgres via a checked-out PoolClient, MongoDB via a replica-set
 * session) the bundle is transaction-scoped. For backends that
 * cannot (in-memory tests, MongoDB without a replica set) the bundle
 * is the same instances as `RouteDeps.registry` + `auditLog` and the
 * callback runs without isolation — a best-effort fallback that's
 * still correct in single-process tests and is the documented
 * limitation of replica-set-less Mongo.
 */
export interface UnitOfWork {
  readonly tenants: TenantStore;
  readonly vault: CredentialVault;
  readonly apiKeys: ApiKeyStore;
  readonly auditLog: AuditLog;
}

/**
 * Run `fn` inside a transactional unit of work. The callback's
 * return value becomes the call's resolved value. On throw, the
 * underlying backend rolls back the transaction (Postgres) or
 * aborts the session (Mongo); in-memory falls through as no-op.
 *
 * Route handlers that perform a mutation + an audit-log write
 * (`tenants.create` then `auditLog.write`, `apiKeys.revoke` then
 * `auditLog.write`, etc.) MUST use this primitive instead of issuing
 * the two awaits against the top-level registry — without it, a
 * network blip between awaits leaves a row mutated with no audit
 * trail.
 */
export type WithUnitOfWork = <T>(fn: (uow: UnitOfWork) => Promise<T>) => Promise<T>;

/**
 * Per-route deps. All fields are required except `metrics` and
 * `onboardingHooks` (test-injection seams).
 */
export interface RouteDeps {
  readonly config: ServerConfig;
  readonly registry: {
    readonly tenants: TenantStore;
    readonly vault: CredentialVault;
    readonly apiKeys: ApiKeyStore;
  };
  /** Invoice storage adapter — typically `@dokhna-tech/zatca-storage-{mongo,postgres}`. */
  readonly storage: StorageAdapter;
  readonly auditLog: AuditLog;
  /**
   * Transactional unit-of-work primitive. Wraps mutation + audit
   * write into a single atomic operation when the backend supports
   * it (Postgres, Mongo+replSet); falls through as a pass-through on
   * backends that don't (in-memory, plain Mongo).
   */
  readonly withUnitOfWork: WithUnitOfWork;
  readonly cipher: SecretCipher;
  readonly adminVerifier: AdminKeyVerifier;
  readonly tenantVerifier: TenantBearerVerifier;
  readonly idempotencyStore: IdempotencyStore;
  readonly metrics?: ServerMetrics;
  /**
   * Test-injection seam — replace `core.onboard` and the certificate
   * expiry parser. Production callers leave undefined.
   */
  readonly onboardingHooks?: {
    readonly onboardFn?: typeof onboard;
    readonly getExpiry?: (productionCertificate: string) => Date;
  };
}
