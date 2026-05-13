/**
 * Unit tests — {@link SimplifiedDebitNoteBuilder}.
 */

import { describe, expect, it } from "vitest";
import type { SimplifiedDebitNoteInput } from "../types/invoice.js";
import { XMLDocument } from "../xml/document.js";
import { SimplifiedDebitNoteBuilder } from "./simplified-debit-note.js";
import {
  BASE_PIH,
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "./_test-helpers.js";

function makeInput(): SimplifiedDebitNoteInput {
  return {
    kind: "simplified-debit-note",
    egsInfo: makeTestEgsInfo(),
    invoiceCounterNumber: 5,
    invoiceSerialNumber: "DN-0001",
    issueDate: "2024-01-17",
    issueTime: "11:00:00Z",
    previousInvoiceHash: BASE_PIH,
    lineItems: [
      {
        ...makeTestLineItem(),
        quantity: 1,
        name: "Adjustment",
      },
    ],
    cancelation: makeTestCancelation("383"),
  };
}

describe("SimplifiedDebitNoteBuilder.build", () => {
  it("emits `0200000` simplified subtype + 383 debit-note code", () => {
    const out = new SimplifiedDebitNoteBuilder(makeInput()).build(readTestKeys());
    const doc = new XMLDocument(out.invoiceXml);
    const code = doc.get("Invoice/cbc:InvoiceTypeCode")?.[0] as
      | { "@_name"?: string; "#text"?: string }
      | undefined;
    expect(code?.["@_name"]).toBe("0200000");
    expect(code?.["#text"]).toBe("383");
  });

  it("includes <cac:BillingReference> and <cac:PaymentMeans>", () => {
    const out = new SimplifiedDebitNoteBuilder(makeInput()).build(readTestKeys());
    expect(out.invoiceXml).toContain("<cac:BillingReference>");
    expect(out.invoiceXml).toContain("<cac:PaymentMeans>");
  });

  it("emits line-item <cac:TaxSubtotal> instead of <cbc:RoundingAmount>", () => {
    const out = new SimplifiedDebitNoteBuilder(makeInput()).build(readTestKeys());
    expect(out.invoiceXml).toContain("<cac:TaxSubtotal>");
    // The simplified debit note line item must NOT carry RoundingAmount.
    // It can still appear elsewhere — we only verify the line-item form.
    const doc = new XMLDocument(out.invoiceXml);
    const lineTaxTotal = doc.get("Invoice/cac:InvoiceLine/cac:TaxTotal")?.[0] as
      | { "cbc:RoundingAmount"?: unknown; "cac:TaxSubtotal"?: unknown }
      | undefined;
    expect(lineTaxTotal?.["cac:TaxSubtotal"]).toBeDefined();
    expect(lineTaxTotal?.["cbc:RoundingAmount"]).toBeUndefined();
  });

  it("invoiceTypeCode reports 383 (debit note)", () => {
    const b = new SimplifiedDebitNoteBuilder(makeInput());
    expect(b.invoiceTypeCode()).toBe("383");
    expect(b.isSimplified()).toBe(true);
    expect(b.isCreditOrDebitNote()).toBe(true);
  });
});
