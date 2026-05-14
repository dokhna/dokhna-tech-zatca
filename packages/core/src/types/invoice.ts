/**
 * Invoice input types — the framework-neutral, host-decoupled shapes
 * accepted by the issuer functions.
 *
 * Discriminated by a literal `kind` tag so consumers (and the dispatch
 * function in Phase 3) can narrow exhaustively. Adding a new invoice
 * variant means extending the `kind` union and adding the variant to
 * `InvoiceInput` — the compiler then forces every consumer site to
 * handle it.
 *
 * Numeric amounts are plain `number`. ZATCA spec rounds to 2 decimal
 * places at the line-item level; the builders enforce that.
 *
 * NOTE: Credit-note and debit-note variants are *also* members of
 * `InvoiceInput` here (per spec) — `credit-note.ts` and `debit-note.ts`
 * re-export them as standalone unions so consumers who only care about
 * credit notes can still import a tight type.
 */

import type { InvoiceHash } from "./branded.js";
import type { EGSUnitInfo } from "./egs.js";
import type { BuyerInfo } from "./parties.js";

// ---------------------------------------------------------------------------
// Const literal sets
// ---------------------------------------------------------------------------

/**
 * UN/CEFACT-coded payment methods accepted by ZATCA.
 *
 * - `10` — Cash
 * - `30` — Credit transfer
 * - `42` — Payment to bank account
 * - `48` — Bank card
 */
export const ZATCA_PAYMENT_METHODS = {
  CASH: "10",
  CREDIT: "30",
  BANK_ACCOUNT: "42",
  BANK_CARD: "48",
} as const;

/**
 * Literal type of valid ZATCA payment-method codes.
 *
 * Use the `ZATCA_PAYMENT_METHODS` const for human-readable refs:
 * ```ts
 * const m: ZatcaPaymentMethod = ZATCA_PAYMENT_METHODS.CASH;
 * ```
 */
export type ZatcaPaymentMethod = (typeof ZATCA_PAYMENT_METHODS)[keyof typeof ZATCA_PAYMENT_METHODS];

/**
 * UN/CEFACT-coded invoice document types.
 *
 * - `388` — Tax invoice
 * - `383` — Debit note
 * - `381` — Credit note
 */
export const ZATCA_INVOICE_TYPES = {
  INVOICE: "388",
  DEBIT_NOTE: "383",
  CREDIT_NOTE: "381",
} as const;

/** Literal union of ZATCA document-type codes. */
export type ZatcaInvoiceType = (typeof ZATCA_INVOICE_TYPES)[keyof typeof ZATCA_INVOICE_TYPES];

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

/**
 * Per-line non-VAT tax (e.g. an excise tax stacked on top of VAT).
 * Most invoices have none.
 */
export interface ZATCAInvoiceLineItemTax {
  /** Tax rate as a percentage, e.g. `5` for 5%. */
  percentAmount: number;
}

/**
 * Per-line discount.
 *
 * - `amount` — flat amount discounted off the line (in invoice
 *   currency), pre-VAT.
 * - `reason` — required by ZATCA for traceability.
 */
export interface ZATCAInvoiceLineItemDiscount {
  amount: number;
  reason: string;
}

/**
 * A single line on an invoice / credit note / debit note.
 *
 * - `id`               — invoice-scoped line identifier (1-based string).
 * - `name`             — item description shown on the printed invoice.
 * - `quantity`         — quantity sold.
 * - `taxExclusivePrice`— unit price *before* VAT.
 * - `otherTaxes`       — optional non-VAT taxes stacked on the line.
 * - `discounts`        — optional line-level discounts.
 * - `vatPercent`       — VAT rate applied (e.g. `15` for 15%). Use `0`
 *                        for zero-rated or exempt items.
 */
export interface ZATCAInvoiceLineItem {
  id: string;
  name: string;
  quantity: number;
  taxExclusivePrice: number;
  otherTaxes?: ReadonlyArray<ZATCAInvoiceLineItemTax>;
  discounts?: ReadonlyArray<ZATCAInvoiceLineItemDiscount>;
  vatPercent: number;
}

// ---------------------------------------------------------------------------
// Cancelation reference
// ---------------------------------------------------------------------------

/**
 * Reference to the original document being cancelled / amended by a
 * credit note or debit note.
 *
 * - `canceledInvoiceNumber` — invoice-counter number of the original.
 * - `paymentMethod`         — payment method of the original.
 * - `cancelationType`       — `383` (debit) or `381` (credit) — drives
 *                             which UBL document type is built.
 * - `reason`                — free-text justification (ZATCA-mandated).
 */
export interface ZATCAInvoiceCancelation {
  canceledInvoiceNumber: number;
  paymentMethod: ZatcaPaymentMethod;
  cancelationType: ZatcaInvoiceType;
  reason: string;
}

// ---------------------------------------------------------------------------
// Shared base shape (per rwiqha's ZATCAInvoiceProps)
// ---------------------------------------------------------------------------

/**
 * Fields shared by every Phase 2 invoice / credit-note / debit-note
 * input. The variant types below add `kind`, plus document-type-specific
 * extras.
 *
 * - `egsInfo`               — the EGS issuing the document.
 * - `invoiceCounterNumber`  — monotonic per-(EGS) sequence number.
 *                              Comes from `StorageAdapter.incrementCounter`.
 * - `invoiceSerialNumber`   — printable invoice number (the human-facing
 *                              string the counter increment computes).
 * - `issueDate`             — `YYYY-MM-DD` (gregorian).
 * - `issueTime`             — `HH:mm:ss` (24h).
 * - `previousInvoiceHash`   — hash of the previous invoice in this
 *                              EGS's chain. From
 *                              `StorageAdapter.getPreviousHash`.
 * - `lineItems`             — at least one line item required at
 *                              validation time (`schemas.ts`).
 * - `cancelation`           — present on credit / debit notes; absent
 *                              on tax invoices.
 * - `buyerName`             — required for simplified summary invoices
 *                              (BR-KSA-71).
 * - `buyerInfo`             — full buyer party — required for *standard*
 *                              invoices, optional on simplified.
 */
interface InvoiceCommon {
  egsInfo: EGSUnitInfo;
  invoiceCounterNumber: number;
  invoiceSerialNumber: string;
  issueDate: string;
  issueTime: string;
  previousInvoiceHash: InvoiceHash;
  lineItems: ReadonlyArray<ZATCAInvoiceLineItem>;
  cancelation?: ZATCAInvoiceCancelation;
  buyerName?: string;
  buyerInfo?: BuyerInfo;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * Phase 2 simplified tax invoice (B2C). QR + signature required;
 * cleared via reporting API.
 */
export interface SimplifiedTaxInvoiceInput extends InvoiceCommon {
  kind: "simplified-tax-invoice";
}

/**
 * Phase 2 standard tax invoice (B2B). Cleared via clearance API.
 * `buyerInfo` is required at validation time (`schemas.ts`).
 */
export interface StandardTaxInvoiceInput extends InvoiceCommon {
  kind: "standard-tax-invoice";
}

/**
 * Phase 2 simplified credit note (B2C refund / reduction).
 * `cancelation` is required at validation time (`schemas.ts`).
 */
export interface SimplifiedCreditNoteInput extends InvoiceCommon {
  kind: "simplified-credit-note";
}

/** Phase 2 standard credit note (B2B refund / reduction). */
export interface StandardCreditNoteInput extends InvoiceCommon {
  kind: "standard-credit-note";
}

/** Phase 2 simplified debit note (B2C upward adjustment). */
export interface SimplifiedDebitNoteInput extends InvoiceCommon {
  kind: "simplified-debit-note";
}

/** Phase 2 standard debit note (B2B upward adjustment). */
export interface StandardDebitNoteInput extends InvoiceCommon {
  kind: "standard-debit-note";
}

/**
 * Phase 1 (QR-only, no signing) tax invoice. Kept available so callers
 * who must operate under Phase 1 rules — sub-threshold registrants,
 * fallback after a Phase 2 outage — can stay on a single API.
 */
export interface Phase1InvoiceInput extends InvoiceCommon {
  kind: "phase1-invoice";
}

/** Phase 1 (QR-only, no signing) credit note. */
export interface Phase1CreditNoteInput extends InvoiceCommon {
  kind: "phase1-credit-note";
}

// ---------------------------------------------------------------------------
// Top-level union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of every accepted invoice-issuance input.
 *
 * Phase 3's dispatcher narrows on `kind` and routes to the correct
 * builder. Adding a new variant here forces the compiler to flag any
 * non-exhaustive `switch (input.kind)` consumer.
 */
export type InvoiceInput =
  | SimplifiedTaxInvoiceInput
  | StandardTaxInvoiceInput
  | SimplifiedCreditNoteInput
  | StandardCreditNoteInput
  | SimplifiedDebitNoteInput
  | StandardDebitNoteInput
  | Phase1InvoiceInput
  | Phase1CreditNoteInput;

/**
 * Literal union of every supported `kind` discriminator.
 *
 * Used by `StorageAdapter.getPreviousHash(scope, kind?)` so adapters
 * can optionally partition the hash chain per document type if the
 * deployment requires it.
 */
export type InvoiceKind = InvoiceInput["kind"];
