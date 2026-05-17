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
      const issued = await deps.registry.apiKeys.issue(req.params.ref, body.label);
      await deps.auditLog.write({
        actor,
        tenantRef: req.params.ref,
        action: "apiKey.issued",
        targetId: issued.tokenId,
        result: "ok",
        payload: { label: body.label },
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
      // Tenant-scoped revoke (CR-04): pass the URL's tenantRef so the
      // store can refuse to revoke a token that belongs to a different
      // tenant. A `false` return means no row matched — either the
      // token is unknown, already revoked, or scoped to another
      // tenant. We surface that as 404 so cross-tenant revoke
      // attempts cannot silently 204 against the wrong target.
      const revoked = await deps.registry.apiKeys.revoke(req.params.ref, req.params.tokenId);
      if (!revoked) {
        throw new ZatcaRegistryError(
          `Unknown api key '${req.params.tokenId}' for tenant '${req.params.ref}'.`,
        );
      }
      await deps.auditLog.write({
        actor,
        tenantRef: req.params.ref,
        action: "apiKey.revoked",
        targetId: req.params.tokenId,
        result: "ok",
      });
      return reply.code(204).send();
    },
  );
}

export const adminApiKeyRoutesPlugin: FastifyPluginAsync<RouteDeps> = async (server, deps) => {
  registerAdminApiKeyRoutes(server, deps);
};
