/**
 * Phase 1 (QR-only) credit note builder.
 *
 * Mirrors {@link Phase1InvoiceBuilder} for credit notes. Adds a
 * `<cac:BillingReference>` block to reference the original invoice
 * being amended and uses `381` as the `cbc:InvoiceTypeCode` element
 * text per the ZATCA Phase 1 spec.
 *
 * Ported from rwiqha-backend's
 * `zatca.generate.phase1.credit.note.function.ts`.
 */

import type { Base64 } from "../types/branded.js";
import type { Phase1CreditNoteInput } from "../types/invoice.js";
import { generatePhase1QR } from "../qr/phase1.js";
import { XMLDocument } from "../xml/document.js";

export interface BuiltPhase1CreditNote {
  invoiceXml: string;
  qrCode: Base64;
}

function computeTotals(input: Phase1CreditNoteInput): {
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

export class Phase1CreditNoteBuilder {
  private readonly input: Phase1CreditNoteInput;

  constructor(input: Phase1CreditNoteInput) {
    this.input = input;
  }

  build(): BuiltPhase1CreditNote {
    const { subtotal, vatAmount, total } = computeTotals(this.input);
    const seller = this.input.egsInfo;
    const buyerName = this.input.buyerName ?? "Customer";
    const originalInvoiceNumber =
      this.input.cancelation?.canceledInvoiceNumber.toString() ?? "";

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
  <cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>

  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${originalInvoiceNumber}</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>

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
