/**
 * Admin routes for tenant bearer-token (API-key) management.
 *
 *   POST   /v1/tenants/:ref/api-keys           — issue a new bearer
 *   GET    /v1/tenants/:ref/api-keys           — list (metadata only, no plaintext)
 *   DELETE /v1/tenants/:ref/api-keys/:tokenId  — revoke
 *
 * All require admin bearer auth. The freshly issued plaintext token
 * is returned ONCE in the response body — operators store it
 * themselves; the server never re-emits it.
 */

import { ZatcaValidationError } from "@dokhna-tech/zatca";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuditActor } from "../audit/log.js";
import { ZatcaRegistryError } from "../errors.js";

import type { RouteDeps } from "./deps.js";

const IssueBody = z.object({
  label: z.string().min(1).max(64),
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

export function registerAdminApiKeyRoutes(server: FastifyInstance, deps: RouteDeps): void {
  server.post<{ Params: { ref: string }; Body: unknown }>(
    "/v1/tenants/:ref/api-keys",
    async (req, reply) => {
      const actor = adminFor(req, deps);
      const body = parseBody(IssueBody, req.body);
      // Refuse to mint a key for a tenant that doesn't exist (or has
      // been soft-deleted). Returns 404 via the error mapper.
      const tenant = await deps.registry.tenants.get(req.params.ref);
      if (tenant === null) {
        throw new ZatcaRegistryError(`Unknown tenant '${req.params.ref}'.`);
      }
      // issue + audit atomic (CR-01).
      const issued = await deps.withUnitOfWork(async (uow) => {
        const i = await uow.apiKeys.issue(req.params.ref, body.label);
        await uow.auditLog.write({
          actor,
          tenantRef: req.params.ref,
          action: "apiKey.issued",
          targetId: i.tokenId,
          result: "ok",
          payload: { label: body.label },
        });
        return i;
      });
      return reply.code(201).send({
        token: issued.token,
        tokenId: issued.tokenId,
        warning: "This token is shown only once. Store it securely.",
      });
    },
  );

  server.get<{ Params: { ref: string } }>("/v1/tenants/:ref/api-keys", async (req) => {
    adminFor(req, deps);
    const keys = await deps.registry.apiKeys.list(req.params.ref);
    return { keys };
  });

  server.delete<{ Params: { ref: string; tokenId: string } }>(
    "/v1/tenants/:ref/api-keys/:tokenId",
    async (req, reply) => {
      const actor = adminFor(req, deps);
      // Tenant-scoped revoke (CR-04) + atomic audit (CR-01). The
      // store's tenant-scoped revoke returns false for a mismatch;
      // we throw before the audit write so a cross-tenant attempt
      // gets a 404 with no audit row recording the wrong target.
      // When the revoke succeeds, the audit write is in the same
      // transaction so they commit/rollback together.
      await deps.withUnitOfWork(async (uow) => {
        const revoked = await uow.apiKeys.revoke(req.params.ref, req.params.tokenId);
        if (!revoked) {
          throw new ZatcaRegistryError(
            `Unknown api key '${req.params.tokenId}' for tenant '${req.params.ref}'.`,
          );
        }
        await uow.auditLog.write({
          actor,
          tenantRef: req.params.ref,
          action: "apiKey.revoked",
          targetId: req.params.tokenId,
          result: "ok",
        });
      });
      return reply.code(204).send();
    },
  );
}

export const adminApiKeyRoutesPlugin: FastifyPluginAsync<RouteDeps> = async (server, deps) => {
  registerAdminApiKeyRoutes(server, deps);
};
