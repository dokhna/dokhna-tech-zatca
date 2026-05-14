/**
 * Phase 1 (QR-only) tax invoice builder.
 *
 * Produces a minimal UBL invoice with a Phase 1 TLV QR code — no
 * XAdES signature, no UBL extensions, no hash chain. Used by
 * registrants under the Phase 1 (Dec 2021) mandate and as a fallback
 * when Phase 2 onboarding has not yet completed.
 *
 * Ported from rwiqha-backend's
 * `zatca.generate.phase1.invoice.function.ts`. The output XML
 * structure is preserved verbatim; only the input-type plumbing is
 * decoupled from `IInvoice`.
 */

import { generatePhase1QR } from "../qr/phase1.js";
import type { Base64 } from "../types/branded.js";
import type { Phase1InvoiceInput } from "../types/invoice.js";
import { XMLDocument } from "../xml/document.js";

/**
 * Result of {@link Phase1InvoiceBuilder.build}.
 *
 * No signed XML, no invoice hash — Phase 1 invoices are not signed
 * and do not participate in the SHA-256 hash chain.
 */
export interface BuiltPhase1Invoice {
  invoiceXml: string;
  qrCode: Base64;
}

/**
 * Sum helper — totals the line items in the same way the legacy
 * helper did, with no rounding tricks. Returns the subtotal,
 * VAT total, and grand total as plain numbers.
 */
function computeTotals(input: Phase1InvoiceInput): {
  subtotal: number;
  vatAmount: number;
  total: number;
} {
  let subtotal = 0;
  let vatAmount = 0;
  for (const item of input.lineItems) {
    const lineTotal = item.taxExclusivePrice * item.quantity;
    subtotal += lineTotal;
    vatAmount += (lineTotal * item.vatPercent) / 100;
  }
  return { subtotal, vatAmount, total: subtotal + vatAmount };
}

/**
 * Builds the minimal Phase 1 invoice XML for a given input.
 *
 * The `name="0100000"` literal on `cbc:InvoiceTypeCode` is preserved
 * from the rwiqha source — it is the standard-invoice subtype literal,
 * but the Phase 1 spec does not care about the subtype string (only
 * the 388 / 381 / 383 code in element text matters for QR generation).
 */
export class Phase1InvoiceBuilder {
  private readonly input: Phase1InvoiceInput;

  constructor(input: Phase1InvoiceInput) {
    this.input = input;
  }

  build(): BuiltPhase1Invoice {
    const { subtotal, vatAmount, total } = computeTotals(this.input);
    const seller = this.input.egsInfo;
    const buyerName = this.input.buyerName ?? "Customer";

    const linesXml = this.input.lineItems
      .map((item, index) => {
        const lineTotal = item.taxExclusivePrice * item.quantity;
        return `
  <cac:InvoiceLine>
    <cbc:ID>${index + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${item.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${lineTotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${item.name}</cbc:Name>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="SAR">${item.taxExclusivePrice.toFixed(2)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
      })
      .join("");

    const invoiceXml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>${this.input.invoiceSerialNumber}</cbc:ID>
  <cbc:IssueDate>${this.input.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${this.input.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>

  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${seller.vatName}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${seller.vatNumber}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PostalAddress>
        <cbc:StreetName>${seller.location.street}</cbc:StreetName>
        <cbc:BuildingNumber>${seller.location.building}</cbc:BuildingNumber>
        <cbc:CityName>${seller.location.cityName}</cbc:CityName>
        <cbc:PostalZone>${seller.location.postalZone}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingSupplierParty>

  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${buyerName}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>

  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${vatAmount.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${subtotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${total.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="SAR">${total.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${linesXml}
</Invoice>`;

    const parsed = new XMLDocument(invoiceXml);
    const qrCode = generatePhase1QR(parsed);

    return {
      invoiceXml,
      qrCode: qrCode as unknown as Base64,
    };
  }
}
