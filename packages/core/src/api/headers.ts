/**
 * Header builders for ZATCA gateway requests.
 *
 * The two principal authentication shapes ZATCA accepts are:
 *
 *   - **OTP** header — used only during compliance certificate
 *     issuance (CSR + one-time password).
 *   - **HTTP Basic** with `{binarySecurityToken}:{apiSecret}` — used
 *     for every other authenticated request once a CSID has been
 *     issued.
 *
 * No header builder here ever logs or returns secret material in a
 * diagnostic shape — the caller composes headers, hands them to the
 * HTTP client, and the client never logs headers.
 */

import { ZATCA_API_VERSION } from "./endpoints.js";

/**
 * Headers required by every ZATCA gateway request: API version,
 * language, content type, accept type.
 */
export function buildBaseHeaders(): Record<string, string> {
  return {
    "Accept-Version": ZATCA_API_VERSION,
    "Accept-Language": "en",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Build the HTTP Basic Authorization header from a binary security
 * token + API secret pair (the credentials issued by ZATCA's
 * `/compliance` or `/production/csids` endpoints).
 */
export function buildAuthHeaders(
  binarySecurityToken: string,
  apiSecret: string,
): Record<string, string> {
  if (!binarySecurityToken) {
    throw new Error("binarySecurityToken is required to build ZATCA auth headers");
  }
  if (!apiSecret) {
    throw new Error("apiSecret is required to build ZATCA auth headers");
  }
  const credentials = Buffer.from(`${binarySecurityToken}:${apiSecret}`).toString("base64");
  return {
    ...buildBaseHeaders(),
    Authorization: `Basic ${credentials}`,
  };
}

/**
 * Build the headers ZATCA expects on the `/compliance` certificate
 * issuance endpoint: the standard base headers plus the one-time
 * password supplied by the taxpayer's Fatoora portal.
 */
export function buildOtpHeaders(otp: string): Record<string, string> {
  if (!otp) {
    throw new Error("OTP is required for compliance certificate issuance");
  }
  return {
    ...buildBaseHeaders(),
    OTP: otp,
  };
}

/**
 * Build the headers expected by the single-invoice clearance /
 * reporting endpoint. Adds the `Clearance-Status: 1` flag ZATCA
 * uses to opt clients into the synchronous clearance flow.
 */
export function buildClearanceHeaders(
  binarySecurityToken: string,
  apiSecret: string,
): Record<string, string> {
  return {
    ...buildAuthHeaders(binarySecurityToken, apiSecret),
    "Clearance-Status": "1",
  };
}
