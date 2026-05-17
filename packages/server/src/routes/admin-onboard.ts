/**
 * Admin routes for the onboarding lifecycle.
 *
 *   POST /v1/tenants/:ref/onboard                — run the full handshake
 *   POST /v1/tenants/:ref/credentials/rotate     — re-onboard with a fresh OTP
 *   GET  /v1/tenants/:ref/status                 — onboarding state + per-scenario progress
 *   POST /v1/tenants/:ref/unlock                 — release a stale onboarding claim
 *
 * `POST /onboard` and `/credentials/rotate` are synchronous and may
 * block for up to ~3 minutes (the documented onboarding ceiling).
 * The HTTP read-timeout MUST be at least `config.onboardingTimeoutMs`.
 */

import { ZatcaValidationError } from "@dokhna-tech/zatca";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuditActor } from "../audit/log.js";
import { ZatcaRegistryError } from "../errors.js";
import {
  buildIdempotencyCacheKey,
  type CachedResponse,
  DEFAULT_IDEMPOTENCY_TTL_MS,
} from "../middleware/idempotency.js";
import { runOnboarding } from "../onboarding/run.js";

import type { RouteDeps } from "./deps.js";

/**
 * Pull an `Idempotency-Key` header value from a request. The header
 * is optional — return `undefined` when absent or empty. A non-string
 * value (Fastify normalises to string but `string[]` is possible for
 * repeated headers) is rejected as a validation error so a malformed
 * client cannot accidentally bypass replay protection.
 */
function readIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    throw new ZatcaValidationError("Idempotency-Key header must not be repeated.");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 200) {
    throw new ZatcaValidationError("Idempotency-Key header is too long (max 200 chars).");
  }
  return trimmed;
}

/**
 * Replay a cached idempotent response, if one exists. Returns `true`
 * when a cached response was sent (caller should stop processing),
 * `false` otherwise. The cache key is namespaced by tenantRef + route
 * + a sha256 of the presented header, so a key replayed against a
 * different tenant or different route does NOT hit the cache.
 */
async function tryReplayIdempotent(
  deps: RouteDeps,
  reply: FastifyReply,
  key: string,
  tenantRef: string,
  route: string,
): Promise<boolean> {
  const cacheKey = buildIdempotencyCacheKey({ tenantRef, route, presentedKey: key });
  const cached = await deps.idempotencyStore.get(cacheKey);
  if (cached === null) return false;
  for (const [k, v] of Object.entries(cached.headers)) reply.header(k, v);
  reply.header("x-idempotent-replay", "true");
  await reply.code(cached.statusCode).send(cached.body);
  return true;
}

/**
 * Persist an idempotent response for replay. The TTL is configurable
 * via `config.idempotencyWindowMs` (default 24h) and falls back to
 * `DEFAULT_IDEMPOTENCY_TTL_MS` if the config is somehow zero.
 */
async function storeIdempotent(
  deps: RouteDeps,
  key: string,
  tenantRef: string,
  route: string,
  response: CachedResponse,
): Promise<void> {
  const cacheKey = buildIdempotencyCacheKey({ tenantRef, route, presentedKey: key });
  const ttl =
    deps.config.idempotencyWindowMs > 0
      ? deps.config.idempotencyWindowMs
      : DEFAULT_IDEMPOTENCY_TTL_MS;
  await deps.idempotencyStore.set(cacheKey, response, ttl);
}

const OnboardBody = z.object({
  otp: z.string().min(1).max(20),
  solutionName: z.string().min(1).max(120),
  environment: z.enum(["sandbox", "simulation"]).default("simulation"),
});

/**
 * Body for POST /unlock. `force=true` lets the operator release a
 * tenant that's wedged in state=`onboarding` with NULL or future
 * `claimExpiresAt` (CR-02 + HI-06). The route audits the force flag
 * so the audit trail captures explicit operator intervention.
 */
const UnlockBody = z
  .object({
    force: z.boolean().optional(),
  })
  .optional();

function adminFor(req: FastifyRequest, deps: RouteDeps): AuditActor {
  const match = deps.adminVerifier.verifyHeader(req.headers.authorization);
  return { type: "admin", label: match.label };
}

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ZatcaValidationError(
      `Invalid request body: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export function registerAdminOnboardRoutes(server: FastifyInstance, deps: RouteDeps): void {
  // POST /v1/tenants/:ref/onboard
  server.post<{ Params: { ref: string }; Body: unknown; Headers: { "idempotency-key"?: string } }>(
    "/v1/tenants/:ref/onboard",
    async (req, reply) => {
      const actor = adminFor(req, deps);
      const body = parseBody(OnboardBody, req.body);
      // Idempotency (CR-03): if the caller presents an
      // `Idempotency-Key` header and we've seen the same key within
      // the configured window, replay the cached response rather than
      // burn a fresh OTP. The header is optional — its absence
      // bypasses the cache entirely.
      const route = "/v1/tenants/:ref/onboard";
      const idemKey = readIdempotencyKey(req);
      if (idemKey !== undefined) {
        const replayed = await tryReplayIdempotent(deps, reply, idemKey, req.params.ref, route);
        if (replayed) return reply;
      }
      const tenant = await deps.registry.tenants.get(req.params.ref);
      if (tenant === null) {
        throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`);
      }

      const runArgs = {
        tenantRef: req.params.ref,
        otp: body.otp,
        solutionName: body.solutionName,
        environment: body.environment,
        instanceId: deps.config.instanceId,
        registry: { tenants: deps.registry.tenants, vault: deps.registry.vault },
        auditLog: deps.auditLog,
        actor,
        lockTtlMs: deps.config.onboardingTimeoutMs,
        ...(deps.onboardingHooks?.onboardFn !== undefined
          ? { onboardFn: deps.onboardingHooks.onboardFn }
          : {}),
        ...(deps.onboardingHooks?.getExpiry !== undefined
          ? { getExpiry: deps.onboardingHooks.getExpiry }
          : {}),
      };
      const result = await runOnboarding(runArgs);
      if (deps.metrics !== undefined) {
        deps.metrics.onboardingTotal.inc({ outcome: "succeeded" });
      }
      const responseBody = {
        tenantRef: result.tenantRef,
        state: result.state,
        complianceTestStatus: result.complianceTestStatus,
        productionCertificateExpiresAt: result.productionCertificateExpiresAt,
        productionRequestId: result.productionRequestId,
      };
      if (idemKey !== undefined) {
        await storeIdempotent(deps, idemKey, req.params.ref, route, {
          statusCode: 200,
          headers: {},
          body: JSON.stringify(responseBody),
        });
      }
      return reply.send(responseBody);
    },
  );

  // POST /v1/tenants/:ref/credentials/rotate — same flow as /onboard,
  // but the route name makes the operator intent explicit and the
  // audit row carries a different action.
  server.post<{ Params: { ref: string }; Body: unknown; Headers: { "idempotency-key"?: string } }>(
    "/v1/tenants/:ref/credentials/rotate",
    async (req, reply) => {
      const actor = adminFor(req, deps);
      const body = parseBody(OnboardBody, req.body);
      // Idempotency (CR-03): rotation burns an OTP just like
      // onboarding, so a client TCP retry without idempotency
      // protection would burn a second OTP. The header is optional.
      const route = "/v1/tenants/:ref/credentials/rotate";
      const idemKey = readIdempotencyKey(req);
      if (idemKey !== undefined) {
        const replayed = await tryReplayIdempotent(deps, reply, idemKey, req.params.ref, route);
        if (replayed) return reply;
      }
      const tenant = await deps.registry.tenants.get(req.params.ref);
      if (tenant === null) {
        throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`);
      }
      const runArgs = {
        tenantRef: req.params.ref,
        otp: body.otp,
        solutionName: body.solutionName,
        environment: body.environment,
        instanceId: deps.config.instanceId,
        registry: { tenants: deps.registry.tenants, vault: deps.registry.vault },
        auditLog: deps.auditLog,
        actor,
        lockTtlMs: deps.config.onboardingTimeoutMs,
        ...(deps.onboardingHooks?.onboardFn !== undefined
          ? { onboardFn: deps.onboardingHooks.onboardFn }
          : {}),
        ...(deps.onboardingHooks?.getExpiry !== undefined
          ? { getExpiry: deps.onboardingHooks.getExpiry }
          : {}),
      };
      const result = await runOnboarding(runArgs);
      await deps.auditLog.write({
        actor,
        tenantRef: req.params.ref,
        action: "tenant.credentialsRotated",
        targetId: req.params.ref,
        result: "ok",
      });
      const responseBody = {
        tenantRef: result.tenantRef,
        state: result.state,
        productionCertificateExpiresAt: result.productionCertificateExpiresAt,
      };
      if (idemKey !== undefined) {
        await storeIdempotent(deps, idemKey, req.params.ref, route, {
          statusCode: 200,
          headers: {},
          body: JSON.stringify(responseBody),
        });
      }
      return reply.send(responseBody);
    },
  );

  // GET /v1/tenants/:ref/status
  server.get<{ Params: { ref: string } }>("/v1/tenants/:ref/status", async (req, reply) => {
    adminFor(req, deps);
    const record = await deps.registry.tenants.get(req.params.ref);
    if (record === null) {
      throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`);
    }
    return reply.send({
      tenantRef: record.tenantRef,
      state: record.state,
      onboardingProgress: record.onboardingProgress,
      claimedBy: record.claimedBy,
      claimExpiresAt: record.claimExpiresAt,
      productionCertificateExpiresAt: record.productionCertificateExpiresAt,
    });
  });

  // POST /v1/tenants/:ref/unlock — release a stale onboarding claim.
  //
  // Default behaviour (no body / `{force:false}`): refuse unless the
  // tenant is in state=`onboarding` AND the claim is no longer
  // recoverable by the regular CAS — that means either an expired
  // claim (`claimExpiresAt <= now`) OR a NULL/missing claim (the
  // CR-02 wedged state). The original code required claimExpiresAt
  // to be defined AND in the past, which left the NULL-expiry case
  // un-recoverable via the API (HI-06).
  //
  // Force behaviour (`{force:true}`): release the claim even if the
  // expiry is still in the future. Intended for the rare case where
  // an admin knows the holder has died (host OOM, network partition)
  // and waiting out the TTL is too expensive. The audit row records
  // `force=true` so the operator's explicit intervention is logged.
  server.post<{ Params: { ref: string }; Body: unknown }>(
    "/v1/tenants/:ref/unlock",
    async (req, reply) => {
      const actor = adminFor(req, deps);
      // Body is optional — POSTs without a body are accepted as
      // `{force:false}` to keep the original API contract.
      const parsed = UnlockBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ZatcaValidationError(
          `Invalid request body: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        );
      }
      const force = parsed.data?.force === true;
      const record = await deps.registry.tenants.get(req.params.ref);
      if (record === null) {
        throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`);
      }
      if (record.state !== "onboarding") {
        throw new ZatcaValidationError(
          `Tenant '${req.params.ref}' is not in a stale-onboarding state — refusing to unlock.`,
        );
      }
      // Recoverable-without-force = expired claim OR null/missing
      // claim. Force overrides both checks.
      const claimExpiresAt = record.claimExpiresAt;
      const recoverable = claimExpiresAt === undefined || claimExpiresAt <= new Date();
      if (!recoverable && !force) {
        throw new ZatcaValidationError(
          `Tenant '${req.params.ref}' has an active onboarding claim that expires ${claimExpiresAt.toISOString()} — pass {"force":true} to release early.`,
        );
      }
      const updated = await deps.registry.tenants.setState(req.params.ref, "failed", {
        lastError: force
          ? "Onboarding claim force-released by admin."
          : "Onboarding claim manually released by admin.",
      });
      await deps.auditLog.write({
        actor,
        tenantRef: req.params.ref,
        action: "tenant.unlocked",
        targetId: req.params.ref,
        result: "ok",
        payload: { force },
      });
      return reply.send({ tenantRef: updated.tenantRef, state: updated.state });
    },
  );
}

export const adminOnboardRoutesPlugin: FastifyPluginAsync<RouteDeps> = async (server, deps) => {
  registerAdminOnboardRoutes(server, deps);
};
