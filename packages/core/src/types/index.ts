/**
 * Public type surface of `@dokhna-tach/zatca`.
 *
 * Re-exports every domain type so consumers can write:
 *
 * ```ts
 * import type { InvoiceInput, VATNumber, StorageAdapter } from "@dokhna-tach/zatca";
 * ```
 *
 * Implementation files live in sibling modules; this file is purely a
 * barrel.
 */

export * from "./branded.js";
export * from "./errors.js";
export * from "./egs.js";
export * from "./parties.js";
export * from "./invoice.js";
export * from "./credit-note.js";
export * from "./debit-note.js";
export * from "./api.js";
export * from "./crypto.js";
export * from "./storage.js";
