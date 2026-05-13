/**
 * Unit tests for the compliance scenario factories.
 *
 * These factories must return deterministic, schema-valid inputs for
 * every issuer. The tests assert the discriminator + the required
 * fields; the issuer-level tests cover the cryptographic happy paths.
 */

import { describe, expect, it } from "vitest";
import {
  makeSimplifiedCreditNoteScenario,
  makeSimplifiedDebitNoteScenario,
  makeSimplifiedInvoiceScenario,
  makeStandardCreditNoteScenario,
  makeStandardDebitNoteScenario,
  makeStandardInvoiceScenario,
} from "./test-invoices.js";

describe("compliance scenario factories", () => {
  it("returns kind='simplified-tax-invoice' with buyerName", () => {
    const s = makeSimplifiedInvoiceScenario();
    expect(s.kind).toBe("simplified-tax-invoice");
    expect(s.buyerName).toBeDefined();
    expect(s.lineItems.length).toBe(1);
  });

  it("returns kind='standard-tax-invoice' with buyerInfo", () => {
    const s = makeStandardInvoiceScenario();
    expect(s.kind).toBe("standard-tax-invoice");
    expect(s.buyerInfo).toBeDefined();
    expect(s.buyerInfo?.identityScheme).toBe("CRN");
  });

  it("returns kind='simplified-credit-note' with cancelation 381", () => {
    const s = makeSimplifiedCreditNoteScenario();
    expect(s.kind).toBe("simplified-credit-note");
    expect(s.cancelation?.cancelationType).toBe("381");
  });

  it("returns kind='standard-credit-note' with buyerInfo + cancelation 381", () => {
    const s = makeStandardCreditNoteScenario();
    expect(s.kind).toBe("standard-credit-note");
    expect(s.cancelation?.cancelationType).toBe("381");
    expect(s.buyerInfo).toBeDefined();
  });

  it("returns kind='simplified-debit-note' with cancelation 383", () => {
    const s = makeSimplifiedDebitNoteScenario();
    expect(s.kind).toBe("simplified-debit-note");
    expect(s.cancelation?.cancelationType).toBe("383");
  });

  it("returns kind='standard-debit-note' with buyerInfo + cancelation 383", () => {
    const s = makeStandardDebitNoteScenario();
    expect(s.kind).toBe("standard-debit-note");
    expect(s.cancelation?.cancelationType).toBe("383");
    expect(s.buyerInfo).toBeDefined();
  });

  it("respects date overrides", () => {
    const s = makeSimplifiedInvoiceScenario({
      issueDate: "2025-06-01",
      issueTime: "10:00:00Z",
    });
    expect(s.issueDate).toBe("2025-06-01");
    expect(s.issueTime).toBe("10:00:00Z");
  });

  it("produces the same line item shape across all six scenarios", () => {
    const scenarios = [
      makeSimplifiedInvoiceScenario(),
      makeStandardInvoiceScenario(),
      makeSimplifiedCreditNoteScenario(),
      makeStandardCreditNoteScenario(),
      makeSimplifiedDebitNoteScenario(),
      makeStandardDebitNoteScenario(),
    ];
    for (const s of scenarios) {
      expect(s.lineItems[0]?.quantity).toBe(1);
      expect(s.lineItems[0]?.taxExclusivePrice).toBe(100);
      expect(s.lineItems[0]?.vatPercent).toBe(0.15);
    }
  });
});
