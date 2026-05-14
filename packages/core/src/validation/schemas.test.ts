import { describe, expect, it } from "vitest";

import type { InvoiceKind } from "../types/invoice.js";
import {
  invoiceInputSchema,
  phase1CreditNoteInputSchema,
  phase1InvoiceInputSchema,
  simplifiedCreditNoteInputSchema,
  simplifiedDebitNoteInputSchema,
  simplifiedTaxInvoiceInputSchema,
  standardCreditNoteInputSchema,
  standardDebitNoteInputSchema,
  standardTaxInvoiceInputSchema,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_HASH = "OWNiNzFlYmEzMGE1MDA0MGFhM2UwMzRhMzU1ZWUzMmI=";
const VALID_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const egsInfo = {
  uuid: VALID_UUID,
  customId: "branch-01-pos-03",
  model: "model-x",
  crnNumber: "1010101010",
  vatName: "Acme Trading Co",
  vatNumber: "310987654321003",
  branchName: "Main Branch",
  branchIndustry: "Retail",
  location: {
    cityName: "Riyadh",
    citySubdivision: "Olaya",
    street: "King Fahd Rd",
    plotIdentification: "1234",
    building: "0001",
    postalZone: "12345",
  },
};

const lineItems = [
  {
    id: "1",
    name: "Widget",
    quantity: 2,
    taxExclusivePrice: 100,
    vatPercent: 15,
  },
];

const buyerInfo = {
  registrationName: "Buyer LLC",
  identityScheme: "CRN" as const,
  identityNumber: "9999999999",
};

const cancelation = {
  canceledInvoiceNumber: 42,
  paymentMethod: "10" as const,
  cancelationType: "381" as const,
  reason: "Customer return",
};

const common = {
  egsInfo,
  invoiceCounterNumber: 1,
  invoiceSerialNumber: "INV-0001",
  issueDate: "2026-05-13",
  issueTime: "10:30:00",
  previousInvoiceHash: VALID_HASH,
  lineItems,
};

const cancelationDebit = {
  ...cancelation,
  cancelationType: "383" as const,
  reason: "Additional charge",
};

// ---------------------------------------------------------------------------
// Happy-path parsing for each variant
// ---------------------------------------------------------------------------

describe("invoice variant schemas — happy paths", () => {
  it("simplified-tax-invoice with buyerName parses", () => {
    const parsed = simplifiedTaxInvoiceInputSchema.parse({
      kind: "simplified-tax-invoice",
      ...common,
      buyerName: "Walk-in Customer",
    });
    expect(parsed.kind).toBe("simplified-tax-invoice");
  });

  it("standard-tax-invoice with buyerInfo parses", () => {
    const parsed = standardTaxInvoiceInputSchema.parse({
      kind: "standard-tax-invoice",
      ...common,
      buyerInfo,
    });
    expect(parsed.kind).toBe("standard-tax-invoice");
  });

  it("simplified-credit-note with cancelation parses", () => {
    const parsed = simplifiedCreditNoteInputSchema.parse({
      kind: "simplified-credit-note",
      ...common,
      cancelation,
      buyerName: "Walk-in Customer",
    });
    expect(parsed.kind).toBe("simplified-credit-note");
  });

  it("standard-credit-note with cancelation + buyerInfo parses", () => {
    const parsed = standardCreditNoteInputSchema.parse({
      kind: "standard-credit-note",
      ...common,
      cancelation,
      buyerInfo,
    });
    expect(parsed.kind).toBe("standard-credit-note");
  });

  it("simplified-debit-note with cancelation parses", () => {
    const parsed = simplifiedDebitNoteInputSchema.parse({
      kind: "simplified-debit-note",
      ...common,
      cancelation: cancelationDebit,
      buyerName: "Walk-in Customer",
    });
    expect(parsed.kind).toBe("simplified-debit-note");
  });

  it("standard-debit-note with cancelation + buyerInfo parses", () => {
    const parsed = standardDebitNoteInputSchema.parse({
      kind: "standard-debit-note",
      ...common,
      cancelation: cancelationDebit,
      buyerInfo,
    });
    expect(parsed.kind).toBe("standard-debit-note");
  });

  it("phase1-invoice parses (no signing-related fields required)", () => {
    const parsed = phase1InvoiceInputSchema.parse({
      kind: "phase1-invoice",
      ...common,
    });
    expect(parsed.kind).toBe("phase1-invoice");
  });

  it("phase1-credit-note parses with cancelation", () => {
    const parsed = phase1CreditNoteInputSchema.parse({
      kind: "phase1-credit-note",
      ...common,
      cancelation,
    });
    expect(parsed.kind).toBe("phase1-credit-note");
  });
});

// ---------------------------------------------------------------------------
// Per-variant fail cases
// ---------------------------------------------------------------------------

describe("invoice variant schemas — fail cases", () => {
  it("simplified-tax-invoice without buyerName is rejected (BR-KSA-71)", () => {
    expect(() =>
      simplifiedTaxInvoiceInputSchema.parse({
        kind: "simplified-tax-invoice",
        ...common,
      }),
    ).toThrow(/buyerName/);
  });

  it("standard-tax-invoice without buyerInfo is rejected", () => {
    expect(() =>
      standardTaxInvoiceInputSchema.parse({
        kind: "standard-tax-invoice",
        ...common,
      }),
    ).toThrow(/buyerInfo/);
  });

  it("simplified-credit-note without cancelation is rejected", () => {
    expect(() =>
      simplifiedCreditNoteInputSchema.parse({
        kind: "simplified-credit-note",
        ...common,
        buyerName: "Walk-in Customer",
      }),
    ).toThrow(/cancelation/);
  });

  it("standard-credit-note without cancelation is rejected", () => {
    expect(() =>
      standardCreditNoteInputSchema.parse({
        kind: "standard-credit-note",
        ...common,
        buyerInfo,
      }),
    ).toThrow(/cancelation/);
  });

  it("simplified-debit-note without cancelation is rejected", () => {
    expect(() =>
      simplifiedDebitNoteInputSchema.parse({
        kind: "simplified-debit-note",
        ...common,
        buyerName: "Walk-in Customer",
      }),
    ).toThrow(/cancelation/);
  });

  it("standard-debit-note without cancelation is rejected", () => {
    expect(() =>
      standardDebitNoteInputSchema.parse({
        kind: "standard-debit-note",
        ...common,
        buyerInfo,
      }),
    ).toThrow(/cancelation/);
  });

  it("phase1-invoice with wrong kind literal is rejected", () => {
    expect(() =>
      phase1InvoiceInputSchema.parse({
        kind: "phase1-not-a-real-kind",
        ...common,
      }),
    ).toThrow();
  });

  it("phase1-credit-note without cancelation is rejected", () => {
    expect(() =>
      phase1CreditNoteInputSchema.parse({
        kind: "phase1-credit-note",
        ...common,
      }),
    ).toThrow(/cancelation/);
  });

  it("invoice with zero line items is rejected", () => {
    expect(() =>
      simplifiedTaxInvoiceInputSchema.parse({
        kind: "simplified-tax-invoice",
        ...common,
        lineItems: [],
        buyerName: "Walk-in Customer",
      }),
    ).toThrow(/line item/i);
  });

  it("invoice with malformed VAT number is rejected", () => {
    expect(() =>
      simplifiedTaxInvoiceInputSchema.parse({
        kind: "simplified-tax-invoice",
        ...common,
        egsInfo: { ...egsInfo, vatNumber: "12345" },
        buyerName: "Walk-in Customer",
      }),
    ).toThrow(/VAT/);
  });
});

// ---------------------------------------------------------------------------
// Top-level discriminated-union dispatch
// ---------------------------------------------------------------------------

describe("invoiceInputSchema (discriminated union)", () => {
  it("dispatches on `kind` and returns the right variant", () => {
    const parsed = invoiceInputSchema.parse({
      kind: "phase1-invoice",
      ...common,
    });
    expect(parsed.kind).toBe("phase1-invoice");
  });

  it("rejects unknown kind discriminators", () => {
    expect(() => invoiceInputSchema.parse({ kind: "not-a-real-kind", ...common })).toThrow();
  });

  it("covers every InvoiceKind literal (smoke test for completeness)", () => {
    const allKinds: InvoiceKind[] = [
      "simplified-tax-invoice",
      "standard-tax-invoice",
      "simplified-credit-note",
      "standard-credit-note",
      "simplified-debit-note",
      "standard-debit-note",
      "phase1-invoice",
      "phase1-credit-note",
    ];
    for (const kind of allKinds) {
      const payload =
        kind === "standard-tax-invoice" ||
        kind === "standard-credit-note" ||
        kind === "standard-debit-note"
          ? { kind, ...common, buyerInfo, cancelation }
          : { kind, ...common, buyerName: "x", cancelation };
      // The bare base schemas (no .refine) inside the discriminated union
      // do not enforce BR-KSA-71 / cancelation rules — the per-variant
      // schemas do. Parsing here just confirms the dispatcher hits each
      // arm.
      const parsed = invoiceInputSchema.parse(payload);
      expect(parsed.kind).toBe(kind);
    }
  });
});
