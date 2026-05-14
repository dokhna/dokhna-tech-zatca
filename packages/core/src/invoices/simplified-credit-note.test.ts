/**
 * Unit tests — {@link SimplifiedCreditNoteBuilder}.
 */

import { describe, expect, it } from "vitest";
import type { SimplifiedCreditNoteInput } from "../types/invoice.js";
import { XMLDocument } from "../xml/document.js";
import {
  BASE_PIH,
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "./_test-helpers.js";
import { SimplifiedCreditNoteBuilder } from "./simplified-credit-note.js";

function makeInput(): SimplifiedCreditNoteInput {
  return {
    kind: "simplified-credit-note",
    egsInfo: makeTestEgsInfo(),
    invoiceCounterNumber: 3,
    invoiceSerialNumber: "CN-0001",
    issueDate: "2024-01-16",
    issueTime: "09:00:00Z",
    previousInvoiceHash: BASE_PIH,
    lineItems: [
      {
        ...makeTestLineItem(),
        quantity: 1,
        name: "Refunded Coffee",
      },
    ],
    cancelation: makeTestCancelation("388"),
  };
}

describe("SimplifiedCreditNoteBuilder.build", () => {
  it("emits `0200000` simplified subtype + 388 invoice-type code from cancelation", () => {
    const out = new SimplifiedCreditNoteBuilder(makeInput()).build(readTestKeys());
    const doc = new XMLDocument(out.invoiceXml);
    const code = doc.get("Invoice/cbc:InvoiceTypeCode")?.[0] as
      | { "@_name"?: string; "#text"?: string }
      | undefined;
    expect(code?.["@_name"]).toBe("0200000");
    expect(code?.["#text"]).toBe("388");
  });

  it("includes <cac:BillingReference> with the canceled invoice number", () => {
    const out = new SimplifiedCreditNoteBuilder(makeInput()).build(readTestKeys());
    expect(out.invoiceXml).toContain("<cac:BillingReference>");
    expect(out.invoiceXml).toContain("<cbc:ID>1</cbc:ID>");
  });

  it("includes <cac:PaymentMeans> derived from cancelation", () => {
    const out = new SimplifiedCreditNoteBuilder(makeInput()).build(readTestKeys());
    expect(out.invoiceXml).toContain("<cac:PaymentMeans>");
    expect(out.invoiceXml).toContain("<cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>");
    expect(out.invoiceXml).toContain("<cbc:InstructionNote>Customer return</cbc:InstructionNote>");
  });

  it("invoiceTypeCode reports 381 (credit note)", () => {
    const b = new SimplifiedCreditNoteBuilder(makeInput());
    expect(b.invoiceTypeCode()).toBe("381");
    expect(b.isSimplified()).toBe(true);
    expect(b.isCreditOrDebitNote()).toBe(true);
  });
});
