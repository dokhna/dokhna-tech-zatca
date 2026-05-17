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
  type EGSUnitInfo,
  type IssueInvoiceArgs,
  issueInvoice,
  type StorageAdapter,
  singleInvoiceReportingOrClearanceStatus,
  ZatcaApiError,
  ZatcaValidationError,
} from "@dokhna-tech/zatca";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuditActor } from "../audit/log.js";
import { redactSecrets } from "../audit/redact.js";
import { ZatcaRegistryError } from "../errors.js";
import type { SignerMaterial } from "../tenants/credential-vault.js";
import type { TenantRecord } from "../tenants/types.js";
import { toTenantScope } from "../tenants/types.js";

import type { RouteDeps } from "./deps.js";

const IssueBody = z.object({
  /** Discriminated `InvoiceInput`. Validated by core's runtime guards. */
  input: z.unknown(),
  /** Default true. Set to false for a local-only sign + persist (no ZATCA submit). */
  submit: z.boolean().default(true),
});

const CancelBody = z.object({
  /** Reason text; surfaces in the ZATCA cancel request. */
  reason: z.string().min(1).max(500),
  /**
   * ZATCA-issued invoice identifier returned at clearance time.
   * Caller-side state — the server's local InvoiceRecord doesn't
   * persist it separately (it lives inside `validationResults`).
   */
  zatcaInvoiceId: z.string().min(1),
  /** ZATCA-issued clearance number. */
  clearanceNumber: z.string().min(1),
});

const StatusQuery = z.object({
  zatcaInvoiceId: z.string().min(1),
  clearanceNumber: z.string().min(1),
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
    throw new ZatcaRegistryError(`Unknown tenant '${expectedTenantRef}'.`);
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

function buildEgsInfo(tenant: TenantRecord, signing: SignerMaterial): EGSUnitInfo {
  return {
    uuid: tenant.egsUuid,
    customId: `${tenant.tenantRef}-pos-01`,
    model: "ZATCA Standalone Server",
    crnNumber: tenant.crn,
    vatName: tenant.vatName,
    vatNumber: tenant.vatNumber,
    branchName: tenant.branchName,
    branchIndustry: tenant.branchIndustry ?? "Retail",
    location: tenant.location,
    certificate: {
      privateKey: signing.privateKey,
      productionCertificate: signing.productionCertificate,
      productionBinarySecurityToken: signing.productionBinarySecurityToken,
      productionApiSecret: signing.productionApiSecret,
      ...(signing.complianceCertificate !== undefined
        ? { complianceCertificate: signing.complianceCertificate }
        : {}),
      ...(signing.complianceBinarySecurityToken !== undefined
        ? { complianceBinarySecurityToken: signing.complianceBinarySecurityToken }
        : {}),
      ...(signing.complianceApiSecret !== undefined
        ? { complianceApiSecret: signing.complianceApiSecret }
        : {}),
    },
  } as EGSUnitInfo;
}

export function registerTenantInvoiceRoutes(server: FastifyInstance, deps: RouteDeps): void {
  // POST /v1/tenants/:ref/invoices
  server.post<{ Params: { ref: string }; Body: unknown }>(
    "/v1/tenants/:ref/invoices",
    async (req, reply) => {
      const { actor, tenant, signing } = await authTenant(req, deps, req.params.ref);
      const body = parseBody(IssueBody, req.body);
      const _egsInfo = buildEgsInfo(tenant, signing);
      const scope = toTenantScope(tenant);

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
        deps.metrics.invoicesIssuedTotal.inc({
          tenant: tenant.tenantRef,
          kind,
          status,
        });
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

      if (zatcaRequestId !== undefined) {
        reply.header("X-Zatca-Request-Id", zatcaRequestId);
      }
      return reply.send({
        invoiceNumber: issued.invoiceNumber,
        sequence: issued.sequence,
        invoiceHash: "invoiceHash" in issued ? issued.invoiceHash : undefined,
        signedXml: "signedXml" in issued ? issued.signedXml : undefined,
        qrCode: "qrCode" in issued ? issued.qrCode : undefined,
        status,
        zatcaResponse,
      });
    },
  );

  // GET /v1/tenants/:ref/invoices/:invoiceId
  server.get<{ Params: { ref: string; invoiceId: string } }>(
    "/v1/tenants/:ref/invoices/:invoiceId",
    async (req, reply) => {
      const { tenant } = await authTenant(req, deps, req.params.ref);
      const scope = toTenantScope(tenant);
      const record = await deps.storage.loadInvoice(scope, req.params.invoiceId);
      if (record === null) {
        throw new ZatcaRegistryError(`Unknown invoice '${req.params.invoiceId}'.`);
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
        throw new ZatcaRegistryError(`Unknown invoice '${req.params.invoiceId}'.`);
      }
      let result: unknown;
      let zatcaRequestId: string | undefined;
      let cancelStatus: "ok" | "error" = "ok";
      try {
        result = await cancelInvoice({
          invoiceId: body.zatcaInvoiceId,
          clearanceNumber: body.clearanceNumber,
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
          deps.metrics.invoicesCancelledTotal.inc({
            tenant: tenant.tenantRef,
            result: cancelStatus,
          });
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
        throw new ZatcaRegistryError(`Unknown invoice '${req.params.invoiceId}'.`);
      }
      const query = parseBody(StatusQuery, req.query);
      const result = await checkInvoiceStatus({
        invoiceId: query.zatcaInvoiceId,
        clearanceNumber: query.clearanceNumber,
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
        throw new ZatcaRegistryError(`Unknown invoice '${req.params.invoiceId}'.`);
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
