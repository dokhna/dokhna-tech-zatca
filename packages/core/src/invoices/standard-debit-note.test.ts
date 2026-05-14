/**
 * Unit tests — {@link StandardDebitNoteBuilder}.
 */

import { describe, expect, it } from "vitest";
import type { StandardDebitNoteInput } from "../types/invoice.js";
import { XMLDocument } from "../xml/document.js";
import {
  BASE_PIH,
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "./_test-helpers.js";
import { StandardDebitNoteBuilder } from "./standard-debit-note.js";

function makeInput(): StandardDebitNoteInput {
  return {
    kind: "standard-debit-note",
    egsInfo: makeTestEgsInfo(),
    invoiceCounterNumber: 6,
    invoiceSerialNumber: "DN-0002",
    issueDate: "2024-01-17",
    issueTime: "12:00:00Z",
    previousInvoiceHash: BASE_PIH,
    lineItems: [
      {
        ...makeTestLineItem(),
        quantity: 1,
        taxExclusivePrice: 50,
        name: "Service Adjustment",
      },
    ],
    buyerInfo: {
      registrationName: "Acme Buyer Co.",
      identityScheme: "CRN",
      identityNumber: "2020202020",
    },
    cancelation: makeTestCancelation("383"),
  };
}

describe("StandardDebitNoteBuilder.build", () => {
  it("emits `0100000` standard subtype + 383 debit-note code", () => {
    const out = new StandardDebitNoteBuilder(makeInput()).build(readTestKeys());
    const doc = new XMLDocument(out.invoiceXml);
    const code = doc.get("Invoice/cbc:InvoiceTypeCode")?.[0] as
      | { "@_name"?: string; "#text"?: string }
      | undefined;
    expect(code?.["@_name"]).toBe("0100000");
    expect(code?.["#text"]).toBe("383");
  });

  it("emits BOTH line-item <cac:TaxSubtotal> AND <cbc:RoundingAmount>", () => {
    const out = new StandardDebitNoteBuilder(makeInput()).build(readTestKeys());
    const doc = new XMLDocument(out.invoiceXml);
    const lineTaxTotal = doc.get("Invoice/cac:InvoiceLine/cac:TaxTotal")?.[0] as
      | { "cbc:RoundingAmount"?: unknown; "cac:TaxSubtotal"?: unknown }
      | undefined;
    expect(lineTaxTotal?.["cac:TaxSubtotal"]).toBeDefined();
    expect(lineTaxTotal?.["cbc:RoundingAmount"]).toBeDefined();
  });

  it("includes buyer + BillingReference", () => {
    const out = new StandardDebitNoteBuilder(makeInput()).build(readTestKeys());
    expect(out.invoiceXml).toContain("Acme Buyer Co.");
    expect(out.invoiceXml).toContain("<cac:BillingReference>");
  });

  it("invoiceTypeCode reports 383", () => {
    const b = new StandardDebitNoteBuilder(makeInput());
    expect(b.invoiceTypeCode()).toBe("383");
    expect(b.isSimplified()).toBe(false);
    expect(b.isCreditOrDebitNote()).toBe(true);
  });
});
