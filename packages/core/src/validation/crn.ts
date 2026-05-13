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
