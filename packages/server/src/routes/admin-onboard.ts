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
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuditActor } from "../audit/log.js";
import { ZatcaRegistryError } from "../errors.js";
import { runOnboarding } from "../onboarding/run.js";

import type { RouteDeps } from "./deps.js";

const OnboardBody = z.object({
  otp: z.string().min(1).max(20),
  solutionName: z.string().min(1).max(120),
  environment: z.enum(["sandbox", "simulation"]).default("simulation"),
});

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
      return reply.send({
        tenantRef: result.tenantRef,
        state: result.state,
        complianceTestStatus: result.complianceTestStatus,
        productionCertificateExpiresAt: result.productionCertificateExpiresAt,
        productionRequestId: result.productionRequestId,
      });
    },
  );

  // POST /v1/tenants/:ref/credentials/rotate — same flow as /onboard,
  // but the route name makes the operator intent explicit and the
  // audit row carries a different action.
  server.post<{ Params: { ref: string }; Body: unknown }>(
    "/v1/tenants/:ref/credentials/rotate",
    async (req, reply) => {
      const actor = adminFor(req, deps);
      const body = parseBody(OnboardBody, req.body);
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
      return reply.send({
        tenantRef: result.tenantRef,
        state: result.state,
        productionCertificateExpiresAt: result.productionCertificateExpiresAt,
      });
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

  // POST /v1/tenants/:ref/unlock — release a stale claim. Only fires
  // when the existing claim has expired. The store's CAS in setState
  // honours expired claims automatically, but this route gives the
  // operator an explicit "force-unstuck" affordance.
  server.post<{ Params: { ref: string } }>("/v1/tenants/:ref/unlock", async (req, reply) => {
    const actor = adminFor(req, deps);
    const record = await deps.registry.tenants.get(req.params.ref);
    if (record === null) {
      throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`);
    }
    if (
      record.state !== "onboarding" ||
      record.claimExpiresAt === undefined ||
      record.claimExpiresAt > new Date()
    ) {
      throw new ZatcaValidationError(
        `Tenant '${req.params.ref}' is not in a stale-onboarding state — refusing to unlock.`,
      );
    }
    const updated = await deps.registry.tenants.setState(req.params.ref, "failed", {
      lastError: "Onboarding claim manually released by admin.",
    });
    await deps.auditLog.write({
      actor,
      tenantRef: req.params.ref,
      action: "tenant.unlocked",
      targetId: req.params.ref,
      result: "ok",
    });
    return reply.send({ tenantRef: updated.tenantRef, state: updated.state });
  });
}

export const adminOnboardRoutesPlugin: FastifyPluginAsync<RouteDeps> = async (server, deps) => {
  registerAdminOnboardRoutes(server, deps);
};
