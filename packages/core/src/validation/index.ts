/**
 * Public validation surface — brand factories, runtime guards, and
 * zod schemas.
 *
 * Brand factories (`asVATNumber`, `asCommercialRegistrationNumber`,
 * `asInvoiceUUID`, `asEGSUuid`, `asBase64`, `asInvoiceHash`) are the
 * recommended way to construct branded primitives at the host
 * boundary — they validate the format and throw
 * `ZatcaValidationError` on bad input.
 *
 * Zod schemas mirror every `InvoiceInput` variant and a few
 * primitives; consumers can use them to validate untrusted payloads
 * (e.g. HTTP request bodies) before passing them into the package.
 */

export * from "./vat-number.js";
export * from "./crn.js";
export * from "./uuid.js";
export * from "./base64.js";
export * from "./schemas.js";
