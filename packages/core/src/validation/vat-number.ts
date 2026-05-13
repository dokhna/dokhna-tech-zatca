/**
 * Runtime guard + brand factory for Saudi VAT numbers.
 *
 * Saudi VATs are 15 digits, starting with `3` and ending with `3`.
 * The middle 13 digits are the registrant's TRN; ZATCA enforces this
 * shape at the API boundary, so the package surfaces the same rule
 * client-side to fail fast.
 */

import type { VATNumber } from "../types/branded.js";
import { ZatcaValidationError } from "../types/errors.js";

/** Strict format regex: starts with `3`, 13 free digits, ends with `3`. */
const VAT_NUMBER_REGEX = /^3\d{13}3$/;

/**
 * Type guard — returns `true` iff `value` is a string matching the
 * ZATCA VAT format. Does *not* brand the value; callers wanting the
 * branded type should use {@link asVATNumber}.
 */
export function isVATNumber(value: unknown): value is VATNumber {
  return typeof value === "string" && VAT_NUMBER_REGEX.test(value);
}

/**
 * Brand factory — throws `ZatcaValidationError` if the input is not a
 * valid Saudi VAT, otherwise returns the same string cast to
 * `VATNumber`.
 *
 * Example:
 * ```ts
 * const vat = asVATNumber("301234567890003"); // typed as VATNumber
 * asVATNumber("nope"); // throws ZatcaValidationError
 * ```
 */
export function asVATNumber(value: string): VATNumber {
  if (!VAT_NUMBER_REGEX.test(value)) {
    throw new ZatcaValidationError(
      `Invalid VAT number: ${value}. Expected 15 digits starting and ending with 3.`,
    );
  }
  return value as VATNumber;
}
