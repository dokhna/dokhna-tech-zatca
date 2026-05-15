/**
 * Standard tax invoice UBL template + populator.
 *
 * Ported verbatim from the legacy helper's
 * `standard.tax.invoice.template.ts`. The only structural difference
 * versus the simplified template is the BR-KSA-06 subtype literal
 * (`name="0100000"` for "standard tax invoice") and the empty
 * `<cac:AccountingCustomerParty>` left at the bottom — the buyer
 * party is populated by the builder via `XMLDocument.set` when
 * `input.buyerInfo` is supplied.
 *
 * Do not reformat: ZATCA's canonicalisation step is whitespace-
 * sensitive.
 */

import type { StandardTaxInvoiceInput } from "../types/invoice.js";
import { ZATCA_INVOICE_TYPES } from "../types/invoice.js";
import { generateInvoiceBillingReference } from "./billing-reference.js";

const TEMPLATE = /* XML */ `
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions>SET_UBL_EXTENSIONS_STRING</ext:UBLExtensions>

    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>SET_INVOICE_SERIAL_NUMBER</cbc:ID>
    <cbc:UUID>SET_TERMINAL_UUID</cbc:UUID>
    <cbc:IssueDate>SET_ISSUE_DATE</cbc:IssueDate>
    <cbc:IssueTime>SET_ISSUE_TIME</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="0100000">SET_INVOICE_TYPE</cbc:InvoiceTypeCode>
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
  <cac:AccountingCustomerParty></cac:AccountingCustomerParty>
</Invoice>
`;

/**
 * Fills the standard tax invoice template with values from `input`.
 *
 * The buyer party (BR-KSA-15) is *not* substituted here — the builder
 * injects it as a structured `XMLObject` into `Invoice/cac:AccountingCustomerParty`
 * after parsing, which keeps the template free of HTML-escape concerns
 * around free-text registration names.
 */
export function populateStandardTaxInvoiceTemplate(input: StandardTaxInvoiceInput): string {
  const invoiceType = input.cancelation
    ? input.cancelation.cancelationType
    : ZATCA_INVOICE_TYPES.INVOICE;

  const billingReference = input.cancelation
    ? generateInvoiceBillingReference(input.cancelation.canceledInvoiceNumber)
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
    .replace("SET_VAT_NAME", input.egsInfo.vatName);
}
