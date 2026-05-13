/**
 * Runtime guards + brand factories for base64-encoded strings used
 * across the ZATCA pipeline.
 *
 * Two related shapes:
 *
 * - **Generic Base64** — RFC 4648 alphabet (`A-Z a-z 0-9 + /`) with
 *   `0-2` `=` characters of padding. Used for PEM bodies, binary
 *   security tokens, QR base64 output.
 * - **InvoiceHash** — the specific 44-character base64 produced by
 *   `base64(sha256(canonical_xml))`. Always ends with `=` (single
 *   padding byte for a 32-byte digest).
 */

import type { Base64, InvoiceHash } from "../types/branded.js";
import { ZatcaValidationError } from "../types/errors.js";

/** RFC 4648 base64 — at least one character, optional `=` padding. */
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

/** Base64-encoded SHA-256 digest: 43 chars + single `=` pad = 44 total. */
const INVOICE_HASH_REGEX = /^[A-Za-z0-9+/]{43}=$/;

/** Type guard for generic base64-encoded strings. */
export function isBase64(value: unknown): value is Base64 {
  return typeof value === "string" && BASE64_REGEX.test(value);
}

/**
 * Brand factory for arbitrary base64 strings.
 *
 * @param value - Candidate base64 string.
 * @returns The same value typed as `Base64`.
 * @throws {ZatcaValidationError} when the string contains characters
 *         outside the RFC 4648 alphabet or has malformed padding.
 *
 * @example
 * ```ts
 * const b64 = asBase64("SGVsbG8gd29ybGQ=");
 * ```
 */
export function asBase64(value: string): Base64 {
  if (!BASE64_REGEX.test(value)) {
    throw new ZatcaValidationError(
      `Invalid base64 string: contains characters outside the RFC 4648 alphabet or has malformed padding.`,
    );
  }
  return value as Base64;
}

/** Type guard for the 44-char base64 SHA-256 invoice-hash form. */
export function isInvoiceHash(value: unknown): value is InvoiceHash {
  return typeof value === "string" && INVOICE_HASH_REGEX.test(value);
}

/**
 * Brand factory for invoice hashes. Throws `ZatcaValidationError` if
 * the value is not a 44-character base64 SHA-256.
 */
export function asInvoiceHash(value: string): InvoiceHash {
  if (!INVOICE_HASH_REGEX.test(value)) {
    throw new ZatcaValidationError(
      `Invalid invoice hash: ${value}. Expected 44 base64 characters ending with '='.`,
    );
  }
  return value as InvoiceHash;
}
