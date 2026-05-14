/**
 * The six ZATCA-spec compliance test scenarios.
 *
 * Source of truth: the rwiqha `runComplianceTests` function (see
 * `plan/PHASES/PHASE-06-onboarding-compliance.md`). Each scenario
 * matches the rwiqha payload: 1 line item, 100 SAR net, 15% VAT,
 * 115 SAR total, plus a cancellation block on credit/debit notes.
 *
 * The factories accept the issuer's {@link EGSUnitInfo} (so the
 * generated `egsInfo`-related XML reflects the real EGS) and return
 * a fully typed {@link InvoiceInput} variant — minus the four fields
 * the issuer overlays (`egsInfo`, `invoiceCounterNumber`,
 * `invoiceSerialNumber`, `previousInvoiceHash`).
 *
 * Determinism: dates default to `2024-01-15T12:00:00Z`; override via
 * the `now()` parameter for tests that need a specific timestamp.
 */

import type {
  SimplifiedCreditNoteInput,
  SimplifiedDebitNoteInput,
  SimplifiedTaxInvoiceInput,
  StandardCreditNoteInput,
  StandardDebitNoteInput,
  StandardTaxInvoiceInput,
  ZATCAInvoiceLineItem,
} from "../types/invoice.js";

/** Default issue date — overridable. */
const DEFAULT_ISSUE_DATE = "2024-01-15";
/** Default issue time — overridable. */
const DEFAULT_ISSUE_TIME = "12:00:00Z";

/**
 * Single canonical line item used by every scenario (matches rwiqha:
 * 1 unit at 100 SAR, 15% VAT).
 */
function makeComplianceLineItem(): ZATCAInvoiceLineItem {
  return {
    id: "1",
    name: "Test Item",
    quantity: 1,
    taxExclusivePrice: 100,
    vatPercent: 15,
  };
}

/**
 * Input fields the issuer overlays — these scenarios must not set
 * them.
 */
type IssuerOverlaid =
  | "egsInfo"
  | "invoiceCounterNumber"
  | "invoiceSerialNumber"
  | "previousInvoiceHash";

/** Input for {@link issueSimplifiedTaxInvoice} (issuer fields removed). */
export type SimplifiedInvoiceScenarioInput = Omit<
  SimplifiedTaxInvoiceInput,
  IssuerOverlaid
>;
/** Input for {@link issueStandardTaxInvoice} (issuer fields removed). */
export type StandardInvoiceScenarioInput = Omit<
  StandardTaxInvoiceInput,
  IssuerOverlaid
>;
/** Input for {@link issueSimplifiedCreditNote}. */
export type SimplifiedCreditNoteScenarioInput = Omit<
  SimplifiedCreditNoteInput,
  IssuerOverlaid
>;
/** Input for {@link issueStandardCreditNote}. */
export type StandardCreditNoteScenarioInput = Omit<
  StandardCreditNoteInput,
  IssuerOverlaid
>;
/** Input for {@link issueSimplifiedDebitNote}. */
export type SimplifiedDebitNoteScenarioInput = Omit<
  SimplifiedDebitNoteInput,
  IssuerOverlaid
>;
/** Input for {@link issueStandardDebitNote}. */
export type StandardDebitNoteScenarioInput = Omit<
  StandardDebitNoteInput,
  IssuerOverlaid
>;

/**
 * Optional date overrides applied to every scenario factory.
 *
 * The compliance runner pins these to a single timestamp so the six
 * test invoices share an issue date — matching rwiqha's behaviour and
 * keeping the chain deterministic in CI replays.
 */
export interface ScenarioDateOverrides {
  issueDate?: string;
  issueTime?: string;
}

/** Scenario 1 — simplified tax invoice (B2C). */
export function makeSimplifiedInvoiceScenario(
  overrides: ScenarioDateOverrides = {},
): SimplifiedInvoiceScenarioInput {
  return {
    kind: "simplified-tax-invoice",
    issueDate: overrides.issueDate ?? DEFAULT_ISSUE_DATE,
    issueTime: overrides.issueTime ?? DEFAULT_ISSUE_TIME,
    lineItems: [makeComplianceLineItem()],
    buyerName: "Test Customer",
  };
}

/** Scenario 2 — standard tax invoice (B2B). */
export function makeStandardInvoiceScenario(
  overrides: ScenarioDateOverrides = {},
): StandardInvoiceScenarioInput {
  return {
    kind: "standard-tax-invoice",
    issueDate: overrides.issueDate ?? DEFAULT_ISSUE_DATE,
    issueTime: overrides.issueTime ?? DEFAULT_ISSUE_TIME,
    lineItems: [makeComplianceLineItem()],
    buyerInfo: {
      registrationName: "Test Buyer Co.",
      identityScheme: "CRN",
      identityNumber: "2020202020",
    },
  };
}

/** Scenario 3 — simplified credit note (B2C refund). */
export function makeSimplifiedCreditNoteScenario(
  overrides: ScenarioDateOverrides = {},
): SimplifiedCreditNoteScenarioInput {
  return {
    kind: "simplified-credit-note",
    issueDate: overrides.issueDate ?? DEFAULT_ISSUE_DATE,
    issueTime: overrides.issueTime ?? DEFAULT_ISSUE_TIME,
    lineItems: [makeComplianceLineItem()],
    buyerName: "Test Customer",
    cancelation: {
      canceledInvoiceNumber: 1,
      paymentMethod: "10",
      cancelationType: "381",
      reason: "Compliance test cancellation",
    },
  };
}

/** Scenario 4 — standard credit note (B2B refund). */
export function makeStandardCreditNoteScenario(
  overrides: ScenarioDateOverrides = {},
): StandardCreditNoteScenarioInput {
  return {
    kind: "standard-credit-note",
    issueDate: overrides.issueDate ?? DEFAULT_ISSUE_DATE,
    issueTime: overrides.issueTime ?? DEFAULT_ISSUE_TIME,
    lineItems: [makeComplianceLineItem()],
    buyerInfo: {
      registrationName: "Test Buyer Co.",
      identityScheme: "CRN",
      identityNumber: "2020202020",
    },
    cancelation: {
      canceledInvoiceNumber: 2,
      paymentMethod: "10",
      cancelationType: "381",
      reason: "Compliance test cancellation",
    },
  };
}

/** Scenario 5 — simplified debit note (B2C upward adjustment). */
export function makeSimplifiedDebitNoteScenario(
  overrides: ScenarioDateOverrides = {},
): SimplifiedDebitNoteScenarioInput {
  return {
    kind: "simplified-debit-note",
    issueDate: overrides.issueDate ?? DEFAULT_ISSUE_DATE,
    issueTime: overrides.issueTime ?? DEFAULT_ISSUE_TIME,
    lineItems: [makeComplianceLineItem()],
    buyerName: "Test Customer",
    cancelation: {
      canceledInvoiceNumber: 1,
      paymentMethod: "10",
      cancelationType: "383",
      reason: "Compliance test additional charge",
    },
  };
}

/** Scenario 6 — standard debit note (B2B upward adjustment). */
export function makeStandardDebitNoteScenario(
  overrides: ScenarioDateOverrides = {},
): StandardDebitNoteScenarioInput {
  return {
    kind: "standard-debit-note",
    issueDate: overrides.issueDate ?? DEFAULT_ISSUE_DATE,
    issueTime: overrides.issueTime ?? DEFAULT_ISSUE_TIME,
    lineItems: [makeComplianceLineItem()],
    buyerInfo: {
      registrationName: "Test Buyer Co.",
      identityScheme: "CRN",
      identityNumber: "2020202020",
    },
    cancelation: {
      canceledInvoiceNumber: 2,
      paymentMethod: "10",
      cancelationType: "383",
      reason: "Compliance test additional charge",
    },
  };
}
