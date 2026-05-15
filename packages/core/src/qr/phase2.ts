/**
 * Phase 2 QR generation.
 *
 * Extends the Phase 1 five-tag set with three cryptographic tags:
 *
 * | Tag | Field                          | Source                  |
 * |-----|--------------------------------|-------------------------|
 * | 1   | Seller name                    | XML                     |
 * | 2   | VAT registration number        | XML                     |
 * | 3   | Invoice timestamp (UTC, ISO)   | XML                     |
 * | 4   | Invoice total (with VAT)       | XML                     |
 * | 5   | VAT total                      | XML                     |
 * | 6   | Invoice hash (base64)          | crypto/hash             |
 * | 7   | ECDSA signature (base64 utf-8) | crypto/sign             |
 * | 8   | Cert public key (raw bytes)    | crypto/cert-info        |
 * | 9   | Cert signature (raw bytes)     | crypto/cert-info        |
 *
 * Tags 7-9 are kept as `Uint8Array` to preserve raw bytes — the
 * signature in particular is stored as the *UTF-8 bytes of the
 * base64 string* (per the legacy helper's behaviour and the ZATCA reference
 * implementation), not as decoded bytes. Tag 8 (public key) and
 * tag 9 (certificate signature) are decoded from the certificate
 * and embedded raw.
 *
 * Reference: ZATCA E-Invoicing Detailed Guidelines §3.3 and the
 * Cryptographic Stamp Implementation Standards.
 */

import { ZatcaSigningError } from "../types/errors.js";
import type { XMLDocument } from "../xml/document.js";
import { encodeTLVAsBase64 } from "./tlv.js";

export interface Phase2QRParams {
  /** Parsed (or pre-signed) invoice XML wrapper. */
  invoice: XMLDocument;
  /** Base64-encoded SHA-256 invoice hash (44 chars). */
  invoiceHash: string;
  /** Base64-encoded ECDSA signature over the invoice hash. */
  digitalSignature: string;
  /** Raw EC public key bytes lifted from the X.509 cert. */
  publicKey: Uint8Array;
  /** Raw certificate signature bytes lifted from the X.509 cert. */
  certificateSignature: Uint8Array;
}

/**
 * Helper: extract a leaf string from `XMLDocument.get(...)` results,
 * accepting both `[value]` and `[{ "#text": value }]` shapes.
 */
function readLeaf(invoice: XMLDocument, path: string, label: string): string {
  const result = invoice.get(path);
  if (!result || result.length === 0) {
    throw new ZatcaSigningError(
      `Cannot generate QR: missing required invoice field ${label} (path: ${path}).`,
    );
  }
  const first = result[0] as unknown;
  if (typeof first === "string") return first;
  if (typeof first === "number" || typeof first === "boolean") return String(first);
  if (first && typeof first === "object" && "#text" in first) {
    return String((first as { "#text": unknown })["#text"]);
  }
  return String(first);
}

function readAmountText(invoice: XMLDocument, path: string, label: string): string {
  const result = invoice.get(path);
  if (!result || result.length === 0) {
    throw new ZatcaSigningError(
      `Cannot generate QR: missing required invoice field ${label} (path: ${path}).`,
    );
  }
  const node = result[0] as { "#text"?: unknown };
  if (node?.["#text"] === undefined || node["#text"] === null) {
    throw new ZatcaSigningError(
      `Cannot generate QR: invoice field ${label} has no #text value (path: ${path}).`,
    );
  }
  return String(node["#text"]);
}

function readIssueTimestamp(invoice: XMLDocument): string {
  const issueDate = readLeaf(invoice, "Invoice/cbc:IssueDate", "IssueDate");
  const issueTime = readLeaf(invoice, "Invoice/cbc:IssueTime", "IssueTime");
  const timeWithZ = issueTime.endsWith("Z") ? issueTime : `${issueTime}Z`;
  return `${issueDate}T${timeWithZ.replace(/^.*T/, "")}`;
}

/**
 * Builds the Phase 2 QR (8-tag TLV) for the provided invoice +
 * cryptographic material.
 *
 * Tag 7 is intentionally `Buffer.from(digitalSignature, "utf8")` —
 * the *bytes of the base64 string*, not the decoded signature. This
 * is what the ZATCA reference implementation does; deviating from it
 * causes "invalid QR data" errors in the sandbox.
 */
export function generatePhase2QR(params: Phase2QRParams): string {
  const { invoice, invoiceHash, digitalSignature, publicKey, certificateSignature } = params;

  const sellerName = readLeaf(
    invoice,
    "Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName",
    "Seller name",
  );
  const vatNumber = readLeaf(
    invoice,
    "Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID",
    "VAT number",
  );
  const timestamp = readIssueTimestamp(invoice);
  const invoiceTotal = readAmountText(
    invoice,
    "Invoice/cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount",
    "TaxInclusiveAmount",
  );

  const taxTotals = invoice.get("Invoice/cac:TaxTotal");
  if (!taxTotals || taxTotals.length === 0) {
    throw new ZatcaSigningError("Cannot generate QR: missing required invoice field TaxTotal.");
  }
  const firstTaxTotal = taxTotals[0] as { "cbc:TaxAmount"?: { "#text"?: unknown } };
  const taxAmountText = firstTaxTotal["cbc:TaxAmount"]?.["#text"];
  if (taxAmountText === undefined || taxAmountText === null) {
    throw new ZatcaSigningError("Cannot generate QR: TaxTotal has no cbc:TaxAmount/#text value.");
  }
  const vatTotal = String(taxAmountText);

  return encodeTLVAsBase64([
    sellerName,
    vatNumber,
    timestamp,
    invoiceTotal,
    vatTotal,
    invoiceHash,
    Buffer.from(digitalSignature, "utf8"),
    publicKey,
    certificateSignature,
  ]);
}
