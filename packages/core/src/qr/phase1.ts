/**
 * Phase 1 QR generation.
 *
 * Encodes the five fields ZATCA's Phase 1 mandate (Dec 2021) requires:
 *
 * | Tag | Field                          |
 * |-----|--------------------------------|
 * | 1   | Seller name                    |
 * | 2   | VAT registration number        |
 * | 3   | Invoice timestamp (UTC, ISO)   |
 * | 4   | Invoice total (with VAT)       |
 * | 5   | VAT total                      |
 *
 * Used as a fallback for systems not yet upgraded to Phase 2 and as
 * the prefix tags inside the Phase 2 QR.
 */

import { ZatcaSigningError } from "../types/errors.js";
import type { XMLDocument } from "../xml/document.js";
import { encodeTLVAsBase64 } from "./tlv.js";

/**
 * Helper: extract a leaf string from `XMLDocument.get(...)` results,
 * accepting both `[value]` and `[{ "#text": value }]` shapes the
 * `fast-xml-parser` configuration emits.
 *
 * Throws `ZatcaSigningError` if the path is missing — Phase 1 QR
 * requires all five tags by spec; an absent field is a programmer
 * error, not a runtime condition.
 */
function readLeaf(invoice: XMLDocument, path: string, label: string): string {
  const result = invoice.get(path);
  if (!result || result.length === 0) {
    throw new ZatcaSigningError(
      `Cannot generate QR: missing required invoice field ${label} (path: ${path}).`,
    );
  }
  const first = result[0] as unknown;
  if (typeof first === "string") {
    return first;
  }
  if (typeof first === "number" || typeof first === "boolean") {
    return String(first);
  }
  if (first && typeof first === "object" && "#text" in first) {
    const text = (first as { "#text": unknown })["#text"];
    return String(text);
  }
  return String(first);
}

/**
 * Reads an amount value (e.g. `LegalMonetaryTotal/TaxInclusiveAmount`)
 * whose serialised shape is `{ "@_currencyID": "SAR", "#text": "115.00" }`.
 *
 * `XMLDocument.get` returns the parent object — the caller passes the
 * full path to the amount tag and we extract `#text`.
 */
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

/**
 * Reads the seller's VAT number (`PartyTaxScheme/CompanyID`). Same
 * resilience as `readLeaf` — the value may be a plain string or
 * a `{ "#text": string }` object depending on whether the source
 * UBL emitted an attribute on the tag.
 */
function readVatNumber(invoice: XMLDocument): string {
  const VAT_PATH =
    "Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID";
  return readLeaf(invoice, VAT_PATH, "VAT number");
}

/**
 * Builds the canonical `YYYY-MM-DDTHH:mm:ssZ` timestamp that ZATCA
 * embeds in the QR.
 *
 * The XML stores `IssueDate` (`YYYY-MM-DD`) and `IssueTime`
 * (`HH:mm:ssZ` per UBL 2.1). Concatenating with a `T` separator
 * yields the spec timestamp. If `IssueTime` already ends with `Z`,
 * we keep it; otherwise we append.
 */
function readIssueTimestamp(invoice: XMLDocument): string {
  const issueDate = readLeaf(invoice, "Invoice/cbc:IssueDate", "IssueDate");
  const issueTime = readLeaf(invoice, "Invoice/cbc:IssueTime", "IssueTime");
  const timeWithZ = issueTime.endsWith("Z") ? issueTime : `${issueTime}Z`;
  // Strip any existing `T`-delimited prefix from issueTime (defensive)
  return `${issueDate}T${timeWithZ.replace(/^.*T/, "")}`;
}

/**
 * Generates the Phase 1 QR for the provided invoice XML.
 *
 * @returns base64-encoded TLV byte string ready for QR rendering.
 */
export function generatePhase1QR(invoice: XMLDocument): string {
  const sellerName = readLeaf(
    invoice,
    "Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName",
    "Seller name",
  );
  const vatNumber = readVatNumber(invoice);
  const timestamp = readIssueTimestamp(invoice);
  const invoiceTotal = readAmountText(
    invoice,
    "Invoice/cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount",
    "TaxInclusiveAmount",
  );
  // `cac:TaxTotal` appears multiple times in UBL invoices (one for
  // sub-total breakdown, one for the document total). The QR uses
  // the first occurrence's `cbc:TaxAmount`. Read the parent and
  // descend so we don't accidentally collapse to a flat path that
  // ambiguates between the two TaxTotal nodes.
  const vatTotal = (() => {
    const taxTotals = invoice.get("Invoice/cac:TaxTotal");
    if (!taxTotals || taxTotals.length === 0) {
      throw new ZatcaSigningError(
        "Cannot generate QR: missing required invoice field TaxTotal.",
      );
    }
    const first = taxTotals[0] as { "cbc:TaxAmount"?: { "#text"?: unknown } };
    const text = first["cbc:TaxAmount"]?.["#text"];
    if (text === undefined || text === null) {
      throw new ZatcaSigningError(
        "Cannot generate QR: TaxTotal has no cbc:TaxAmount/#text value.",
      );
    }
    return String(text);
  })();

  return encodeTLVAsBase64([sellerName, vatNumber, timestamp, invoiceTotal, vatTotal]);
}
