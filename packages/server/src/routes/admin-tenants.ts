/**
 * Admin routes for tenant lifecycle management.
 *
 *   POST   /v1/tenants                    — register tenant
 *   GET    /v1/tenants                    — list (filter via query)
 *   GET    /v1/tenants/:ref               — fetch single
 *   PATCH  /v1/tenants/:ref               — update mutable metadata
 *   DELETE /v1/tenants/:ref               — soft delete (revoke)
 *
 * All require admin bearer auth.
 */

import {
  asCommercialRegistrationNumber,
  asEGSUuid,
  asVATNumber,
  ZatcaValidationError,
} from "@dokhna-tech/zatca";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuditActor } from "../audit/log.js";
import { redactSecrets } from "../audit/redact.js";
import type {
  CreateTenantInput,
  PatchableTenantFields,
  TenantListFilter,
} from "../tenants/types.js";

import type { RouteDeps } from "./deps.js";

const LocationSchema = z.object({
  cityName: z.string().min(1),
  citySubdivision: z.string().min(1),
  street: z.string().min(1),
  plotIdentification: z.string().min(1),
  building: z.string().min(1),
  postalZone: z.string().min(1),
});

const CreateTenantBody = z.object({
  tenantRef: z.string().min(1).max(64).optional(),
  vatNumber: z.string().min(1),
  egsUuid: z.string().min(1),
  vatName: z.string().min(1),
  crn: z.string().min(1),
  branchName: z.string().min(1),
  branchIndustry: z.string().min(1).optional(),
  location: LocationSchema,
  environment: z.enum(["sandbox", "simulation", "production"]),
  label: z.string().optional(),
  callbackUrl: z.string().url().optional(),
});

const PatchTenantBody = z
  .object({
    vatName: z.string().min(1).optional(),
    branchName: z.string().min(1).optional(),
    branchIndustry: z.string().min(1).optional(),
    location: LocationSchema.optional(),
    label: z.string().optional(),
    callbackUrl: z.string().url().optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "patch body must contain at least one mutable field",
  );

const ListQuery = z.object({
  state: z
    .enum([
      "created",
      "onboarding",
      "compliance-tests-passed",
      "production-ready",
      "failed",
      "revoked",
    ])
    .optional(),
  environment: z.enum(["sandbox", "simulation", "production"]).optional(),
  expiringWithinDays: z.coerce.number().int().positive().optional(),
  includeDeleted: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => v === true || v === "true")
    .optional(),
});

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ZatcaValidationError(
      `Invalid request body: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Read the admin bearer from the request, throwing on missing /
 * malformed / unknown. Returns the matched admin label, used for
 * audit attribution.
 */
function adminFor(req: FastifyRequest, deps: RouteDeps): AuditActor {
  const match = deps.adminVerifier.verifyHeader(req.headers.authorization);
  return { type: "admin", label: match.label };
}

export function registerAdminTenantRoutes(server: FastifyInstance, deps: RouteDeps): void {
  server.post<{ Body: unknown }>("/v1/tenants", async (req, reply) => {
    const actor = adminFor(req, deps);
    const body = parseBody(CreateTenantBody, req.body);
    const input: CreateTenantInput = {
      ...(body.tenantRef !== undefined ? { tenantRef: body.tenantRef } : {}),
      vatNumber: asVATNumber(body.vatNumber),
      egsUuid: asEGSUuid(body.egsUuid),
      vatName: body.vatName,
      crn: asCommercialRegistrationNumber(body.crn),
      branchName: body.branchName,
      ...(body.branchIndustry !== undefined ? { branchIndustry: body.branchIndustry } : {}),
      location: body.location,
      environment: body.environment,
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.callbackUrl !== undefined ? { callbackUrl: body.callbackUrl } : {}),
    };
    const created = await deps.registry.tenants.create(input);
    await deps.auditLog.write({
      actor,
      tenantRef: created.tenantRef,
      action: "tenant.created",
      targetId: created.tenantRef,
      result: "ok",
      payload: redactSecrets({
        environment: created.environment,
        vatNumber: created.vatNumber,
        egsUuid: created.egsUuid,
      }),
    });
    return reply.code(201).send(created);
  });

  server.get<{ Querystring: unknown }>("/v1/tenants", async (req) => {
    adminFor(req, deps);
    const query = parseBody(ListQuery, req.query);
    const filter: TenantListFilter = {
      ...(query.state !== undefined ? { state: query.state } : {}),
      ...(query.environment !== undefined ? { environment: query.environment } : {}),
      ...(query.expiringWithinDays !== undefined
        ? { expiringWithinDays: query.expiringWithinDays }
        : {}),
      ...(query.includeDeleted !== undefined ? { includeDeleted: query.includeDeleted } : {}),
    };
    const tenants = await deps.registry.tenants.list(filter);
    return { tenants };
  });

  server.get<{ Params: { ref: string } }>("/v1/tenants/:ref", async (req, reply) => {
    adminFor(req, deps);
    const record = await deps.registry.tenants.get(req.params.ref);
    if (record === null) {
      return reply.code(404).send({
        error: { name: "ZatcaRegistryError", message: `Unknown tenant '${req.params.ref}'.` },
      });
    }
    return record;
  });

  server.patch<{ Params: { ref: string }; Body: unknown }>(
    "/v1/tenants/:ref",
    async (req, reply) => {
      const actor = adminFor(req, deps);
      const body = parseBody(PatchTenantBody, req.body);
      const patch: PatchableTenantFields = {
        ...(body.vatName !== undefined ? { vatName: body.vatName } : {}),
        ...(body.branchName !== undefined ? { branchName: body.branchName } : {}),
        ...(body.branchIndustry !== undefined ? { branchIndustry: body.branchIndustry } : {}),
        ...(body.location !== undefined ? { location: body.location } : {}),
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.callbackUrl !== undefined ? { callbackUrl: body.callbackUrl } : {}),
      };
      const updated = await deps.registry.tenants.patch(req.params.ref, patch);
      await deps.auditLog.write({
        actor,
        tenantRef: updated.tenantRef,
        action: "tenant.patched",
        targetId: updated.tenantRef,
        result: "ok",
        payload: redactSecrets(body as Readonly<Record<string, unknown>>),
      });
      return reply.send(updated);
    },
  );

  server.delete<{ Params: { ref: string } }>("/v1/tenants/:ref", async (req, reply) => {
    const actor = adminFor(req, deps);
    await deps.registry.tenants.softDelete(req.params.ref);
    await deps.registry.apiKeys.revokeAllForTenant(req.params.ref);
    await deps.auditLog.write({
      actor,
      tenantRef: req.params.ref,
      action: "tenant.softDeleted",
      targetId: req.params.ref,
      result: "ok",
    });
    return reply.code(204).send();
  });
}

/**
 * Fastify plugin wrapper.
 */
export const adminTenantRoutesPlugin: FastifyPluginAsync<RouteDeps> = async (server, deps) => {
  registerAdminTenantRoutes(server, deps);
};
