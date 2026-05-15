/**
 * UBL XML templates for ZATCA Phase 2 invoices, credit notes, and
 * debit notes.
 *
 * Each `populate*` function returns a raw XML string with all
 * primitive substitutions performed but with `SET_UBL_EXTENSIONS_STRING`
 * and `SET_QR_CODE_DATA` placeholders still present — those tokens
 * are filled by the signing pipeline in `crypto/sign.ts`.
 *
 * The six invoice / credit / debit templates plus the XAdES
 * `SignedProperties` and UBL signature extension helpers are
 * deliberately exposed here so the `invoices/` and `issue/` modules
 * can import a single namespace.
 */

export { generateInvoiceBillingReference } from "./billing-reference.js";
export { populateSimplifiedCreditNoteTemplate } from "./simplified-credit-note.js";
export { populateSimplifiedDebitNoteTemplate } from "./simplified-debit-note.js";
export { populateSimplifiedTaxInvoiceTemplate } from "./simplified-tax-invoice.js";
export { populateStandardCreditNoteTemplate } from "./standard-credit-note.js";
export { populateStandardDebitNoteTemplate } from "./standard-debit-note.js";
export { populateStandardTaxInvoiceTemplate } from "./standard-tax-invoice.js";
export type { UblExtensionParams } from "./ubl-extension.js";
export { populateUblExtension } from "./ubl-extension.js";
export type { SignedPropertiesParams } from "./ubl-signed-properties.js";
export {
  populateSignedPropertiesForOutput,
  populateSignedPropertiesForSigning,
} from "./ubl-signed-properties.js";
