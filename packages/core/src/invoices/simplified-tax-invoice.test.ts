/**
 * Unit tests — {@link SimplifiedTaxInvoiceBuilder}.
 *
 * Validates that the builder produces a parseable XML document with
 * the expected ZATCA discriminators (388 tax-invoice code, simplified
 * `0211010` subtype literal) and that the orchestrator's outputs are
 * shape-correct.
 */

import { describe, expect, it } from "vitest";
import type { SimplifiedTaxInvoiceInput } from "../types/invoice.js";
import { XMLDocument } from "../xml/document.js";
import { BASE_PIH, makeTestEgsInfo, makeTestLineItem, readTestKeys } from "./_test-helpers.js";
import { SimplifiedTaxInvoiceBuilder } from "./simplified-tax-invoice.js";

function makeInput(): SimplifiedTaxInvoiceInput {
  return {
    kind: "simplified-tax-invoice",
    egsInfo: makeTestEgsInfo(),
    invoiceCounterNumber: 1,
    invoiceSerialNumber: "INV-0001",
    issueDate: "2024-01-15",
    issueTime: "14:30:45Z",
    previousInvoiceHash: BASE_PIH,
    lineItems: [makeTestLineItem()],
    buyerName: "Walk-in Customer",
  };
}

describe("SimplifiedTaxInvoiceBuilder.build", () => {
  it("emits a parseable pre-sign XML with the expected discriminators", () => {
    const b = new SimplifiedTaxInvoiceBuilder(makeInput());
    const out = b.build(readTestKeys());
    const doc = new XMLDocument(out.invoiceXml);
    expect(doc.get("Invoice/cbc:InvoiceTypeCode")).toBeDefined();
    // `cbc:InvoiceTypeCode` is an attributed text node so the parser
    // returns an object `{ "@_name": "0211010", "#text": "388" }`.
    const code = doc.get("Invoice/cbc:InvoiceTypeCode")?.[0] as
      | { "@_name"?: string; "#text"?: string }
      | undefined;
    expect(code?.["@_name"]).toBe("0211010");
    expect(code?.["#text"]).toBe("388");
  });

  it("propagates the buyer name into AccountingCustomerParty", () => {
    const b = new SimplifiedTaxInvoiceBuilder(makeInput());
    const out = b.build(readTestKeys());
    expect(out.invoiceXml).toContain(
      "<cbc:RegistrationName>Walk-in Customer</cbc:RegistrationName>",
    );
  });

  it("returns a 44-char base64 invoice hash", () => {
    const b = new SimplifiedTaxInvoiceBuilder(makeInput());
    const out = b.build(readTestKeys());
    expect(out.invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("returns a signed XML containing UBLExtensions + SignatureValue", () => {
    const b = new SimplifiedTaxInvoiceBuilder(makeInput());
    const out = b.build(readTestKeys());
    expect(out.signedXml).toContain("<ext:UBLExtensions>");
    expect(out.signedXml).toContain("<ds:SignatureValue>");
  });

  it("returns a non-empty base64 QR code", () => {
    const b = new SimplifiedTaxInvoiceBuilder(makeInput());
    const out = b.build(readTestKeys());
    expect(out.qrCode.length).toBeGreaterThan(0);
    expect(Buffer.from(out.qrCode, "base64").length).toBeGreaterThan(0);
  });

  it("reports invoiceTypeCode / isSimplified / isCreditOrDebitNote correctly", () => {
    const b = new SimplifiedTaxInvoiceBuilder(makeInput());
    expect(b.invoiceTypeCode()).toBe("388");
    expect(b.isSimplified()).toBe(true);
    expect(b.isCreditOrDebitNote()).toBe(false);
  });
});
