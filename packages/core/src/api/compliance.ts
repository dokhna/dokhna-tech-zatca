/**
 * ZATCA `/compliance/invoices` endpoint client.
 *
 * Submits a signed UBL invoice and its canonical hash to the ZATCA
 * compliance gateway. Used during onboarding for the compliance test
 * pack — does NOT actually report or clear an invoice in production.
 *
 * Differences vs. the rwiqha helper:
 *   - The token-debug logging block is gone. Open-source builds must
 *     never emit secret material, truncated or otherwise.
 *   - Errors throw `ZatcaApiError`, not `Error`/`Boom`.
 *   - HTTP goes through the new fetch-based client (timeout + retry).
 */

import type { ZatcaComplianceResult, ZatcaEnvironment } from "../types/api.js";
import { ZatcaApiError } from "../types/errors.js";
import { getZatcaEndpoints } from "./endpoints.js";
import { buildAuthHeaders } from "./headers.js";
import { type HttpClientOptions, type RetryOptions, request } from "./http-client.js";

/**
 * Inputs to {@link checkInvoiceCompliance}. The signed XML and its
 * hash are produced by the Phase 2/3 signing pipeline; the EGS UUID
 * and credentials come from the compliance CSID issued during
 * onboarding (Phase 6).
 */
export interface CheckInvoiceComplianceParams {
  /** Signed UBL invoice XML (full document, not base64). */
  readonly signedInvoiceXml: string;
  /** Canonical SHA-256 of the invoice document (base64). */
  readonly invoiceHash: string;
  /** EGS UUID — must match the `<cbc:UUID>` inside the invoice. */
  readonly egsUuid: string;
  /** Compliance CSID (base64 PEM body, no headers). */
  readonly binarySecurityToken: string;
  /** API secret returned alongside the compliance CSID. */
  readonly apiSecret: string;
  /** Target environment. */
  readonly environment: ZatcaEnvironment;
  /** Optional HTTP overrides (test injection, timeout, retry). */
  readonly httpOptions?: Omit<HttpClientOptions, "baseUrl"> & {
    readonly retries?: RetryOptions;
  };
}

interface ComplianceRequestBody {
  readonly invoiceHash: string;
  readonly uuid: string;
  readonly invoice: string;
}

/**
 * Submit an invoice to ZATCA's `/compliance/invoices` endpoint.
 *
 * Returns the parsed compliance result. Throws `ZatcaApiError` on any
 * non-2xx status (validation envelope attached to
 * `error.validationResults` when ZATCA returned one).
 */
export async function checkInvoiceCompliance(
  params: CheckInvoiceComplianceParams,
): Promise<ZatcaComplianceResult> {
  if (!params.signedInvoiceXml) {
    throw new ZatcaApiError("signedInvoiceXml is required for compliance check", 0);
  }
  if (!params.invoiceHash) {
    throw new ZatcaApiError("invoiceHash is required for compliance check", 0);
  }
  if (!params.egsUuid) {
    throw new ZatcaApiError("egsUuid is required for compliance check", 0);
  }
  if (!params.binarySecurityToken) {
    throw new ZatcaApiError("binarySecurityToken is required for compliance check", 0);
  }
  if (!params.apiSecret) {
    throw new ZatcaApiError("apiSecret is required for compliance check", 0);
  }

  const endpoints = getZatcaEndpoints(params.environment);
  const clientOptions: HttpClientOptions = {
    baseUrl: endpoints.base,
    ...(params.httpOptions ?? {}),
  };
  const headers = buildAuthHeaders(params.binarySecurityToken, params.apiSecret);
  const body: ComplianceRequestBody = {
    invoiceHash: params.invoiceHash,
    uuid: params.egsUuid,
    invoice: Buffer.from(params.signedInvoiceXml).toString("base64"),
  };

  return await request<ZatcaComplianceResult, ComplianceRequestBody>(clientOptions, {
    method: "POST",
    path: endpoints.compliance,
    headers,
    body,
  });
}
