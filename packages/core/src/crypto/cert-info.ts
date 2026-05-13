/**
 * X.509 certificate parsing for ZATCA's cryptographic stamp.
 *
 * ZATCA's signing pipeline needs three projection fields from the
 * compliance / production certificate:
 *
 * 1. The certificate hash (SHA-256(base64-body), then base64 of the
 *    hex digest — `getCertificateHash` in `./hash.ts`).
 * 2. The DN-reversed issuer name (rendered as a comma-separated
 *    RFC 4514 string in reverse order).
 * 3. The decimal-string serial number.
 * 4. The raw EC public key bytes (X9.62 uncompressed) — embedded
 *    verbatim in the QR's tag-8.
 * 5. The raw certificate signature bytes — embedded verbatim in the
 *    QR's tag-9.
 *
 * Node's `crypto.X509Certificate` covers (2) and (3); (4) and (5)
 * require ASN.1 access and are read via `@fidm/x509`. The hybrid
 * approach matches the rwiqha original. `@fidm/x509` is flagged for
 * replacement in v2 once Node's stdlib exposes `rawPublicKey` /
 * `rawSignature`.
 */

import { X509Certificate } from "node:crypto";
import { Certificate } from "@fidm/x509";
import { ZatcaCertificateError } from "../types/errors.js";
import { getCertificateHash } from "./hash.js";

/**
 * Cert projection used inside the signing pipeline.
 *
 * Distinct from the public `X509CertificateInfo` type (in
 * `types/crypto.ts`) which is the v1 public surface — this internal
 * shape carries the *precomputed* hash + signing-specific aliases
 * that the rwiqha pipeline produced. Phase 3 will collapse the two
 * shapes once the invoice builders are ported.
 */
export interface CertificateInfo {
  /** Base64-of-hex SHA-256 hash of the certificate body. */
  hash: string;
  /** Reversed-DN issuer string (`CN=..., O=..., ...`). */
  issuer: string;
  /** Decimal-string serial number. */
  serial_number: string;
  /** Raw EC public key bytes (X9.62 uncompressed). */
  public_key: Buffer;
  /** Raw certificate signature bytes. */
  signature: Buffer;
}

/**
 * Strips `-----BEGIN CERTIFICATE-----` / `-----END CERTIFICATE-----`
 * framing from a PEM-encoded certificate, leaving only the base64
 * body.
 *
 * The leading newline after the BEGIN marker is removed deliberately
 * — ZATCA's certificate hash is computed over the body with no
 * surrounding whitespace.
 */
export function cleanUpCertificateString(certificate_string: string): string {
  return certificate_string
    .replace("-----BEGIN CERTIFICATE-----\n", "")
    .replace("-----END CERTIFICATE-----", "")
    .trim();
}

/**
 * Re-wraps a base64 body into a canonical PEM string.
 */
export function wrapCertificateString(body_base64: string): string {
  return `-----BEGIN CERTIFICATE-----\n${body_base64}\n-----END CERTIFICATE-----`;
}

/**
 * Parses a PEM-encoded certificate and extracts the fields ZATCA
 * needs.
 *
 * Accepts either a PEM string (with headers) or a bare base64 body —
 * canonicalised internally.
 *
 * @throws {ZatcaCertificateError} on malformed PEM / unsupported
 *         cert algorithm.
 */
export function extractCertificateInfo(certificate_string: string): CertificateInfo {
  let body: string;
  let pem: string;
  try {
    body = cleanUpCertificateString(certificate_string);
    pem = wrapCertificateString(body);
  } catch (cause) {
    throw new ZatcaCertificateError("Failed to normalise certificate PEM.", cause);
  }

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(pem);
  } catch (cause) {
    throw new ZatcaCertificateError(
      "Failed to parse certificate via node:crypto X509Certificate.",
      cause,
    );
  }

  let cert: Certificate;
  try {
    cert = Certificate.fromPEM(Buffer.from(pem));
  } catch (cause) {
    throw new ZatcaCertificateError(
      "Failed to parse certificate via @fidm/x509 (required for raw public key + signature).",
      cause,
    );
  }

  // ZATCA's `X509IssuerName` field expects the issuer DN reversed
  // and comma-joined — `X509Certificate.issuer` is newline-separated
  // top-down, so reverse-split-join produces the expected format.
  const issuer = x509.issuer.split("\n").reverse().join(", ");

  // Decimal-string serial. `X509Certificate.serialNumber` is hex.
  const serial_number = BigInt(`0x${x509.serialNumber}`).toString(10);

  const hash = getCertificateHash(body);

  return {
    hash,
    issuer,
    serial_number,
    public_key: Buffer.from(cert.publicKeyRaw),
    signature: Buffer.from(cert.signature),
  };
}
