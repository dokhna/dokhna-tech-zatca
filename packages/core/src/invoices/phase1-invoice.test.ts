/**
 * Unit tests — {@link Phase1InvoiceBuilder}.
 */

import { describe, expect, it } from "vitest";
import type { Phase1InvoiceInput } from "../types/invoice.js";
import { XMLDocument } from "../xml/document.js";
import { BASE_PIH, makeTestEgsInfo, makeTestLineItem } from "./_test-helpers.js";
import { Phase1InvoiceBuilder } from "./phase1-invoice.js";

function makeInput(): Phase1InvoiceInput {
  return {
    kind: "phase1-invoice",
    egsInfo: makeTestEgsInfo(),
    invoiceCounterNumber: 1,
    invoiceSerialNumber: "INV-P1-0001",
    issueDate: "2024-02-01",
    issueTime: "10:00:00Z",
    previousInvoiceHash: BASE_PIH,
    lineItems: [makeTestLineItem()],
    buyerName: "Walk-in Customer",
  };
}

describe("Phase1InvoiceBuilder.build", () => {
  it("emits a parseable XML with cbc:InvoiceTypeCode 388", () => {
    const out = new Phase1InvoiceBuilder(makeInput()).build();
    const doc = new XMLDocument(out.invoiceXml);
    const code = doc.get("Invoice/cbc:InvoiceTypeCode")?.[0] as
      | { "@_name"?: string; "#text"?: string }
      | undefined;
    expect(code?.["#text"]).toBe("388");
  });

  it("returns a non-empty base64 QR that decodes successfully", () => {
    const out = new Phase1InvoiceBuilder(makeInput()).build();
    expect(out.qrCode.length).toBeGreaterThan(0);
    const decoded = Buffer.from(out.qrCode, "base64");
    expect(decoded.byteLength).toBeGreaterThan(0);
  });

  it("Phase 1 QR encodes the 5 mandatory tags", () => {
    const out = new Phase1InvoiceBuilder(makeInput()).build();
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

  it("includes buyer name in AccountingCustomerParty", () => {
    const out = new Phase1InvoiceBuilder(makeInput()).build();
    expect(out.invoiceXml).toContain("Walk-in Customer");
  });
});
