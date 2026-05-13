/**
 * Unit tests — {@link StandardCreditNoteBuilder}.
 */

import { describe, expect, it } from "vitest";
import type { StandardCreditNoteInput } from "../types/invoice.js";
import { XMLDocument } from "../xml/document.js";
import { StandardCreditNoteBuilder } from "./standard-credit-note.js";
import {
  BASE_PIH,
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "./_test-helpers.js";

function makeInput(): StandardCreditNoteInput {
  return {
    kind: "standard-credit-note",
    egsInfo: makeTestEgsInfo(),
    invoiceCounterNumber: 4,
    invoiceSerialNumber: "CN-0002",
    issueDate: "2024-01-16",
    issueTime: "10:00:00Z",
    previousInvoiceHash: BASE_PIH,
    lineItems: [
      {
        ...makeTestLineItem(),
        quantity: 1,
        taxExclusivePrice: 100,
        name: "Service Refund",
      },
    ],
    buyerInfo: {
      registrationName: "Acme Buyer Co.",
      identityScheme: "CRN",
      identityNumber: "2020202020",
    },
    cancelation: makeTestCancelation("388"),
  };
}

describe("StandardCreditNoteBuilder.build", () => {
  it("emits `0100000` standard subtype + 388 invoice-type code", () => {
    const out = new StandardCreditNoteBuilder(makeInput()).build(readTestKeys());
    const doc = new XMLDocument(out.invoiceXml);
    const code = doc.get("Invoice/cbc:InvoiceTypeCode")?.[0] as
      | { "@_name"?: string; "#text"?: string }
      | undefined;
    expect(code?.["@_name"]).toBe("0100000");
    expect(code?.["#text"]).toBe("388");
  });

  it("includes buyer + BillingReference + PaymentMeans", () => {
    const out = new StandardCreditNoteBuilder(makeInput()).build(readTestKeys());
    expect(out.invoiceXml).toContain("Acme Buyer Co.");
    expect(out.invoiceXml).toContain("<cac:BillingReference>");
    expect(out.invoiceXml).toContain("<cac:PaymentMeans>");
  });

  it("invoiceTypeCode reports 381 (credit note)", () => {
    const b = new StandardCreditNoteBuilder(makeInput());
    expect(b.invoiceTypeCode()).toBe("381");
    expect(b.isSimplified()).toBe(false);
    expect(b.isCreditOrDebitNote()).toBe(true);
  });
});
