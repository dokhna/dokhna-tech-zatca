/**
 * Unit tests — {@link StandardTaxInvoiceBuilder}.
 */

import { describe, expect, it } from "vitest";
import type { StandardTaxInvoiceInput } from "../types/invoice.js";
import { XMLDocument } from "../xml/document.js";
import { BASE_PIH, makeTestEgsInfo, makeTestLineItem, readTestKeys } from "./_test-helpers.js";
import { StandardTaxInvoiceBuilder } from "./standard-tax-invoice.js";

function makeInput(): StandardTaxInvoiceInput {
  return {
    kind: "standard-tax-invoice",
    egsInfo: makeTestEgsInfo(),
    invoiceCounterNumber: 2,
    invoiceSerialNumber: "INV-0002",
    issueDate: "2024-01-15",
    issueTime: "14:31:00Z",
    previousInvoiceHash: BASE_PIH,
    lineItems: [
      {
        ...makeTestLineItem(),
        quantity: 1,
        taxExclusivePrice: 100,
        name: "Service Fee",
      },
    ],
    buyerInfo: {
      registrationName: "Acme Buyer Co.",
      identityScheme: "CRN",
      identityNumber: "2020202020",
    },
  };
}

describe("StandardTaxInvoiceBuilder.build", () => {
  it("emits the standard `0100000` subtype literal + 388 invoice code", () => {
    const out = new StandardTaxInvoiceBuilder(makeInput()).build(readTestKeys());
    const doc = new XMLDocument(out.invoiceXml);
    const code = doc.get("Invoice/cbc:InvoiceTypeCode")?.[0] as
      | { "@_name"?: string; "#text"?: string }
      | undefined;
    expect(code?.["@_name"]).toBe("0100000");
    expect(code?.["#text"]).toBe("388");
  });

  it("injects the buyer party into AccountingCustomerParty", () => {
    const out = new StandardTaxInvoiceBuilder(makeInput()).build(readTestKeys());
    expect(out.invoiceXml).toContain("Acme Buyer Co.");
    expect(out.invoiceXml).toContain("2020202020");
  });

  it("returns a 44-char base64 invoice hash and signed XML", () => {
    const out = new StandardTaxInvoiceBuilder(makeInput()).build(readTestKeys());
    expect(out.invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(out.signedXml).toContain("<ds:SignatureValue>");
  });

  it("reports the correct discriminators", () => {
    const b = new StandardTaxInvoiceBuilder(makeInput());
    expect(b.invoiceTypeCode()).toBe("388");
    expect(b.isSimplified()).toBe(false);
    expect(b.isCreditOrDebitNote()).toBe(false);
  });
});
