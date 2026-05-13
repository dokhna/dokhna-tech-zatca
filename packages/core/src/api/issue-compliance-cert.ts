/**
 * ZATCA compliance certificate issuance client.
 *
 * The compliance certificate is the first CSID a taxpayer receives:
 * it is issued from a CSR + a one-time password obtained through the
 * Fatoora portal, and it grants access to the compliance test pack
 * (and only the compliance pack — invoices must NOT be cleared with
 * it).
 *
 * Compared to the rwiqha helper:
 *   - Errors throw `ZatcaApiError` (the original threw a
 *     server-framework-specific Boom error).
 *   - No status-code-to-Boom mapping switch — every non-2xx surfaces
 *     as `ZatcaApiError` with `statusCode` set; callers can branch on
 *     the code if they need to.
 *   - HTTP via the new fetch-based client.
 */

import type { ZatcaEnvironment } from "../types/api.js";
import { ZatcaApiError } from "../types/errors.js";
import { getZatcaEndpoints } from "./endpoints.js";
import { buildOtpHeaders } from "./headers.js";
import {
  type HttpClientOptions,
  type RetryOptions,
  request,
} from "./http-client.js";

/**
 * Inputs to {@link issueComplianceCertificate}.
 */
export interface IssueComplianceCertificateParams {
  /** PEM-encoded CSR (full text, not base64 — encoding happens here). */
  readonly csr: string;
  /** One-time password from the Fatoora portal. */
  readonly otp: string;
  /** Target environment. */
  readonly environment: ZatcaEnvironment;
  /** Optional HTTP overrides. */
  readonly httpOptions?: Omit<HttpClientOptions, "baseUrl"> & {
    readonly retries?: RetryOptions;
  };
}

/**
 * Result returned by ZATCA's compliance certificate endpoint.
 *
 * `issuedCertificate` is the human-readable PEM (the gateway returns
 * a base64-wrapped PEM body which we decode and re-wrap with
 * `-----BEGIN/END CERTIFICATE-----` armour).
 *
 * `binarySecurityToken` is the original base64 string ZATCA returned
 * — invoices and subsequent ZATCA calls authenticate with this as
 * the HTTP Basic username.
 */
export interface IssueComplianceCertificateResult {
  readonly issuedCertificate: string;
  readonly binarySecurityToken: string;
  readonly apiSecret: string;
  readonly requestId: string;
  readonly dispositionMessage?: string;
}

interface ComplianceCertRequestBody {
  readonly csr: string;
}

interface ComplianceCertResponseBody {
  readonly binarySecurityToken?: string;
  readonly secret?: string;
  readonly requestID?: string;
  readonly dispositionMessage?: string;
}

/**
 * Decode a base64-encoded PEM body and wrap it in `BEGIN/END
 * CERTIFICATE` armour, matching the form rwiqha returns.
 */
function wrapCertificatePem(base64Body: string): string {
  const body = Buffer.from(base64Body, "base64").toString("utf8");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

/**
 * Issue a compliance certificate from ZATCA.
 *
 * Throws `ZatcaApiError` on any non-2xx status; the validation
 * envelope (if present) is attached to `error.validationResults`.
 */
export async function issueComplianceCertificate(
  params: IssueComplianceCertificateParams,
): Promise<IssueComplianceCertificateResult> {
  if (!params.csr) {
    throw new ZatcaApiError(
      "csr is required to issue a compliance certificate",
      0,
    );
  }
  if (!params.otp) {
    throw new ZatcaApiError(
      "otp is required to issue a compliance certificate",
      0,
    );
  }

  const endpoints = getZatcaEndpoints(params.environment);
  const clientOptions: HttpClientOptions = {
    baseUrl: endpoints.base,
    ...(params.httpOptions ?? {}),
  };
  const headers = buildOtpHeaders(params.otp);
  const body: ComplianceCertRequestBody = {
    csr: Buffer.from(params.csr).toString("base64"),
  };

  const raw = await request<
    ComplianceCertResponseBody,
    ComplianceCertRequestBody
  >(clientOptions, {
    method: "POST",
    path: endpoints.complianceCertificate,
    headers,
    body,
  });

  if (!raw.binarySecurityToken) {
    throw new ZatcaApiError(
      "ZATCA compliance response missing `binarySecurityToken`",
      0,
      undefined,
      undefined,
      raw,
    );
  }
  if (!raw.secret) {
    throw new ZatcaApiError(
      "ZATCA compliance response missing `secret`",
      0,
      undefined,
      undefined,
      raw,
    );
  }
  if (!raw.requestID) {
    throw new ZatcaApiError(
      "ZATCA compliance response missing `requestID`",
      0,
      undefined,
      undefined,
      raw,
    );
  }

  const result: IssueComplianceCertificateResult = {
    issuedCertificate: wrapCertificatePem(raw.binarySecurityToken),
    binarySecurityToken: raw.binarySecurityToken,
    apiSecret: raw.secret,
    requestId: raw.requestID,
    ...(raw.dispositionMessage !== undefined
      ? { dispositionMessage: raw.dispositionMessage }
      : {}),
  };
  return result;
}
