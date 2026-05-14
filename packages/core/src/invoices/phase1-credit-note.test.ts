/**
 * Unit tests — {@link Phase1CreditNoteBuilder}.
 */

import { describe, expect, it } from "vitest";
import type { Phase1CreditNoteInput } from "../types/invoice.js";
import { XMLDocument } from "../xml/document.js";
import {
  BASE_PIH,
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
} from "./_test-helpers.js";
import { Phase1CreditNoteBuilder } from "./phase1-credit-note.js";

function makeInput(): Phase1CreditNoteInput {
  return {
    kind: "phase1-credit-note",
    egsInfo: makeTestEgsInfo(),
    invoiceCounterNumber: 2,
    invoiceSerialNumber: "CN-P1-0001",
    issueDate: "2024-02-02",
    issueTime: "11:00:00Z",
    previousInvoiceHash: BASE_PIH,
    lineItems: [makeTestLineItem()],
    buyerName: "Walk-in Customer",
    cancelation: makeTestCancelation("381"),
  };
}

describe("Phase1CreditNoteBuilder.build", () => {
  it("emits cbc:InvoiceTypeCode 381 (credit note)", () => {
    const out = new Phase1CreditNoteBuilder(makeInput()).build();
    const doc = new XMLDocument(out.invoiceXml);
    const code = doc.get("Invoice/cbc:InvoiceTypeCode")?.[0] as { "#text"?: string } | undefined;
    expect(code?.["#text"]).toBe("381");
  });

  it("includes a <cac:BillingReference> with the original invoice number", () => {
    const out = new Phase1CreditNoteBuilder(makeInput()).build();
    expect(out.invoiceXml).toContain("<cac:BillingReference>");
    expect(out.invoiceXml).toContain("<cbc:ID>1</cbc:ID>");
  });

  it("returns a Phase 1 QR with 5 TLV tags", () => {
    const out = new Phase1CreditNoteBuilder(makeInput()).build();
    const bytes = Buffer.from(out.qrCode, "base64");
    let i = 0;
    let count = 0;
    while (i < bytes.byteLength) {
      const len = bytes[i + 1];
      if (len === undefined) break;
      count += 1;
      i += 2 + len;
    }
    expect(count).toBe(5);
  });
});
