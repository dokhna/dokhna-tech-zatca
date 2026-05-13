/**
 * ZATCA invoice status lookup client.
 *
 * Rwiqha's host application overlays a database-update side effect on
 * top of this HTTP call (mapping ZATCA statuses to internal statuses,
 * persisting validation messages). That orchestration is outside the
 * scope of a portable library — this module returns the parsed
 * gateway response and leaves persistence to the caller.
 */

import type { ZatcaEnvironment } from "../types/api.js";
import { ZatcaApiError } from "../types/errors.js";
import { getZatcaEndpoints } from "./endpoints.js";
import { buildAuthHeaders } from "./headers.js";
import {
  type HttpClientOptions,
  type RetryOptions,
  request,
} from "./http-client.js";

/**
 * Inputs to {@link checkInvoiceStatus}.
 */
export interface CheckInvoiceStatusParams {
  /** ZATCA-issued invoice identifier. */
  readonly invoiceId: string;
  /** ZATCA-issued clearance number. */
  readonly clearanceNumber: string;
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
 * Response from the ZATCA status lookup endpoint. The gateway returns
 * a clearance status (for standard invoices) or a reporting status
 * (for simplified), plus optional validation messages and timestamps.
 */
export interface ZatcaInvoiceStatusResult {
  readonly clearanceStatus?: "CLEARED" | "REJECTED" | "PENDING" | string;
  readonly reportingStatus?: "REPORTED" | "FAILED" | string;
  readonly clearanceNumber?: string;
  readonly clearanceTimestamp?: string;
  readonly validationResults?: unknown;
}

/**
 * Look up the current status of a previously-submitted invoice.
 *
 * Returns the parsed status result. Throws `ZatcaApiError` on any
 * non-2xx status.
 */
export async function checkInvoiceStatus(
  params: CheckInvoiceStatusParams,
): Promise<ZatcaInvoiceStatusResult> {
  if (!params.invoiceId) {
    throw new ZatcaApiError("invoiceId is required for status lookup", 0);
  }
  if (!params.clearanceNumber) {
    throw new ZatcaApiError(
      "clearanceNumber is required for status lookup",
      0,
    );
  }
  if (!params.binarySecurityToken) {
    throw new ZatcaApiError(
      "binarySecurityToken is required for status lookup",
      0,
    );
  }
  if (!params.apiSecret) {
    throw new ZatcaApiError("apiSecret is required for status lookup", 0);
  }

  const endpoints = getZatcaEndpoints(params.environment);
  const clientOptions: HttpClientOptions = {
    baseUrl: endpoints.base,
    ...(params.httpOptions ?? {}),
  };
  const headers = buildAuthHeaders(
    params.binarySecurityToken,
    params.apiSecret,
  );

  return await request<ZatcaInvoiceStatusResult>(clientOptions, {
    method: "GET",
    path: `${endpoints.invoiceStatus}/${encodeURIComponent(params.invoiceId)}`,
    headers,
    query: { clearanceNumber: params.clearanceNumber },
  });
}
