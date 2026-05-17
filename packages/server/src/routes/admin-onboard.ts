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
 * HI-11: open an idempotency slot for the request.
 *
 * Returns:
 * - `{ proceed: true, cacheKey, ttl }` when the caller is first (or
 *   no idemKey was presented). The caller MUST call `commit` on
 *   success OR `release` on error; skipping both wedges the slot
 *   until TTL.
 * - `{ proceed: false }` when the response has already been sent —
 *   either a replay of a prior committed response or a 409 because
 *   another caller is mid-flight under the same key. The caller
 *   stops processing and returns the reply.
 */
async function beginIdempotency(
  deps: RouteDeps,
  reply: FastifyReply,
  idemKey: string | undefined,
  tenantRef: string,
  route: string,
): Promise<{ proceed: true; cacheKey: string | undefined; ttl: number } | { proceed: false }> {
  const ttl =
    deps.config.idempotencyWindowMs > 0
      ? deps.config.idempotencyWindowMs
      : DEFAULT_IDEMPOTENCY_TTL_MS;
  if (idemKey === undefined) {
    return { proceed: true, cacheKey: undefined, ttl };
  }
  const cacheKey = buildIdempotencyCacheKey({ tenantRef, route, presentedKey: idemKey });
  const result = await deps.idempotencyStore.begin(cacheKey, ttl);
  if (result.kind === "replay") {
    for (const [k, v] of Object.entries(result.response.headers)) reply.header(k, v);
    reply.header("x-idempotent-replay", "true");
    await reply.code(result.response.statusCode).send(result.response.body);
    return { proceed: false };
  }
  if (result.kind === "in-flight") {
    await reply
      .code(409)
      .header("retry-after", "30")
      .send({
        error: {
          name: "IdempotencyConflict",
          message: "An idempotent request with this key is in flight; retry after a short delay.",
        },
      });
    return { proceed: false };
  }
  return { proceed: true, cacheKey, ttl };
}

async function commitIdempotency(
  deps: RouteDeps,
  cacheKey: string | undefined,
  ttl: number,
  response: CachedResponse,
): Promise<void> {
  if (cacheKey === undefined) return;
  await deps.idempotencyStore.commit(cacheKey, response, ttl);
}

async function releaseIdempotency(deps: RouteDeps, cacheKey: string | undefined): Promise<void> {
  if (cacheKey === undefined) return;
  await deps.idempotencyStore.release(cacheKey);
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

// ME-16: how long /onboard and /credentials/rotate may block.
// Computed once per registerAdminOnboardRoutes call so both routes
// share the same ceiling (the documented onboarding limit + a small
// safety margin). The server-level default is 30s — short enough to
// shed hung connections quickly — and these two routes extend
// per-request via `req.raw.setTimeout`.
function onboardingTimeoutMs(deps: RouteDeps): number {
  return Math.max(30_000, deps.config.onboardingTimeoutMs + 10_000);
}

/**
 * ME-27: try to claim a slot in the global onboarding semaphore.
 * Returns the release function on success, or sends a 503 +
 * `Retry-After: 30` and returns `null` when the cap is reached.
 * Callers MUST call the returned release inside a try/finally so a
 * thrown error doesn't leak the slot.
 */
async function acquireOnboardingSlot(
  deps: RouteDeps,
  reply: import("fastify").FastifyReply,
): Promise<(() => void) | null> {
  const release = deps.onboardingSemaphore.tryAcquire();
  if (release !== null) return release;
  await reply
    .code(503)
    .header("retry-after", "30")
    .send({
      error: {
        name: "OnboardingThrottled",
        message:
          `Server is at its onboarding concurrency cap (` +
          `${deps.onboardingSemaphore.capacity} in flight). Retry after a short delay.`,
      },
    });
  return null;
}

export function registerAdminOnboardRoutes(server: FastifyInstance, deps: RouteDeps): void {
  // POST /v1/tenants/:ref/onboard
  server.post<{ Params: { ref: string }; Body: unknown; Headers: { "idempotency-key"?: string } }>(
    "/v1/tenants/:ref/onboard",
    async (req, reply) => {
      // ME-16: extend the per-request socket timeout to the
      // onboarding ceiling. Every other route inherits the server's
      // 30s default.
      // Guard for fastify's `inject()` test path which can pass a
      // mock socket without `setTimeout`.
      if (typeof req.raw.setTimeout === "function") {
        req.raw.setTimeout(onboardingTimeoutMs(deps));
      }
      // ME-27: claim a global concurrency slot. Caps the number of
      // in-flight onboarding handshakes across the process.
      const releaseSlot = await acquireOnboardingSlot(deps, reply);
      if (releaseSlot === null) return reply;
      try {
        const actor = adminFor(req, deps);
        const body = parseBody(OnboardBody, req.body);
        // Idempotency (CR-03 + HI-11): the explicit state machine
        // (`begin` → `commit` | `release`) reserves the slot atomically
        // so a concurrent retry with the same key sees `in-flight` and
        // gets 409 — never executing the work twice. A retry after the
        // first call has `commit`ed replays the prior response.
        const route = "/v1/tenants/:ref/onboard";
        const idemKey = readIdempotencyKey(req);
        const idem = await beginIdempotency(deps, reply, idemKey, req.params.ref, route);
        if (!idem.proceed) return reply;
        try {
          const tenant = await deps.registry.tenants.get(req.params.ref);
          if (tenant === null) {
            throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`, {
              code: "not_found",
            });
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
            // Forward the transactional UoW so the success-path
            // batch (vault.put → setProductionExpiry → setState →
            // audit.write) commits atomically (CR-01 + HI-05).
            withUnitOfWork: deps.withUnitOfWork,
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
          await commitIdempotency(deps, idem.cacheKey, idem.ttl, {
            statusCode: 200,
            headers: {},
            body: JSON.stringify(responseBody),
          });
          return reply.send(responseBody);
        } catch (err) {
          await releaseIdempotency(deps, idem.cacheKey);
          throw err;
        }
      } finally {
        // ME-27: release the global onboarding slot regardless of
        // success/failure so a thrown error or a 4xx return doesn't
        // leak the slot.
        releaseSlot();
      }
    },
  );

  // POST /v1/tenants/:ref/credentials/rotate — same flow as /onboard,
  // but the route name makes the operator intent explicit and the
  // audit row carries a different action.
  server.post<{ Params: { ref: string }; Body: unknown; Headers: { "idempotency-key"?: string } }>(
    "/v1/tenants/:ref/credentials/rotate",
    async (req, reply) => {
      // ME-16: same per-request timeout extension as /onboard.
      // Guard for fastify's `inject()` test path which can pass a
      // mock socket without `setTimeout`.
      if (typeof req.raw.setTimeout === "function") {
        req.raw.setTimeout(onboardingTimeoutMs(deps));
      }
      // ME-27: same global onboarding slot.
      const releaseSlot = await acquireOnboardingSlot(deps, reply);
      if (releaseSlot === null) return reply;
      try {
        const actor = adminFor(req, deps);
        const body = parseBody(OnboardBody, req.body);
        // Idempotency (CR-03 + HI-11): rotation burns an OTP just like
        // onboarding, so a client TCP retry without protection would
        // burn a second OTP. Same state-machine guarantees as /onboard.
        const route = "/v1/tenants/:ref/credentials/rotate";
        const idemKey = readIdempotencyKey(req);
        const idem = await beginIdempotency(deps, reply, idemKey, req.params.ref, route);
        if (!idem.proceed) return reply;
        try {
          const tenant = await deps.registry.tenants.get(req.params.ref);
          if (tenant === null) {
            throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`, {
              code: "not_found",
            });
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
            // ME-09: rotation produces ONE audit row labelled
            // `tenant.credentialsRotated`. Previously, runOnboarding
            // hard-coded `tenant.onboarded` and the rotate route
            // appended a SECOND row — corrupting the compliance view
            // when filtered by action.
            auditAction: "tenant.credentialsRotated" as const,
            // Forward the transactional UoW so the success-path
            // batch (vault.put → setProductionExpiry → setState →
            // audit.write) commits atomically (CR-01 + HI-05).
            withUnitOfWork: deps.withUnitOfWork,
            ...(deps.onboardingHooks?.onboardFn !== undefined
              ? { onboardFn: deps.onboardingHooks.onboardFn }
              : {}),
            ...(deps.onboardingHooks?.getExpiry !== undefined
              ? { getExpiry: deps.onboardingHooks.getExpiry }
              : {}),
          };
          const result = await runOnboarding(runArgs);
          const responseBody = {
            tenantRef: result.tenantRef,
            state: result.state,
            productionCertificateExpiresAt: result.productionCertificateExpiresAt,
          };
          await commitIdempotency(deps, idem.cacheKey, idem.ttl, {
            statusCode: 200,
            headers: {},
            body: JSON.stringify(responseBody),
          });
          return reply.send(responseBody);
        } catch (err) {
          await releaseIdempotency(deps, idem.cacheKey);
          throw err;
        }
      } finally {
        // ME-27: release the global onboarding slot.
        releaseSlot();
      }
    },
  );

  // GET /v1/tenants/:ref/status
  server.get<{ Params: { ref: string } }>("/v1/tenants/:ref/status", async (req, reply) => {
    adminFor(req, deps);
    const record = await deps.registry.tenants.get(req.params.ref);
    if (record === null) {
      throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`, { code: "not_found" });
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
        throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`, { code: "not_found" });
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
      // setState + audit atomic (CR-01).
      const updated = await deps.withUnitOfWork(async (uow) => {
        const u = await uow.tenants.setState(req.params.ref, "failed", {
          lastError: force
            ? "Onboarding claim force-released by admin."
            : "Onboarding claim manually released by admin.",
        });
        await uow.auditLog.write({
          actor,
          tenantRef: req.params.ref,
          action: "tenant.unlocked",
          targetId: req.params.ref,
          result: "ok",
          payload: { force },
        });
        return u;
      });
      return reply.send({ tenantRef: updated.tenantRef, state: updated.state });
    },
  );
}

export const adminOnboardRoutesPlugin: FastifyPluginAsync<RouteDeps> = async (server, deps) => {
  registerAdminOnboardRoutes(server, deps);
};
