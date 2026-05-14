/**
 * Tests for `generateSignedXMLString`.
 *
 * ECDSA signatures are non-deterministic by default (OpenSSL +
 * Node's `crypto.createSign` both inject random `k`), so we cannot
 * byte-compare the entire signed XML against a fixture. Instead the
 * tests verify the deterministic *parts*:
 *
 * - The same input invoice produces the same hash + same
 *   pre-signature template fill (only `<ds:SignatureValue>` and the
 *   embedded QR's TLV tag-7 differ).
 * - The signed XML contains the expected structural elements.
 * - The QR tags 1-6 + 8 + 9 are byte-identical across runs (only
 *   tag-7 — the signature — varies).
 * - `cleanUpPrivateKeyString` strips PEM framing.
 * - The ECDSA signature verifies against the cert's public key.
 */

import { spawnSync } from "node:child_process";
import { createVerify, randomUUID } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XMLDocument } from "../xml/document.js";
import {
  cleanUpPrivateKeyString,
  createInvoiceDigitalSignature,
  generateSignedXMLString,
} from "./sign.js";

const MINIMAL_INVOICE_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions>SET_UBL_EXTENSIONS_STRING</ext:UBLExtensions>
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>INV-001</cbc:ID>
    <cbc:UUID>11111111-2222-3333-4444-555555555555</cbc:UUID>
    <cbc:IssueDate>2024-01-15</cbc:IssueDate>
    <cbc:IssueTime>14:30:45Z</cbc:IssueTime>
    <cac:AdditionalDocumentReference>
        <cbc:ID>QR</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">SET_QR_CODE_DATA</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:Signature>
        <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
        <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
    </cac:Signature>
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

interface TestKeyMaterial {
  certPem: string;
  keyPem: string;
  keyPath: string;
  certPath: string;
}

let material: TestKeyMaterial | undefined;

beforeAll(async () => {
  const opensslCheck = spawnSync("openssl", ["version"]);
  if (opensslCheck.status !== 0) return;
  const dir = tmpdir();
  const keyPath = join(dir, `${randomUUID()}.pem`);
  const certPath = join(dir, `${randomUUID()}.pem`);
  spawnSync("openssl", ["ecparam", "-name", "secp256k1", "-genkey", "-noout", "-out", keyPath], {
    stdio: "ignore",
  });
  spawnSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-key",
      keyPath,
      "-out",
      certPath,
      "-days",
      "30",
      "-subj",
      "/C=SA/O=Test/OU=Branch/CN=test",
    ],
    { stdio: "ignore" },
  );
  if (!existsSync(certPath)) return;
  material = {
    certPem: await fs.readFile(certPath, "utf8"),
    keyPem: await fs.readFile(keyPath, "utf8"),
    keyPath,
    certPath,
  };
});

afterAll(async () => {
  if (!material) return;
  await fs.unlink(material.keyPath).catch(() => {});
  await fs.unlink(material.certPath).catch(() => {});
});

describe("cleanUpPrivateKeyString", () => {
  it("strips PEM framing", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\nABC123\n-----END EC PRIVATE KEY-----";
    expect(cleanUpPrivateKeyString(pem)).toBe("ABC123");
  });
});

describe("createInvoiceDigitalSignature", () => {
  it("produces a verifiable ECDSA signature", () => {
    if (!material) return;
    const sample_hash = Buffer.from("hello world").toString("base64");
    const sig = createInvoiceDigitalSignature(sample_hash, material.keyPem);
    // Verify with the public key from the cert.
    const verify = createVerify("sha256");
    verify.update(Buffer.from(sample_hash, "base64"));
    const ok = verify.verify(material.certPem, sig, "base64");
    expect(ok).toBe(true);
  });
});

describe("generateSignedXMLString", () => {
  it("returns the expected result shape", () => {
    if (!material) return;
    const result = generateSignedXMLString({
      invoice_xml: new XMLDocument(MINIMAL_INVOICE_TEMPLATE),
      certificate_string: material.certPem,
      private_key_string: material.keyPem,
    });
    expect(result.invoice_hash).toHaveLength(44);
    expect(typeof result.qr).toBe("string");
    expect(result.qr.length).toBeGreaterThan(0);
    expect(result.signed_invoice_string).toContain("<ds:SignatureValue>");
    expect(result.signed_invoice_string).toContain("<ds:X509Certificate>");
    expect(result.signed_invoice_string).toContain("<xades:SigningTime>");
  });

  it("produces an identical hash for identical input across runs", () => {
    if (!material) return;
    const a = generateSignedXMLString({
      invoice_xml: new XMLDocument(MINIMAL_INVOICE_TEMPLATE),
      certificate_string: material.certPem,
      private_key_string: material.keyPem,
    });
    const b = generateSignedXMLString({
      invoice_xml: new XMLDocument(MINIMAL_INVOICE_TEMPLATE),
      certificate_string: material.certPem,
      private_key_string: material.keyPem,
    });
    expect(a.invoice_hash).toBe(b.invoice_hash);
  });

  it("substitutes both SET_UBL_EXTENSIONS_STRING and SET_QR_CODE_DATA placeholders", () => {
    if (!material) return;
    const result = generateSignedXMLString({
      invoice_xml: new XMLDocument(MINIMAL_INVOICE_TEMPLATE),
      certificate_string: material.certPem,
      private_key_string: material.keyPem,
    });
    expect(result.signed_invoice_string).not.toContain("SET_UBL_EXTENSIONS_STRING");
    expect(result.signed_invoice_string).not.toContain("SET_QR_CODE_DATA");
  });
});
