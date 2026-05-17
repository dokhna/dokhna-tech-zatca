/**
 * Fastify app factory.
 *
 * Composes config + DI into a configured Fastify instance. The
 * factory exposes a `buildApp` function (not a listening server) so
 * tests can call `app.inject({ method, url, payload })` for fast
 * black-box checks without binding a real port.
 *
 * Bootstrap responsibilities:
 *  - Build the cipher from the configured master-key ring.
 *  - Build the admin + tenant auth verifiers.
 *  - Build the idempotency store + metrics registry.
 *  - Wire the pino logger (with secret redaction) onto Fastify.
 *  - Register the request-timing / request-counting metrics hook.
 *  - Install the global error handler.
 *  - Register every route plugin.
 */

import type { StorageAdapter } from "@dokhna-tech/zatca";
import fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";

import type { AuditLog } from "./audit/index.js";
import { createAdminKeyVerifier, createTenantBearerVerifier } from "./auth/index.js";
import { type ServerConfig, toSafeServerConfig } from "./config.js";
import { createAesGcmCipher, type SecretCipher } from "./crypto/index.js";
import {
  createMemoryIdempotencyStore,
  createSemaphore,
  type IdempotencyStore,
  mapErrorToResponse,
} from "./middleware/index.js";
import { createLogger, createMetrics, type ServerMetrics } from "./observability/index.js";
import { type RouteDeps, registerAllRoutes, type WithUnitOfWork } from "./routes/index.js";
import type { ApiKeyStore } from "./tenants/api-key-store.js";
import type { CredentialVault } from "./tenants/credential-vault.js";
import type { TenantStore } from "./tenants/store.js";

/**
 * Constructor input for {@link buildApp}.
 *
 * The factory accepts already-built `registry` / `storage` / `auditLog`
 * — those are the bring-your-own seams. `cipher` / `idempotencyStore` /
 * `metrics` default to the bundled in-process implementations; pass
 * yours to override.
 */
export interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly registry: {
    readonly tenants: TenantStore;
    readonly vault: CredentialVault;
    readonly apiKeys: ApiKeyStore;
  };
  readonly storage: StorageAdapter;
  readonly auditLog: AuditLog;
  /**
   * Transactional unit-of-work primitive. When omitted, defaults to
   * a pass-through that runs the callback against the top-level
   * `registry` + `auditLog` with no isolation. Postgres deployments
   * SHOULD pass a real impl built around `withPgTransaction` so
   * mutation + audit-write share a transaction (CR-01).
   */
  readonly withUnitOfWork?: WithUnitOfWork;
  readonly cipher?: SecretCipher;
  readonly idempotencyStore?: IdempotencyStore;
  readonly metrics?: ServerMetrics;
  /**
   * Override the pino logger built from `config.logLevel`. Tests
   * commonly pass a silent or in-memory pino instance to keep the
   * vitest output clean (ME-23). Production callers leave it
   * undefined.
   */
  readonly logger?: Logger;
  /** Test-injection seams for the onboarding flow. */
  readonly onboardingHooks?: RouteDeps["onboardingHooks"];
}

/**
 * Build a Fastify instance with every route registered, ready to
 * `listen()` or `inject()`.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  // ME-23: accept a caller-supplied logger (tests + low-noise
  // environments). Falls back to the config-driven default.
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const cipher =
    options.cipher ??
    createAesGcmCipher({ keyring: config.masterKeys, activeKid: config.activeKid });
  const idempotencyStore = options.idempotencyStore ?? createMemoryIdempotencyStore();
  // ME-27: bound concurrent onboarding requests so a privileged
  // admin (or compromised key) cannot pin the DB pool and ZATCA
  // outbound connections by firing parallel onboards.
  const onboardingSemaphore = createSemaphore(config.onboardingMaxConcurrent);
  const metrics = options.metrics ?? createMetrics({ collectDefaults: config.metricsEnabled });

  const server = fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    // ME-15: operator-configurable via ZATCA_SERVER_TRUST_PROXY
    // (default false). Set true only when bound behind a proxy that
    // strips inbound X-Forwarded-* headers before forwarding.
    trustProxy: config.trustProxy,
    // ME-16: 30s default at the connection level — short enough that
    // a stuck/hung TCP probe doesn't pin FDs. The /onboard and
    // /credentials/rotate routes override via Fastify's per-route
    // `connectionTimeout` so the long ZATCA handshake still has the
    // documented 180s ceiling.
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
  });

  // Auth verifiers.
  const adminVerifier = createAdminKeyVerifier(config.adminKeysRaw);
  const tenantVerifier = createTenantBearerVerifier(options.registry.apiKeys);

  // Default unit-of-work: pass-through. Provides the SAME stores +
  // audit log to the callback as the top-level registry, so route
  // handlers can use the primitive uniformly. Backends with real
  // transactional support (Postgres' cli boot, future Mongo+replSet)
  // override this via `BuildAppOptions.withUnitOfWork`.
  const passThroughUnitOfWork: WithUnitOfWork = async (fn) =>
    fn({
      tenants: options.registry.tenants,
      vault: options.registry.vault,
      apiKeys: options.registry.apiKeys,
      auditLog: options.auditLog,
    });
  const withUnitOfWork = options.withUnitOfWork ?? passThroughUnitOfWork;

  // HI-09: strip the raw master-key material and the raw admin-key
  // string from the route-handler-facing config. The cipher +
  // verifier built above are the only paths downstream code needs.
  const safeConfig = toSafeServerConfig(config);

  const deps: RouteDeps = {
    config: safeConfig,
    registry: options.registry,
    storage: options.storage,
    auditLog: options.auditLog,
    withUnitOfWork,
    cipher,
    adminVerifier,
    tenantVerifier,
    idempotencyStore,
    onboardingSemaphore,
    metrics,
    ...(options.onboardingHooks !== undefined ? { onboardingHooks: options.onboardingHooks } : {}),
  };

  // Metrics: per-request counter + histogram.
  server.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? req.url;
    metrics.httpRequestsTotal.inc({
      method: req.method,
      route,
      status: String(reply.statusCode),
    });
    const elapsedSec = reply.elapsedTime / 1000;
    if (Number.isFinite(elapsedSec) && elapsedSec >= 0) {
      metrics.httpRequestDurationSeconds.observe({ method: req.method, route }, elapsedSec);
    }
  });

  // ME-13: periodic refresh of the registry-state gauges that don't
  // have a natural per-request hook. `activeTenants` counts
  // non-revoked rows; `productionCertExpirySeconds` sets a series
  // per tenant for "time-until-cert-expiry" alerting. Runs every
  // hour — slow enough to be cheap, fast enough to catch a
  // rotation within an SLO window. The interval is cleared via the
  // `closeHooks` registered on the Fastify instance so a clean
  // shutdown stops it.
  const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
  async function refreshRegistryGauges(): Promise<void> {
    try {
      const tenants = await options.registry.tenants.list({ includeDeleted: false });
      metrics.activeTenants.set(tenants.length);
      // WR2-05: reset before refresh — without this, the gauge's
      // series for soft-deleted / revoked tenants linger in
      // prom-client's registry at their last-set value forever.
      // Over months of tenant churn that's a slow cardinality
      // leak. `reset()` drops every label combination; the loop
      // below re-emits one per currently-active tenant.
      metrics.productionCertExpirySeconds.reset();
      const now = Date.now();
      for (const t of tenants) {
        const expiry = t.productionCertificateExpiresAt;
        if (expiry !== undefined) {
          metrics.productionCertExpirySeconds.set(
            { tenant: t.tenantRef },
            Math.floor((expiry.getTime() - now) / 1000),
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "registry gauge refresh failed");
    }
  }
  // Fire once at boot so /metrics doesn't show 0 for the first
  // hour after start, then on the interval.
  void refreshRegistryGauges();
  const refreshTimer = setInterval(() => {
    void refreshRegistryGauges();
  }, REFRESH_INTERVAL_MS);
  // Don't let the timer keep the event loop alive (the HTTP server
  // is what should hold it open).
  refreshTimer.unref();
  server.addHook("onClose", async () => {
    clearInterval(refreshTimer);
  });

  // Global error handler — turn any thrown value into a structured
  // response via the central error mapper.
  server.setErrorHandler((err, req, reply) => {
    const mapped = mapErrorToResponse(err);
    // WR2-03: log every mapped error with `err.cause` so the
    // operator-side diagnostic survives. ME-06's wrong-tenant-bearer
    // case sets `cause: { reason, presentedTenantRef,
    // expectedTenantRef }` so the operator can still tell wrong-
    // tenant from invalid-key even though the wire-side response
    // collapses them both to 401.
    const cause = (err as { cause?: unknown })?.cause;
    if (mapped.statusCode >= 500) {
      req.log.error({ err, cause }, "request errored");
    } else if (mapped.statusCode === 401 || mapped.statusCode === 403) {
      req.log.warn(
        {
          err,
          cause,
          name: (err as Error).name,
          msg: (err as Error).message,
        },
        "auth failure",
      );
    }
    for (const [k, v] of Object.entries(mapped.headers)) {
      reply.header(k, v);
    }
    return reply.code(mapped.statusCode).send(mapped.body);
  });

  // The `server` instance is bound to pino's `Logger` type via the
  // `loggerInstance` option, while `FastifyInstance` (the broader
  // type used by the route registrars) is parameterized on
  // `FastifyBaseLogger`. Both shapes are runtime-compatible; the
  // cast narrows to the broader API without changing behaviour.
  const generic = server as unknown as FastifyInstance;
  await registerAllRoutes(generic, deps);

  return generic;
}
