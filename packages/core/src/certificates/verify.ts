/**
 * Pure helper: parse and verify a ZATCA-issued X.509 certificate.
 *
 * Returns a structured projection of the fields callers need to
 * surface in admin UIs — serial number, subject, issuer, validity
 * window, and (optionally) whether a supplied private key matches the
 * certificate's public key.
 *
 * No I/O, no logging, no secret material in errors. The verification
 * is local: there is no chain-build / OCSP / CRL check — those are
 * out of scope for a v1 helper and would require network access.
 */

import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { ZatcaCertificateError } from "../types/errors.js";

/**
 * Result returned by {@link verifyCertificate}.
 *
 * - `isValid`                    — true iff PEM parses and `notBefore <= now <= notAfter`.
 * - `serialNumber`               — hex string from `X509Certificate.serialNumber`.
 * - `subject`                    — newline-joined RFC 4514 subject DN.
 * - `issuer`                     — newline-joined RFC 4514 issuer DN.
 * - `validFrom` / `validTo`      — JavaScript `Date` instances.
 * - `publicKeyMatchesPrivateKey` — `null` if no private key was supplied;
 *                                   otherwise `true` iff the SPKI bytes
 *                                   of the private key's derived public
 *                                   half match the certificate's public
 *                                   key.
 */
export interface CertificateVerification {
  isValid: boolean;
  serialNumber: string;
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  publicKeyMatchesPrivateKey: boolean | null;
}

/**
 * Compares the SPKI-DER of the certificate's public key with the SPKI-
 * DER derived from a supplied private key. Returns `false` if either
 * key fails to parse — never throws.
 */
function spkiMatches(cert: X509Certificate, privateKeyPem: string): boolean {
  let priv: KeyObject;
  try {
    priv = createPrivateKey(privateKeyPem);
  } catch {
    return false;
  }
  let pubFromPriv: KeyObject;
  try {
    pubFromPriv = createPublicKey(priv);
  } catch {
    return false;
  }
  let certSpki: Buffer;
  let privSpki: Buffer;
  try {
    certSpki = cert.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    privSpki = pubFromPriv.export({ type: "spki", format: "der" }) as Buffer;
  } catch {
    return false;
  }
  return certSpki.equals(privSpki);
}

/**
 * Parse the PEM and return a {@link CertificateVerification} record.
 *
 * @throws {ZatcaCertificateError} when the certificate PEM cannot be
 *         parsed. Private-key parse failures are NOT thrown — they
 *         set `publicKeyMatchesPrivateKey` to `false` (callers should
 *         treat that as "verification did not pass").
 */
export function verifyCertificate(args: {
  certificate: string;
  privateKey?: string;
  now?: Date;
}): CertificateVerification {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(args.certificate);
  } catch (cause) {
    throw new ZatcaCertificateError(
      "Failed to parse certificate via node:crypto X509Certificate.",
      cause,
    );
  }

  const validFrom = new Date(cert.validFrom);
  const validTo = new Date(cert.validTo);
  const now = args.now ?? new Date();
  const isValid =
    !Number.isNaN(validFrom.getTime()) &&
    !Number.isNaN(validTo.getTime()) &&
    now >= validFrom &&
    now <= validTo;

  const publicKeyMatchesPrivateKey =
    args.privateKey === undefined ? null : spkiMatches(cert, args.privateKey);

  return {
    isValid,
    serialNumber: cert.serialNumber,
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom,
    validTo,
    publicKeyMatchesPrivateKey,
  };
}
