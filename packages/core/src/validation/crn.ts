/**
 * Runtime guard + brand factory for Saudi Commercial Registration
 * Numbers (CRN / Sijil Tijari). Format: exactly 10 digits.
 */

import type { CommercialRegistrationNumber } from "../types/branded.js";
import { ZatcaValidationError } from "../types/errors.js";

const CRN_REGEX = /^\d{10}$/;

/** Type guard — does `value` look like a Saudi CRN? */
export function isCommercialRegistrationNumber(
  value: unknown,
): value is CommercialRegistrationNumber {
  return typeof value === "string" && CRN_REGEX.test(value);
}

/**
 * Brand factory — throws `ZatcaValidationError` on malformed input,
 * otherwise returns the same string typed as
 * `CommercialRegistrationNumber`.
 *
 * @param value - Candidate CRN string.
 * @returns The same value typed as `CommercialRegistrationNumber`.
 * @throws {ZatcaValidationError} when the value is not exactly 10 digits.
 *
 * @example
 * ```ts
 * const crn = asCommercialRegistrationNumber("1010010101"); // typed as CRN
 * asCommercialRegistrationNumber("nope"); // throws ZatcaValidationError
 * ```
 */
export function asCommercialRegistrationNumber(
  value: string,
): CommercialRegistrationNumber {
  if (!CRN_REGEX.test(value)) {
    throw new ZatcaValidationError(
      `Invalid commercial registration number: ${value}. Expected 10 digits.`,
    );
  }
  return value as CommercialRegistrationNumber;
}
