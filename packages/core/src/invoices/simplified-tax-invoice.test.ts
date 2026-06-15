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

/** Minimal TLV decoder — returns the UTF-8 value of a given tag. */
function readQrTag(qrBase64: string, tag: number): string {
  const buf = new Uint8Array(Buffer.from(qrBase64, "base64"));
  let i = 0;
  while (i < buf.byteLength) {
    const t = buf[i];
    const len = buf[i + 1];
    if (t === undefined || len === undefined) break;
    if (t === tag) return Buffer.from(buf.slice(i + 2, i + 2 + len)).toString("utf8");
    i += 2 + len;
  }
  throw new Error(`QR tag ${tag} not found`);
}

describe("SimplifiedTaxInvoiceBuilder — IssueTime UTC normalization", () => {
  it("appends the UTC Z to a bare issueTime and keeps XML, QR tag 3, and SigningTime in agreement", () => {
    // Caller supplies a bare wall-clock time (no Z).
    const b = new SimplifiedTaxInvoiceBuilder({ ...makeInput(), issueTime: "14:30:45" });
    const out = b.build(readTestKeys());

    // XML carries the Z (UBL 2.1 timezone requirement).
    expect(out.invoiceXml).toContain("<cbc:IssueTime>14:30:45Z</cbc:IssueTime>");
    // QR tag 3 is the combined UTC timestamp.
    expect(readQrTag(out.qrCode, 3)).toBe("2024-01-15T14:30:45Z");
    // XAdES SigningTime matches the QR timestamp (no host-TZ drift).
    expect(out.signedXml).toContain("<xades:SigningTime>2024-01-15T14:30:45Z</xades:SigningTime>");
  });

  it("is idempotent — an issueTime already ending in Z is not doubled", () => {
    const b = new SimplifiedTaxInvoiceBuilder({ ...makeInput(), issueTime: "14:30:45Z" });
    const out = b.build(readTestKeys());
    expect(out.invoiceXml).toContain("<cbc:IssueTime>14:30:45Z</cbc:IssueTime>");
    expect(out.invoiceXml).not.toContain("14:30:45ZZ");
    expect(readQrTag(out.qrCode, 3)).toBe("2024-01-15T14:30:45Z");
  });
});
