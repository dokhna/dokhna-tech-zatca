/**
 * Runtime guard + brand factories for ZATCA-related UUIDs.
 *
 * ZATCA expects UUID v4 (RFC 4122) for both invoice UUIDs and EGS
 * UUIDs. Lower-case canonical form is the conventional emission, but
 * the regex below accepts upper-case as well for resilience to legacy
 * callers.
 */

import type { EGSUuid, InvoiceUUID } from "../types/branded.js";
import { ZatcaValidationError } from "../types/errors.js";

/**
 * UUID v4 regex — 8-4-4-4-12 hex, with the version nibble fixed at
 * `4` and the variant nibble in the `[89ab]` set. Case-insensitive.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Type guard — does `value` look like a v4 UUID? */
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_REGEX.test(value);
}

/**
 * Brand factory for invoice UUIDs (one per issued document).
 *
 * @param value - Candidate UUID string.
 * @returns The same value typed as `InvoiceUUID`.
 * @throws {ZatcaValidationError} when the value is not a v4 UUID.
 *
 * @example
 * ```ts
 * import { randomUUID } from "node:crypto";
 * const id = asInvoiceUUID(randomUUID());
 * ```
 */
export function asInvoiceUUID(value: string): InvoiceUUID {
  if (!UUID_V4_REGEX.test(value)) {
    throw new ZatcaValidationError(
      `Invalid invoice UUID: ${value}. Expected UUID v4 (8-4-4-4-12 hex).`,
    );
  }
  return value as InvoiceUUID;
}

/**
 * Brand factory for EGS UUIDs (one per EGS unit, immutable across the
 * unit's lifetime).
 *
 * @param value - Candidate EGS UUID string.
 * @returns The same value typed as `EGSUuid`.
 * @throws {ZatcaValidationError} when the value is not a v4 UUID.
 *
 * @example
 * ```ts
 * const egs = asEGSUuid("00000000-0000-4000-8000-000000000001");
 * ```
 */
export function asEGSUuid(value: string): EGSUuid {
  if (!UUID_V4_REGEX.test(value)) {
    throw new ZatcaValidationError(
      `Invalid EGS UUID: ${value}. Expected UUID v4 (8-4-4-4-12 hex).`,
    );
  }
  return value as EGSUuid;
}
