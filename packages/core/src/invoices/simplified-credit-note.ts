/**
 * Simplified credit note builder.
 *
 * Shares arithmetic with the tax invoice family. The credit-note
 * variant always carries a `cancelation` block in practice; that
 * triggers the `<cac:PaymentMeans>` injection in the base class and
 * the `<cac:BillingReference>` substitution in the template.
 */

import type {
  SimplifiedCreditNoteInput,
  ZATCAInvoiceLineItem,
  ZatcaInvoiceType,
} from "../types/invoice.js";
import { ZATCA_INVOICE_TYPES } from "../types/invoice.js";
import type { XMLObject } from "../xml/document.js";
import { populateSimplifiedCreditNoteTemplate } from "../templates/simplified-credit-note.js";
import {
  BaseInvoiceBuilder,
  type LineItemTotals,
} from "./base.js";
import {
  buildInvoiceLegalMonetaryTotal,
  buildInvoiceLineItemTotals,
  buildInvoiceTaxTotal,
} from "./shared-tax-arithmetic.js";

export class SimplifiedCreditNoteBuilder extends BaseInvoiceBuilder<SimplifiedCreditNoteInput> {
  protected override templateFn(input: SimplifiedCreditNoteInput): string {
    return populateSimplifiedCreditNoteTemplate(input);
  }

  protected override buildLineItemTotals(
    lineItem: ZATCAInvoiceLineItem,
  ): LineItemTotals {
    return buildInvoiceLineItemTotals(lineItem);
  }

  protected override buildTaxTotal(
    lineItems: ReadonlyArray<ZATCAInvoiceLineItem>,
  ): ReadonlyArray<XMLObject> {
    return buildInvoiceTaxTotal(lineItems);
  }

  protected override buildLegalMonetaryTotal(
    totalSubtotal: number,
    totalTaxes: number,
  ): XMLObject {
    return buildInvoiceLegalMonetaryTotal(totalSubtotal, totalTaxes);
  }

  override invoiceTypeCode(): ZatcaInvoiceType {
    return ZATCA_INVOICE_TYPES.CREDIT_NOTE;
  }

  override isSimplified(): boolean {
    return true;
  }

  override isCreditOrDebitNote(): boolean {
    return true;
  }
}
