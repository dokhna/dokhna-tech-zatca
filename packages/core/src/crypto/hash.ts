/**
 * ZATCA invoice-hash computation.
 *
 * Ported from rwiqha-backend's `zatca.xml.signing.ts`. The hash is
 * SHA-256(canonicalize(stripped invoice)) base64-encoded, where:
 *
 * - "stripped" removes the `<ext:UBLExtensions>`, `<cac:Signature>`,
 *   and `<cac:AdditionalDocumentReference cbc:ID="QR">` subtrees.
 * - "canonicalize" runs the Exclusive C14N transform from `xmldsigjs`.
 *
 * After canonicalisation, a pair of *brittle* whitespace adjustments
 * are applied — ZATCA's hash oracle expects the leading newline +
 * indent before `<cbc:ProfileID>` and the duplicated blank line before
 * `<cac:AccountingSupplierParty>`. Removing them produces a hash the
 * sandbox rejects. The two `replace` calls are commented inline.
 *
 * Reference: ZATCA Electronic Invoice Security Features Implementation
 * Standards (June 2022) §2.3.3 — uses the same canonicalisation as the
 * Previous Invoice Hash (PIH / BS-KSA-13).
 */

import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import { XmlCanonicalizer } from "xmldsigjs";
import type { InvoiceHash } from "../types/branded.js";
import { ZatcaSigningError } from "../types/errors.js";
import { XMLDocument } from "../xml/document.js";

/**
 * Strips signing-related elements + canonicalises the invoice into
 * the byte sequence over which the hash is taken.
 *
 * Exported for golden-vector inspection / debugging; callers in
 * production should reach for {@link getInvoiceHash} directly.
 */
export function getPureInvoiceString(invoice_xml: XMLDocument): string {
  // Deep-copy via reparse to avoid mutating the caller's document.
  const invoice_copy = new XMLDocument(invoice_xml.toString({ no_header: false }));
  invoice_copy.delete("Invoice/ext:UBLExtensions");
  invoice_copy.delete("Invoice/cac:Signature");
  invoice_copy.delete("Invoice/cac:AdditionalDocumentReference", { "cbc:ID": "QR" });

  const domParser = new DOMParser();
  const invoice_xml_dom = domParser.parseFromString(
    invoice_copy.toString({ no_header: false }),
    "text/xml",
  );
  const canonicalizer = new XmlCanonicalizer(false, false);
  const canonicalized = canonicalizer.Canonicalize(invoice_xml_dom);
  if (typeof canonicalized !== "string") {
    throw new ZatcaSigningError(
      "XmlCanonicalizer returned a non-string value during invoice canonicalisation.",
    );
  }
  return canonicalized;
}

/**
 * Hashes a parsed UBL invoice according to ZATCA's spec.
 *
 * @returns Branded base64 SHA-256 digest (44 chars, ends with `=`).
 */
export function getInvoiceHash(invoice_xml: XMLDocument): InvoiceHash {
  let pure_invoice_string = getPureInvoiceString(invoice_xml);
  // Whitespace fixups required by the ZATCA hash oracle. Removing
  // them yields a digest the sandbox rejects with
  // "Hash mismatch" — preserve verbatim from the source helper.
  pure_invoice_string = pure_invoice_string.replace(
    "<cbc:ProfileID>",
    "\n    <cbc:ProfileID>",
  );
  pure_invoice_string = pure_invoice_string.replace(
    "<cac:AccountingSupplierParty>",
    "\n    \n    <cac:AccountingSupplierParty>",
  );
  const digest = createHash("sha256").update(pure_invoice_string).digest("base64");
  return digest as InvoiceHash;
}

/**
 * Hashes a base64 certificate body using ZATCA's "hex-then-base64"
 * convention from §1.6.2.1.1.2 of the Implementation Standards.
 *
 * @param certificate_string base64 certificate body (no PEM headers).
 */
export function getCertificateHash(certificate_string: string): string {
  return Buffer.from(
    createHash("sha256").update(certificate_string).digest("hex"),
  ).toString("base64");
}
