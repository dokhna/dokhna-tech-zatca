/**
 * ZATCA invoice cancellation endpoint client.
 *
 * The legacy in-tree helper authenticated this endpoint with a
 * bearer `ZATCA_API_KEY` environment variable. That was a legacy
 * shape from an internal proxy — the production ZATCA gateway uses
 * HTTP Basic
 * with the production CSID + API secret (same as clearance /
 * reporting). The open-source surface follows the public ZATCA spec.
 */

import type { ZatcaEnvironment } from "../types/api.js";
import { ZatcaApiError } from "../types/errors.js";
import { getZatcaEndpoints } from "./endpoints.js";
import { buildAuthHeaders } from "./headers.js";
import { type HttpClientOptions, type RetryOptions, request } from "./http-client.js";

/**
 * Inputs to {@link cancelInvoice}.
 */
export interface CancelInvoiceParams {
  /** ZATCA-issued invoice identifier returned at clearance time. */
  readonly invoiceId: string;
  /** ZATCA-issued clearance number returned at clearance time. */
  readonly clearanceNumber: string;
  /** Reason for cancellation (free text, surfaced to ZATCA). */
  readonly reason: string;
  /** Production CSID. */
  readonly binarySecurityToken: string;
  /** Production API secret. */
  readonly apiSecret: string;
  /** Target environment. */
  readonly environment: ZatcaEnvironment;
  /** Optional HTTP overrides. */
  readonly httpOptions?: Omit<HttpClientOptions, "baseUrl"> & {
    readonly retries?: RetryOptions;
  };
}

/**
 * Response from the ZATCA cancel endpoint (loose typing — the
 * upstream contract is stabilised at the gateway, but we don't
 * exhaustively model every optional field).
 */
export interface ZatcaCancellationResult {
  readonly clearanceStatus?: "CANCELLED" | "FAILED" | string;
  readonly clearanceNumber?: string;
  readonly clearanceTimestamp?: string;
  readonly validationResults?: unknown;
}

interface CancelRequestBody {
  readonly clearanceNumber: string;
  readonly reason: string;
}

/**
 * Cancel a previously-cleared invoice.
 *
 * Returns the parsed cancellation result. Throws `ZatcaApiError` on
 * any non-2xx status.
 */
export async function cancelInvoice(params: CancelInvoiceParams): Promise<ZatcaCancellationResult> {
  if (!params.invoiceId) {
    throw new ZatcaApiError("invoiceId is required for cancel", 0);
  }
  if (!params.clearanceNumber) {
    throw new ZatcaApiError("clearanceNumber is required for cancel", 0);
  }
  if (!params.reason) {
    throw new ZatcaApiError("reason is required for cancel", 0);
  }
  if (!params.binarySecurityToken) {
    throw new ZatcaApiError("binarySecurityToken is required for cancel", 0);
  }
  if (!params.apiSecret) {
    throw new ZatcaApiError("apiSecret is required for cancel", 0);
  }

  const endpoints = getZatcaEndpoints(params.environment);
  const clientOptions: HttpClientOptions = {
    baseUrl: endpoints.base,
    ...(params.httpOptions ?? {}),
  };
  const headers = buildAuthHeaders(params.binarySecurityToken, params.apiSecret);
  const body: CancelRequestBody = {
    clearanceNumber: params.clearanceNumber,
    reason: params.reason,
  };

  return await request<ZatcaCancellationResult, CancelRequestBody>(clientOptions, {
    method: "POST",
    path: `${endpoints.cancelInvoice}/${encodeURIComponent(params.invoiceId)}`,
    headers,
    body,
  });
}
