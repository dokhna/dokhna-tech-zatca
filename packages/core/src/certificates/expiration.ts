/**
 * Pure helper: extract the expiration date from a PEM-encoded X.509
 * certificate.
 *
 * No I/O, no caching, no logging. Uses Node's built-in
 * {@link X509Certificate} parser — no `@fidm/x509` round-trip is
 * required for `notAfter`.
 *
 * Throws {@link ZatcaCertificateError} on malformed PEM. The thrown
 * error carries only the parser's own message — the certificate body
 * is never echoed back.
 */

import { X509Certificate } from "node:crypto";
import { ZatcaCertificateError } from "../types/errors.js";

/**
 * Returns the `notAfter` date of the certificate as a JavaScript
 * `Date`. The underlying ASN.1 timestamp is in UTC; the returned
 * `Date` reflects the same instant in the host clock.
 *
 * @throws {ZatcaCertificateError} when the PEM cannot be parsed.
 */
export function getCertificateExpirationDate(certificate: string): Date {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificate);
  } catch (cause) {
    throw new ZatcaCertificateError(
      "Failed to parse certificate via node:crypto X509Certificate.",
      cause,
    );
  }
  return new Date(cert.validTo);
}
