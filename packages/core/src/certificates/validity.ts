/**
 * Pure helper: is this certificate currently valid?
 *
 * Returns `true` if the PEM parses AND `notBefore <= now <= notAfter`.
 * Returns `false` on any failure (parse error, expired, not-yet-valid).
 *
 * No I/O, no logging.
 */

import { X509Certificate } from "node:crypto";

/**
 * Checks the certificate's validity window against the current host
 * clock. Use this as a pre-flight before submitting documents to
 * ZATCA — an expired certificate causes the gateway to reject every
 * invoice.
 *
 * @param certificate PEM-encoded X.509 certificate.
 * @param now         Optional clock override (defaults to `new Date()`).
 *                     Useful for deterministic tests.
 * @returns           `true` iff PEM parses and `now` is inside
 *                     `[notBefore, notAfter]`.
 */
export function isCertificateValid(certificate: string, now: Date = new Date()): boolean {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificate);
  } catch {
    return false;
  }
  const validFrom = new Date(cert.validFrom);
  const validTo = new Date(cert.validTo);
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) {
    return false;
  }
  return now >= validFrom && now <= validTo;
}
