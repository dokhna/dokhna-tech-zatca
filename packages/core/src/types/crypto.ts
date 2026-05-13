/**
 * Crypto-pipeline return shapes — what Phase 2's signing / hashing /
 * QR helpers produce. Defined here so Phase 1 can lock the surface
 * area of every later function signature.
 *
 * No real logic in this file — types only.
 */

import type { Base64, InvoiceHash } from "./branded.js";

/**
 * Result of invoice XML signing.
 *
 * - `signedXml`       — fully signed UBL Invoice XML string, ready for
 *                       submission to ZATCA.
 * - `invoiceHash`     — base64 SHA-256 of the canonicalized XML
 *                       (the chain element written back to the
 *                       `StorageAdapter`).
 * - `signatureValue`  — base64 ECDSA signature emitted into the UBL
 *                       `SignatureValue` element (kept here for
 *                       debugging / golden-vector tests).
 * - `digestValue`     — base64 SHA-256 digest of the canonicalized
 *                       `<UBLExtensions>`-stripped invoice — the value
 *                       inside `<DigestValue>`.
 */
export interface SignedXml {
  signedXml: string;
  invoiceHash: InvoiceHash;
  signatureValue: Base64;
  digestValue: Base64;
}

/**
 * Result of QR-code generation.
 *
 * ZATCA's QR is a TLV-encoded base64 string. The Phase 2 QR encodes
 * the signature + cert hash on top of the Phase 1 fields. The Phase 1
 * QR encodes only seller name / VAT / timestamp / total / VAT total.
 *
 * - `qrBase64` — printable base64 string the host renders into the
 *                QR pixel matrix (e.g. with `qrcode`).
 * - `tlvBytes` — raw TLV byte buffer, exposed for users who want to
 *                generate the pixel matrix themselves.
 */
export interface QrBytes {
  qrBase64: Base64;
  tlvBytes: Uint8Array;
}

/**
 * Parsed projection of an X.509 certificate used by the package.
 *
 * - `serialNumber`    — decimal-string serial.
 * - `issuerName`      — RFC 4514 issuer DN.
 * - `subjectName`     — RFC 4514 subject DN.
 * - `notBefore`       — validity start (UTC).
 * - `notAfter`        — validity end (UTC).
 * - `rawPublicKey`    — raw EC public key bytes (X9.62 uncompressed).
 *                       ZATCA's signed-properties hash needs the raw
 *                       bytes, not the SPKI wrapping that Node's
 *                       `crypto.X509Certificate` exposes.
 * - `signatureValue`  — raw signature bytes on the cert itself
 *                       (used in the Phase 2 QR TLV).
 * - `pem`             — original PEM body for round-tripping.
 */
export interface X509CertificateInfo {
  serialNumber: string;
  issuerName: string;
  subjectName: string;
  notBefore: Date;
  notAfter: Date;
  rawPublicKey: Uint8Array;
  signatureValue: Uint8Array;
  pem: string;
}
