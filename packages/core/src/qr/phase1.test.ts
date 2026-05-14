/**
 * Unit tests for Phase 1 QR generation.
 *
 * Coverage:
 * - All five tags produced in order against a known invoice XML.
 * - Round-trip parse of the base64 TLV recovers the tag bytes.
 * - Missing required fields throw `ZatcaSigningError`.
 */

import { describe, expect, it } from "vitest";
import { ZatcaSigningError } from "../types/errors.js";
import { XMLDocument } from "../xml/document.js";
import { generatePhase1QR } from "./phase1.js";

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

/**
 * Walks a TLV byte buffer and returns `[tagIndex, valueBytes]` pairs
 * in order. Used by tests to assert tag-by-tag content without
 * coupling to the byte layout.
 */
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

describe("generatePhase1QR", () => {
  it("produces a base64 string", () => {
    const qr = generatePhase1QR(new XMLDocument(MINIMAL_INVOICE));
    expect(typeof qr).toBe("string");
    // 5 tags + lengths + payloads -> base64 string (length divisible by 4)
    expect(qr.length % 4).toBe(0);
  });

  it("encodes all five expected tags in order", () => {
    const qr = generatePhase1QR(new XMLDocument(MINIMAL_INVOICE));
    const tlv = decodeTLV(new Uint8Array(Buffer.from(qr, "base64")));
    expect(tlv.length).toBe(5);
    expect(tlv[0]?.tag).toBe(1);
    expect(Buffer.from(tlv[0]?.value).toString("utf8")).toBe("Acme LLC");
    expect(tlv[1]?.tag).toBe(2);
    expect(Buffer.from(tlv[1]?.value).toString("utf8")).toBe("301234567890003");
    expect(tlv[2]?.tag).toBe(3);
    expect(Buffer.from(tlv[2]?.value).toString("utf8")).toBe("2024-01-15T14:30:45Z");
    expect(tlv[3]?.tag).toBe(4);
    expect(Buffer.from(tlv[3]?.value).toString("utf8")).toBe("115.00");
    expect(tlv[4]?.tag).toBe(5);
    expect(Buffer.from(tlv[4]?.value).toString("utf8")).toBe("15.00");
  });

  it("appends Z to IssueTime if it is missing", () => {
    const noZ = MINIMAL_INVOICE.replace("14:30:45Z", "14:30:45");
    const qr = generatePhase1QR(new XMLDocument(noZ));
    const tlv = decodeTLV(new Uint8Array(Buffer.from(qr, "base64")));
    expect(Buffer.from(tlv[2]?.value).toString("utf8")).toBe("2024-01-15T14:30:45Z");
  });

  it("throws ZatcaSigningError when seller name is missing", () => {
    const broken = MINIMAL_INVOICE.replace(
      "<cbc:RegistrationName>Acme LLC</cbc:RegistrationName>",
      "",
    );
    expect(() => generatePhase1QR(new XMLDocument(broken))).toThrow(ZatcaSigningError);
  });

  it("throws ZatcaSigningError when TaxTotal is missing", () => {
    const broken = MINIMAL_INVOICE.replace(/<cac:TaxTotal>[\s\S]*?<\/cac:TaxTotal>/, "");
    expect(() => generatePhase1QR(new XMLDocument(broken))).toThrow(ZatcaSigningError);
  });
});
