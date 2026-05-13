/**
 * Unit tests for Phase 2 QR generation.
 *
 * Coverage:
 * - All 9 tags produced in order.
 * - Tags 1-5 match Phase 1 tags exactly (compatibility).
 * - Tags 6-9 carry the supplied cryptographic material verbatim.
 * - Missing required fields throw `ZatcaSigningError`.
 */

import { describe, expect, it } from "vitest";
import { ZatcaSigningError } from "../types/errors.js";
import { XMLDocument } from "../xml/document.js";
import { generatePhase2QR } from "./phase2.js";

const MINIMAL_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
    <cbc:IssueDate>2024-01-15</cbc:IssueDate>
    <cbc:IssueTime>14:30:45Z</cbc:IssueTime>
    <cac:AccountingSupplierParty>
        <cac:Party>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>301234567890003</cbc:CompanyID>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>Acme LLC</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingSupplierParty>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:TaxInclusiveAmount currencyID="SAR">115.00</cbc:TaxInclusiveAmount>
    </cac:LegalMonetaryTotal>
</Invoice>`;

function decodeTLV(buf: Uint8Array): Array<{ tag: number; value: Uint8Array }> {
  const out: Array<{ tag: number; value: Uint8Array }> = [];
  let i = 0;
  while (i < buf.byteLength) {
    const tag = buf[i];
    const len = buf[i + 1];
    if (tag === undefined || len === undefined) break;
    const value = buf.slice(i + 2, i + 2 + len);
    out.push({ tag, value });
    i += 2 + len;
  }
  return out;
}

describe("generatePhase2QR", () => {
  const invoice = new XMLDocument(MINIMAL_INVOICE);
  const invoiceHash = "TEST_INVOICE_HASH_BASE64_VALUE_44CHARS_ABCDE";
  const digitalSignature = "TEST_DIGITAL_SIGNATURE_BASE64";
  const publicKey = new Uint8Array([0x04, 0xaa, 0xbb, 0xcc]);
  const certificateSignature = new Uint8Array([0x30, 0x44, 0x02, 0x20]);

  it("produces all 9 expected tags in order", () => {
    const qr = generatePhase2QR({
      invoice,
      invoiceHash,
      digitalSignature,
      publicKey,
      certificateSignature,
    });
    const tlv = decodeTLV(new Uint8Array(Buffer.from(qr, "base64")));
    expect(tlv.length).toBe(9);
    expect(tlv.map((t) => t.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("carries tag 6 = invoice hash verbatim (utf-8)", () => {
    const qr = generatePhase2QR({
      invoice,
      invoiceHash,
      digitalSignature,
      publicKey,
      certificateSignature,
    });
    const tlv = decodeTLV(new Uint8Array(Buffer.from(qr, "base64")));
    expect(Buffer.from(tlv[5]!.value).toString("utf8")).toBe(invoiceHash);
  });

  it("carries tag 7 = digital signature as the UTF-8 bytes of the base64 string", () => {
    const qr = generatePhase2QR({
      invoice,
      invoiceHash,
      digitalSignature,
      publicKey,
      certificateSignature,
    });
    const tlv = decodeTLV(new Uint8Array(Buffer.from(qr, "base64")));
    expect(Buffer.from(tlv[6]!.value).toString("utf8")).toBe(digitalSignature);
  });

  it("carries tag 8 = public key bytes verbatim", () => {
    const qr = generatePhase2QR({
      invoice,
      invoiceHash,
      digitalSignature,
      publicKey,
      certificateSignature,
    });
    const tlv = decodeTLV(new Uint8Array(Buffer.from(qr, "base64")));
    expect(Array.from(tlv[7]!.value)).toEqual(Array.from(publicKey));
  });

  it("carries tag 9 = certificate signature bytes verbatim", () => {
    const qr = generatePhase2QR({
      invoice,
      invoiceHash,
      digitalSignature,
      publicKey,
      certificateSignature,
    });
    const tlv = decodeTLV(new Uint8Array(Buffer.from(qr, "base64")));
    expect(Array.from(tlv[8]!.value)).toEqual(Array.from(certificateSignature));
  });

  it("throws ZatcaSigningError when VAT number is missing", () => {
    const broken = new XMLDocument(
      MINIMAL_INVOICE.replace(
        "<cbc:CompanyID>301234567890003</cbc:CompanyID>",
        "",
      ),
    );
    expect(() =>
      generatePhase2QR({
        invoice: broken,
        invoiceHash,
        digitalSignature,
        publicKey,
        certificateSignature,
      }),
    ).toThrow(ZatcaSigningError);
  });
});
