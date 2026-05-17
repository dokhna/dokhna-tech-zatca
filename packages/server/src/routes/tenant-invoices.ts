/**
 * Tenant routes — issue invoices and query their lifecycle.
 *
 *   POST /v1/tenants/:ref/invoices                       — issue + (optionally) submit
 *   GET  /v1/tenants/:ref/invoices/:invoiceId            — load from storage
 *   POST /v1/tenants/:ref/invoices/:invoiceId/cancel     — wraps `cancelInvoice`
 *   GET  /v1/tenants/:ref/invoices/:invoiceId/status     — wraps `checkInvoiceStatus`
 *   POST /v1/tenants/:ref/invoices/:invoiceId/check-compliance
 *
 * All require tenant bearer auth; the path `:ref` MUST match the
 * bearer's tenant — mismatch is a 403 enforced by the verifier.
 *
 * `POST /invoices` is the central operation: it generates and signs
 * the UBL XML, persists via the configured storage adapter, and
 * (when `submit` is left at its default of `true`) forwards to ZATCA.
 * On a non-2xx ZATCA response the local record is marked `rejected`
 * and the ZATCA envelope surfaces in the response body.
 */

import {
  cancelInvoice,
  checkInvoiceCompliance,
  checkInvoiceStatus,
  type IssueInvoiceArgs,
  issueInvoice,
  type StorageAdapter,
  singleInvoiceReportingOrClearanceStatus,
  ZatcaApiError,
  ZatcaValidationError,
} from "@dokhna-tech/zatca";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuditActor } from "../audit/log.js";
import { redactSecrets } from "../audit/redact.js";
import { ZatcaRegistryError } from "../errors.js";
import {
  buildIdempotencyCacheKey,
  type CachedResponse,
  DEFAULT_IDEMPOTENCY_TTL_MS,
} from "../middleware/idempotency.js";
import type { SignerMaterial } from "../tenants/credential-vault.js";
import type { TenantRecord } from "../tenants/types.js";
import { toTenantScope } from "../tenants/types.js";

import type { RouteDeps } from "./deps.js";

/**
 * Pull the optional `Idempotency-Key` header from the request.
 * Returns `undefined` when absent or empty; throws on repeated or
 * oversize values so a malformed client cannot bypass replay
 * protection.
 */
function readIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = (req.headers as Record<string, string | string[] | undefined>)["idempotency-key"];
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
 * HI-11: open an idempotency slot. See admin-onboard.ts for the
 * detailed contract — same shape, duplicated here because the routes
 * live in different modules and lifting the helper into
 * middleware/idempotency.ts would introduce a circular dep on
 * RouteDeps.
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

const IssueBody = z.object({
  /** Discriminated `InvoiceInput`. Validated by core's runtime guards. */
  input: z.unknown(),
  /** Default true. Set to false for a local-only sign + persist (no ZATCA submit). */
  submit: z.boolean().default(true),
});

// ME-18: zatcaInvoiceId + clearanceNumber are first-class fields on
// the locally-persisted InvoiceRecord (the `invoiceId` field IS the
// ZATCA-side identifier; `clearanceNumber` is set when ZATCA accepts
// a standard invoice). Made both optional — the route falls back to
// the stored values when the caller omits them. Pre-fix, every
// client had to track these out-of-band; many would lose them and
// silently break cancels.
const CancelBody = z.object({
  /** Reason text; surfaces in the ZATCA cancel request. */
  reason: z.string().min(1).max(500),
  /**
   * Override for the stored `record.invoiceId`. Optional — supply
   * only when the local record's invoice id differs from the ZATCA-
   * registered one (rare, e.g. data migrations).
   */
  zatcaInvoiceId: z.string().min(1).optional(),
  /**
   * Override for the stored `record.clearanceNumber`. Optional —
   * see `zatcaInvoiceId` for the override-shape rationale. The
   * server falls back to the persisted clearance number when
   * absent.
   */
  clearanceNumber: z.string().min(1).optional(),
});

const StatusQuery = z.object({
  zatcaInvoiceId: z.string().min(1).optional(),
  clearanceNumber: z.string().min(1).optional(),
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

async function authTenant(
  req: FastifyRequest,
  deps: RouteDeps,
  expectedTenantRef: string,
): Promise<{ actor: AuditActor; tenant: TenantRecord; signing: SignerMaterial }> {
  const resolved = await deps.tenantVerifier.verify(req.headers.authorization, expectedTenantRef);
  const tenant = await deps.registry.tenants.get(expectedTenantRef);
  if (tenant === null) {
    throw new ZatcaRegistryError(`Unknown tenant '${expectedTenantRef}'.`, {
      code: "not_found",
    });
  }
  if (tenant.state !== "production-ready") {
    throw new ZatcaValidationError(
      `Tenant '${expectedTenantRef}' is not production-ready (current state: '${tenant.state}').`,
    );
  }
  const signing = await deps.registry.vault.get(expectedTenantRef);
  if (signing === null) {
    throw new ZatcaValidationError(
      `Tenant '${expectedTenantRef}' has no signing material persisted; re-run onboarding.`,
    );
  }
  return {
    actor: { type: "tenant", tenantRef: resolved.tenantRef, tokenId: resolved.tokenId },
    tenant,
    signing,
  };
}

export function registerTenantInvoiceRoutes(server: FastifyInstance, deps: RouteDeps): void {
  // POST /v1/tenants/:ref/invoices
  server.post<{
    Params: { ref: string };
    Body: unknown;
    Headers: { "idempotency-key"?: string };
  }>("/v1/tenants/:ref/invoices", async (req, reply) => {
    const { actor, tenant, signing } = await authTenant(req, deps, req.params.ref);
    const body = parseBody(IssueBody, req.body);
    // Idempotency (CR-03 + HI-11): an invoice POST submits to ZATCA.
    // A TCP retry without protection would either re-submit the same
    // invoice (rejected on the ZATCA side as duplicate) or — worse —
    // issue a fresh invoice number under a duplicate logical request.
    // The explicit `begin → commit | release` state machine prevents
    // concurrent dupes; a retry after `commit` replays the response.
    const route = "/v1/tenants/:ref/invoices";
    const idemKey = readIdempotencyKey(req);
    const idem = await beginIdempotency(deps, reply, idemKey, req.params.ref, route);
    if (!idem.proceed) return reply;
    try {
      // ME-07: `buildEgsInfo` was previously called and discarded —
      // wasted CPU and a needless local holding the decrypted private
      // key (foot-gun for any future debug-log change). `issueInvoice`
      // doesn't need it; deleted.
      const scope = toTenantScope(tenant);

      // ME-08: if the caller asked to submit but the invoice kind is
      // Phase 1 (no XML to clear), reject loudly rather than silently
      // skipping. Pre-fix the route accepted `{submit: true, input:
      // {kind: "simplified-invoice"}}` and returned a 200 with
      // `status: "pending"` — the audit row recorded
      // `submitted: true` even though no ZATCA call was made.
      const inputKind = (body.input as { kind?: string }).kind ?? "";
      const isPhase1Kind = /^simplified-invoice$|^standard-invoice$/.test(inputKind);
      if (body.submit && isPhase1Kind) {
        throw new ZatcaValidationError(
          `submit=true is incompatible with Phase 1 invoice kind '${inputKind}'. ` +
            `Phase 1 invoices have no signed XML to clear/report; pass submit=false ` +
            `or use a Phase 2 kind (e.g. 'simplified-tax-invoice').`,
        );
      }

      // Issue locally — signs the UBL XML, persists via the storage
      // adapter with status="pending".
      const issueArgs: IssueInvoiceArgs = {
        input: body.input as IssueInvoiceArgs["input"],
        storage: deps.storage as StorageAdapter,
        scope,
        signing: {
          certificate: signing.productionCertificate,
          privateKey: signing.privateKey,
        },
      };
      // The dispatch helper handles both Phase 1 and Phase 2 kinds —
      // its return shape differs (`IssuedInvoice | IssuedPhase1Invoice`).
      // We narrow on the presence of `signedXml`.
      const issued = await issueInvoice(issueArgs);
      const isPhase2 = "signedXml" in issued;

      let zatcaResponse: unknown = null;
      let zatcaRequestId: string | undefined;
      let status: "accepted" | "rejected" | "pending" = "pending";

      if (body.submit && isPhase2) {
        const phase2 = issued as { signedXml: string; invoiceHash: string };
        try {
          const result = await singleInvoiceReportingOrClearanceStatus({
            signedInvoiceXml: phase2.signedXml,
            invoiceHash: phase2.invoiceHash,
            egsUuid: tenant.egsUuid,
            binarySecurityToken: signing.productionBinarySecurityToken,
            apiSecret: signing.productionApiSecret,
            environment: tenant.environment,
          });
          zatcaResponse = result;
          status = "accepted";
        } catch (err) {
          if (err instanceof ZatcaApiError) {
            zatcaResponse = err.validationResults;
            zatcaRequestId = err.requestId;
            status = "rejected";
          } else {
            throw err;
          }
        }
        // Persist the lifecycle transition.
        const invoiceId =
          (issued as { invoiceId?: string; invoiceNumber: string }).invoiceId ??
          issued.invoiceNumber;
        await deps.storage.updateInvoiceStatus(scope, invoiceId, status);
      }

      if (deps.metrics !== undefined) {
        const kind = (body.input as { kind?: string }).kind ?? "unknown";
        // ME-14: dropped the `tenant` label — series count was
        // O(tenants × kinds × statuses).
        deps.metrics.invoicesIssuedTotal.inc({ kind, status });
      }

      await deps.auditLog.write({
        actor,
        tenantRef: tenant.tenantRef,
        action: "invoice.issued",
        targetId: issued.invoiceNumber,
        result: status === "rejected" ? "error" : "ok",
        ...(zatcaRequestId !== undefined ? { zatcaRequestId } : {}),
        payload: redactSecrets({
          kind: (body.input as { kind?: string }).kind,
          submitted: body.submit,
          status,
        }),
      });

      const responseHeaders: Record<string, string> = {};
      if (zatcaRequestId !== undefined) {
        reply.header("X-Zatca-Request-Id", zatcaRequestId);
        responseHeaders["X-Zatca-Request-Id"] = zatcaRequestId;
      }
      const responseBody = {
        invoiceNumber: issued.invoiceNumber,
        sequence: issued.sequence,
        invoiceHash: "invoiceHash" in issued ? issued.invoiceHash : undefined,
        signedXml: "signedXml" in issued ? issued.signedXml : undefined,
        qrCode: "qrCode" in issued ? issued.qrCode : undefined,
        status,
        zatcaResponse,
      };
      await commitIdempotency(deps, idem.cacheKey, idem.ttl, {
        statusCode: 200,
        headers: responseHeaders,
        body: JSON.stringify(responseBody),
      });
      return reply.send(responseBody);
    } catch (err) {
      await releaseIdempotency(deps, idem.cacheKey);
      throw err;
    }
  });

  // GET /v1/tenants/:ref/invoices/:invoiceId
  server.get<{ Params: { ref: string; invoiceId: string } }>(
    "/v1/tenants/:ref/invoices/:invoiceId",
    async (req, reply) => {
      const { tenant } = await authTenant(req, deps, req.params.ref);
      const scope = toTenantScope(tenant);
      const record = await deps.storage.loadInvoice(scope, req.params.invoiceId);
      if (record === null) {
        throw new ZatcaRegistryError(`Unknown invoice '${req.params.invoiceId}'.`, {
          code: "not_found",
        });
      }
      return reply.send(record);
    },
  );

  // POST /v1/tenants/:ref/invoices/:invoiceId/cancel
  server.post<{ Params: { ref: string; invoiceId: string }; Body: unknown }>(
    "/v1/tenants/:ref/invoices/:invoiceId/cancel",
    async (req, reply) => {
      const { actor, tenant, signing } = await authTenant(req, deps, req.params.ref);
      const body = parseBody(CancelBody, req.body);
      const scope = toTenantScope(tenant);
      const record = await deps.storage.loadInvoice(scope, req.params.invoiceId);
      if (record === null) {
        throw new ZatcaRegistryError(`Unknown invoice '${req.params.invoiceId}'.`, {
          code: "not_found",
        });
      }
      // ME-18: fall back to the locally-persisted ZATCA identifiers
      // when the caller didn't supply overrides. The server already
      // has them — forcing the client to re-track them was
      // UX-hostile and a subtle spoofing surface.
      const zatcaInvoiceId = body.zatcaInvoiceId ?? record.invoiceId;
      const clearanceNumber = body.clearanceNumber ?? record.clearanceNumber;
      if (clearanceNumber === undefined) {
        throw new ZatcaValidationError(
          `Invoice '${req.params.invoiceId}' has no clearanceNumber on the local record. ` +
            `Provide one in the request body, or cancel a standard invoice that has been ` +
            `cleared by ZATCA.`,
        );
      }
      let result: unknown;
      let zatcaRequestId: string | undefined;
      let cancelStatus: "ok" | "error" = "ok";
      try {
        result = await cancelInvoice({
          invoiceId: zatcaInvoiceId,
          clearanceNumber,
          reason: body.reason,
          binarySecurityToken: signing.productionBinarySecurityToken,
          apiSecret: signing.productionApiSecret,
          environment: tenant.environment,
        });
        await deps.storage.updateInvoiceStatus(scope, req.params.invoiceId, "cancelled");
      } catch (err) {
        cancelStatus = "error";
        if (err instanceof ZatcaApiError) {
          zatcaRequestId = err.requestId;
        }
        throw err;
      } finally {
        if (deps.metrics !== undefined) {
          // ME-14: dropped the `tenant` label.
          deps.metrics.invoicesCancelledTotal.inc({ result: cancelStatus });
        }
        await deps.auditLog.write({
          actor,
          tenantRef: tenant.tenantRef,
          action: "invoice.cancelled",
          targetId: req.params.invoiceId,
          result: cancelStatus,
          ...(zatcaRequestId !== undefined ? { zatcaRequestId } : {}),
          payload: redactSecrets({ reason: body.reason }),
        });
      }
      return reply.send({ status: "cancelled", zatcaResponse: result });
    },
  );

  // GET /v1/tenants/:ref/invoices/:invoiceId/status
  // Query string: zatcaInvoiceId, clearanceNumber.
  server.get<{ Params: { ref: string; invoiceId: string }; Querystring: unknown }>(
    "/v1/tenants/:ref/invoices/:invoiceId/status",
    async (req, reply) => {
      const { tenant, signing } = await authTenant(req, deps, req.params.ref);
      const scope = toTenantScope(tenant);
      const record = await deps.storage.loadInvoice(scope, req.params.invoiceId);
      if (record === null) {
        throw new ZatcaRegistryError(`Unknown invoice '${req.params.invoiceId}'.`, {
          code: "not_found",
        });
      }
      const query = parseBody(StatusQuery, req.query);
      // ME-18: fall back to the locally-persisted identifiers.
      const zatcaInvoiceId = query.zatcaInvoiceId ?? record.invoiceId;
      const clearanceNumber = query.clearanceNumber ?? record.clearanceNumber;
      if (clearanceNumber === undefined) {
        throw new ZatcaValidationError(
          `Invoice '${req.params.invoiceId}' has no clearanceNumber on the local record. ` +
            `Provide one as a query parameter, or check the status of an invoice that has ` +
            `been cleared by ZATCA.`,
        );
      }
      const result = await checkInvoiceStatus({
        invoiceId: zatcaInvoiceId,
        clearanceNumber,
        binarySecurityToken: signing.productionBinarySecurityToken,
        apiSecret: signing.productionApiSecret,
        environment: tenant.environment,
      });
      return reply.send({ localStatus: record.status, zatcaResponse: result });
    },
  );

  // POST /v1/tenants/:ref/invoices/:invoiceId/check-compliance
  server.post<{ Params: { ref: string; invoiceId: string } }>(
    "/v1/tenants/:ref/invoices/:invoiceId/check-compliance",
    async (req, reply) => {
      const { tenant, signing } = await authTenant(req, deps, req.params.ref);
      const scope = toTenantScope(tenant);
      const record = await deps.storage.loadInvoice(scope, req.params.invoiceId);
      if (record === null) {
        throw new ZatcaRegistryError(`Unknown invoice '${req.params.invoiceId}'.`, {
          code: "not_found",
        });
      }
      const result = await checkInvoiceCompliance({
        signedInvoiceXml: record.signedXml,
        invoiceHash: record.invoiceHash,
        egsUuid: tenant.egsUuid,
        binarySecurityToken: signing.productionBinarySecurityToken,
        apiSecret: signing.productionApiSecret,
        environment: tenant.environment,
      });
      return reply.send(result);
    },
  );
}

export const tenantInvoiceRoutesPlugin: FastifyPluginAsync<RouteDeps> = async (server, deps) => {
  registerTenantInvoiceRoutes(server, deps);
};
