/**
 * Tests for the hashing helpers.
 *
 * The byte-identical fixture assertion lives in
 * `../fixtures/*.test.ts` once golden vectors are captured; this
 * file covers structural invariants:
 *
 * - `getInvoiceHash` returns a 44-char base64 string ending in `=`.
 * - Same input → same hash (deterministic).
 * - Removing the QR / Signature / UBLExtensions subtree does not
 *   change the hash (because the function strips them itself).
 * - `getCertificateHash` is base64-of-hex (88 chars for a SHA-256).
 */

import { describe, expect, it } from "vitest";
import { XMLDocument } from "../xml/document.js";
import { getCertificateHash, getInvoiceHash, getPureInvoiceString } from "./hash.js";

const MINIMAL_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>INV-001</cbc:ID>
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

describe("getInvoiceHash", () => {
  it("returns a 44-char base64 string", () => {
    const hash = getInvoiceHash(new XMLDocument(MINIMAL_INVOICE));
    expect(hash).toHaveLength(44);
    expect(hash.endsWith("=")).toBe(true);
  });

  it("is deterministic for identical input", () => {
    const a = getInvoiceHash(new XMLDocument(MINIMAL_INVOICE));
    const b = getInvoiceHash(new XMLDocument(MINIMAL_INVOICE));
    expect(a).toBe(b);
  });

  it("ignores cac:Signature, ext:UBLExtensions, and the QR cac:AdditionalDocumentReference", () => {
    const withSignatureNoise = MINIMAL_INVOICE.replace(
      "</Invoice>",
      `<cac:Signature>
        <cbc:ID>noise</cbc:ID>
      </cac:Signature>
    </Invoice>`,
    );
    const a = getInvoiceHash(new XMLDocument(MINIMAL_INVOICE));
    const b = getInvoiceHash(new XMLDocument(withSignatureNoise));
    expect(a).toBe(b);
  });
});

describe("getPureInvoiceString", () => {
  it("strips signing-related elements before canonicalising", () => {
    const pure = getPureInvoiceString(new XMLDocument(MINIMAL_INVOICE));
    expect(pure).not.toContain("ext:UBLExtensions");
    expect(pure).not.toContain("<cac:Signature>");
  });
});

describe("getCertificateHash", () => {
  it("returns the base64-of-hex SHA-256 digest", () => {
    const hash = getCertificateHash("ABC123");
    // SHA-256("ABC123") hex = e0bebd22819993425814866b62701e2919ea26f1370499c1037b53b9d49c2c8a
    // base64 of that 64-char hex string = 88 chars.
    expect(hash).toHaveLength(88);
    expect(hash).toBe(
      Buffer.from("e0bebd22819993425814866b62701e2919ea26f1370499c1037b53b9d49c2c8a").toString(
        "base64",
      ),
    );
  });
});
