/**
 * `<cac:BillingReference>` UBL fragment.
 *
 * Emitted into the invoice template by credit / debit notes whose
 * input carries a `cancelation.canceledInvoiceNumber`. ZATCA's
 * BR-KSA-56 requires the original document's invoice number to be
 * referenced here.
 *
 * Ported verbatim from rwiqha-backend's
 * `invoice.billing.reference.template.ts`. The XML string is
 * whitespace-sensitive (the trailing newline matters at template
 * substitution time) — do not reformat.
 */

const TEMPLATE = /* XML */ `
<cac:BillingReference>
    <cac:InvoiceDocumentReference>
        <cbc:ID>SET_CANCELED_INVOICE_NUMBER</cbc:ID>
    </cac:InvoiceDocumentReference>
</cac:BillingReference>
`;

/**
 * Returns the populated `<cac:BillingReference>` XML fragment.
 *
 * @param canceledInvoiceNumber numeric serial of the original invoice.
 */
export function generateInvoiceBillingReference(
  canceledInvoiceNumber: number,
): string {
  return TEMPLATE.replace(
    "SET_CANCELED_INVOICE_NUMBER",
    canceledInvoiceNumber.toString(),
  );
}
