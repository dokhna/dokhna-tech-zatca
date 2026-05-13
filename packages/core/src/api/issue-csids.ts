/**
 * ZATCA production CSID issuance client.
 *
 * Once the taxpayer's EGS has passed the compliance test pack, the
 * compliance CSID is exchanged for a production CSID via this
 * endpoint. The production CSID + the API secret returned alongside
 * it are the credentials used by subsequent clearance / reporting /
 * cancel / status calls.
 *
 * Compared to the rwiqha helper:
 *   - **No simulated dev fallback.** Rwiqha's
 *     `issueCSIDSFromAPI` returns a hand-rolled fake response when
 *     the call fails (`requestID: simulated-prod-…`). Open-source
 *     consumers MUST hit a real ZATCA sandbox; we throw
 *     `ZatcaApiError` instead of silently faking success.
 *   - Framework-specific Boom errors replaced with `ZatcaApiError`.
 *   - HTTP via the new fetch-based client.
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
 * Inputs to {@link issueCSIDS}.
 */
export interface IssueCSIDSParams {
  /** Compliance request ID returned by `/compliance` issuance. */
  readonly complianceRequestId: string;
  /** Compliance CSID (used to authenticate this call). */
  readonly binarySecurityToken: string;
  /** API secret paired with the compliance CSID. */
  readonly apiSecret: string;
  /** Target environment. */
  readonly environment: ZatcaEnvironment;
  /** Optional HTTP overrides. */
  readonly httpOptions?: Omit<HttpClientOptions, "baseUrl"> & {
    readonly retries?: RetryOptions;
  };
}

/**
 * Production CSID issuance result.
 *
 * `issuedCertificate` is the decoded PEM body (matching the shape
 * rwiqha returns to its callers — the helper decodes the base64
 * cert before persisting). `binarySecurityToken` is the raw base64
 * string that subsequent ZATCA calls authenticate with.
 */
export interface IssueCSIDSResult {
  readonly issuedCertificate: string;
  readonly binarySecurityToken: string;
  readonly apiSecret: string;
  readonly requestId: string;
  readonly dispositionMessage?: string;
}

interface CsidsRequestBody {
  /** Snake-case key intentional — matches ZATCA's documented contract. */
  readonly compliance_request_id: string;
}

interface CsidsResponseBody {
  readonly requestID?: string;
  readonly dispositionMessage?: string;
  readonly binarySecurityToken?: string;
  readonly secret?: string;
}

/**
 * Issue a production CSID by exchanging compliance credentials + a
 * compliance request ID.
 *
 * Throws `ZatcaApiError` on any non-2xx status (validation envelope
 * attached when present). Throws synchronously if any required input
 * is missing — there is intentionally no dev-only mock fallback.
 */
export async function issueCSIDS(
  params: IssueCSIDSParams,
): Promise<IssueCSIDSResult> {
  if (!params.complianceRequestId) {
    throw new ZatcaApiError(
      "complianceRequestId is required for CSID issuance",
      0,
    );
  }
  if (!params.binarySecurityToken) {
    throw new ZatcaApiError(
      "binarySecurityToken is required for CSID issuance",
      0,
    );
  }
  if (!params.apiSecret) {
    throw new ZatcaApiError(
      "apiSecret is required for CSID issuance",
      0,
    );
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
  const body: CsidsRequestBody = {
    compliance_request_id: params.complianceRequestId,
  };

  const raw = await request<CsidsResponseBody, CsidsRequestBody>(
    clientOptions,
    {
      method: "POST",
      path: endpoints.csids,
      headers,
      body,
    },
  );

  if (!raw.binarySecurityToken) {
    throw new ZatcaApiError(
      "ZATCA CSIDS response missing `binarySecurityToken`",
      0,
      undefined,
      undefined,
      raw,
    );
  }
  if (!raw.secret) {
    throw new ZatcaApiError(
      "ZATCA CSIDS response missing `secret`",
      0,
      undefined,
      undefined,
      raw,
    );
  }
  if (!raw.requestID) {
    throw new ZatcaApiError(
      "ZATCA CSIDS response missing `requestID`",
      0,
      undefined,
      undefined,
      raw,
    );
  }

  const decoded = Buffer.from(raw.binarySecurityToken, "base64").toString(
    "utf8",
  );
  const result: IssueCSIDSResult = {
    issuedCertificate: decoded,
    binarySecurityToken: raw.binarySecurityToken,
    apiSecret: raw.secret,
    requestId: raw.requestID,
    ...(raw.dispositionMessage !== undefined
      ? { dispositionMessage: raw.dispositionMessage }
      : {}),
  };
  return result;
}
