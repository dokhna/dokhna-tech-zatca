/**
 * Simplified tax invoice UBL template + populator.
 *
 * Ported verbatim from rwiqha-backend's
 * `simplified.tax.invoice.template.ts`. The XML string is
 * ZATCA-canonicalisation-sensitive; do not reformat. Field-level
 * substitutions use uppercase `SET_*` tokens — identical to the
 * legacy helper so a side-by-side diff stays trivial.
 *
 * The `name="0211010"` `cbc:InvoiceTypeCode` attribute is the
 * BR-KSA-06 subtype literal for "simplified tax invoice / summary
 * invoice with cash payment" — preserved character-for-character
 * because ZATCA's clearance API parses this string with regex.
 */

import { ZATCA_INVOICE_TYPES } from "../types/invoice.js";
import type { SimplifiedTaxInvoiceInput } from "../types/invoice.js";
import { generateInvoiceBillingReference } from "./billing-reference.js";

const TEMPLATE = /* XML */ `
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions>SET_UBL_EXTENSIONS_STRING</ext:UBLExtensions>

    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>SET_INVOICE_SERIAL_NUMBER</cbc:ID>
    <cbc:UUID>SET_TERMINAL_UUID</cbc:UUID>
    <cbc:IssueDate>SET_ISSUE_DATE</cbc:IssueDate>
    <cbc:IssueTime>SET_ISSUE_TIME</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="0211010">SET_INVOICE_TYPE</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
    SET_BILLING_REFERENCE
    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>SET_INVOICE_COUNTER_NUMBER</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>PIH</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">SET_PREVIOUS_INVOICE_HASH</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
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
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">SET_COMMERCIAL_REGISTRATION_NUMBER</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>SET_STREET_NAME</cbc:StreetName>
        <cbc:BuildingNumber>SET_BUILDING_NUMBER</cbc:BuildingNumber>
        <cbc:PlotIdentification>SET_PLOT_IDENTIFICATION</cbc:PlotIdentification>
        <cbc:CitySubdivisionName>SET_CITY_SUBDIVISION</cbc:CitySubdivisionName>
        <cbc:CityName>SET_CITY</cbc:CityName>
        <cbc:PostalZone>SET_POSTAL_NUMBER</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>SET_VAT_NUMBER</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>SET_VAT_NAME</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>SET_BUYER_INFO</cac:AccountingCustomerParty>
</Invoice>
`;

/**
 * Fills the simplified tax invoice template with values from `input`.
 *
 * `kind === "simplified-tax-invoice"`; `cbc:InvoiceTypeCode` is fixed
 * to `388` unless `input.cancelation` overrides it (preserving the
 * legacy behaviour where an "invoice cancellation" can be encoded as
 * a tax invoice rather than a credit / debit note).
 */
export function populateSimplifiedTaxInvoiceTemplate(
  input: SimplifiedTaxInvoiceInput,
): string {
  const invoiceType = input.cancelation
    ? input.cancelation.cancelationType
    : ZATCA_INVOICE_TYPES.INVOICE;

  const billingReference = input.cancelation
    ? generateInvoiceBillingReference(input.cancelation.canceledInvoiceNumber)
    : "";

  const buyerFragment =
    input.buyerName !== undefined && input.buyerName.length > 0
      ? `
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${input.buyerName}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>`
      : "";

  return TEMPLATE.replace("SET_INVOICE_TYPE", invoiceType)
    .replace("SET_BILLING_REFERENCE", billingReference)
    .replace("SET_INVOICE_SERIAL_NUMBER", input.invoiceSerialNumber)
    .replace("SET_TERMINAL_UUID", input.egsInfo.uuid)
    .replace("SET_ISSUE_DATE", input.issueDate)
    .replace("SET_ISSUE_TIME", input.issueTime)
    .replace("SET_PREVIOUS_INVOICE_HASH", input.previousInvoiceHash)
    .replace("SET_INVOICE_COUNTER_NUMBER", input.invoiceCounterNumber.toString())
    .replace("SET_COMMERCIAL_REGISTRATION_NUMBER", input.egsInfo.crnNumber)
    .replace("SET_STREET_NAME", input.egsInfo.location.street)
    .replace("SET_BUILDING_NUMBER", input.egsInfo.location.building)
    .replace("SET_PLOT_IDENTIFICATION", input.egsInfo.location.plotIdentification)
    .replace("SET_CITY_SUBDIVISION", input.egsInfo.location.citySubdivision)
    .replace("SET_CITY", input.egsInfo.location.cityName)
    .replace("SET_POSTAL_NUMBER", input.egsInfo.location.postalZone)
    .replace("SET_VAT_NUMBER", input.egsInfo.vatNumber)
    .replace("SET_VAT_NAME", input.egsInfo.vatName)
    .replace("SET_BUYER_INFO", buyerFragment);
}
