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
