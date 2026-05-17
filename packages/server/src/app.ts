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

import type { AuditLog } from "./audit/index.js";
import { createAdminKeyVerifier, createTenantBearerVerifier } from "./auth/index.js";
import { type ServerConfig, toSafeServerConfig } from "./config.js";
import { createAesGcmCipher, type SecretCipher } from "./crypto/index.js";
import {
  createMemoryIdempotencyStore,
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
  /** Test-injection seams for the onboarding flow. */
  readonly onboardingHooks?: RouteDeps["onboardingHooks"];
}

/**
 * Build a Fastify instance with every route registered, ready to
 * `listen()` or `inject()`.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const logger = createLogger({ level: config.logLevel });
  const cipher =
    options.cipher ??
    createAesGcmCipher({ keyring: config.masterKeys, activeKid: config.activeKid });
  const idempotencyStore = options.idempotencyStore ?? createMemoryIdempotencyStore();
  const metrics = options.metrics ?? createMetrics({ collectDefaults: config.metricsEnabled });

  const server = fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    // ME-15: operator-configurable via ZATCA_SERVER_TRUST_PROXY
    // (default false). Set true only when bound behind a proxy that
    // strips inbound X-Forwarded-* headers before forwarding.
    trustProxy: config.trustProxy,
    // 180s read timeout — matches the documented onboarding ceiling
    // (the route can block this long without timing out).
    connectionTimeout: Math.max(30_000, config.onboardingTimeoutMs + 10_000),
    requestTimeout: Math.max(30_000, config.onboardingTimeoutMs + 10_000),
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

  // Global error handler — turn any thrown value into a structured
  // response via the central error mapper.
  server.setErrorHandler((err, _req, reply) => {
    const mapped = mapErrorToResponse(err);
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
