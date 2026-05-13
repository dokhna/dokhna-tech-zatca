/**
 * Public issuer surface.
 *
 * Re-exports every per-kind issuer function plus the discriminated-
 * union dispatcher and the small party-builder helpers. This is the
 * recommended entry point for consumers of the package — directly
 * instantiating builder classes is for advanced callers only.
 */

export { issueSimplifiedTaxInvoice } from "./issue-simplified-invoice.js";
export type {
  IssueSimplifiedTaxInvoiceArgs,
  IssuedInvoice,
} from "./issue-simplified-invoice.js";

export { issueStandardTaxInvoice } from "./issue-standard-invoice.js";
export type { IssueStandardTaxInvoiceArgs } from "./issue-standard-invoice.js";

export { issueSimplifiedCreditNote } from "./issue-simplified-credit-note.js";
export type { IssueSimplifiedCreditNoteArgs } from "./issue-simplified-credit-note.js";

export { issueStandardCreditNote } from "./issue-standard-credit-note.js";
export type { IssueStandardCreditNoteArgs } from "./issue-standard-credit-note.js";

export { issueSimplifiedDebitNote } from "./issue-simplified-debit-note.js";
export type { IssueSimplifiedDebitNoteArgs } from "./issue-simplified-debit-note.js";

export { issueStandardDebitNote } from "./issue-standard-debit-note.js";
export type { IssueStandardDebitNoteArgs } from "./issue-standard-debit-note.js";

export { issuePhase1Invoice } from "./issue-phase1-invoice.js";
export type {
  IssuePhase1InvoiceArgs,
  IssuedPhase1Invoice,
} from "./issue-phase1-invoice.js";

export { issuePhase1CreditNote } from "./issue-phase1-credit-note.js";
export type { IssuePhase1CreditNoteArgs } from "./issue-phase1-credit-note.js";

export { issueInvoice } from "./dispatch.js";
export type { IssueInvoiceArgs } from "./dispatch.js";

export {
  buildSellerSummary,
  buildBuyerInfoXml,
} from "./build-parties.js";
export type { SellerSummary } from "./build-parties.js";
