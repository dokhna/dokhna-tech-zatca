/**
 * Standard tax invoice builder.
 *
 * Concrete subclass of {@link BaseInvoiceBuilder} for the
 * `standard-tax-invoice` variant. Shares arithmetic with the
 * simplified tax invoice — the only differences are the template
 * populator + BR-KSA-06 subtype literal (handled at the template
 * layer) and the simplified / standard discriminator returned by
 * {@link isSimplified}.
 */

import { populateStandardTaxInvoiceTemplate } from "../templates/standard-tax-invoice.js";
import type {
  StandardTaxInvoiceInput,
  ZATCAInvoiceLineItem,
  ZatcaInvoiceType,
} from "../types/invoice.js";
import { ZATCA_INVOICE_TYPES } from "../types/invoice.js";
import type { XMLObject } from "../xml/document.js";
import { BaseInvoiceBuilder, type LineItemTotals } from "./base.js";
import {
  buildInvoiceLegalMonetaryTotal,
  buildInvoiceLineItemTotals,
  buildInvoiceTaxTotal,
} from "./shared-tax-arithmetic.js";

export class StandardTaxInvoiceBuilder extends BaseInvoiceBuilder<StandardTaxInvoiceInput> {
  protected override templateFn(input: StandardTaxInvoiceInput): string {
    return populateStandardTaxInvoiceTemplate(input);
  }

  protected override buildLineItemTotals(lineItem: ZATCAInvoiceLineItem): LineItemTotals {
    return buildInvoiceLineItemTotals(lineItem);
  }

  protected override buildTaxTotal(
    lineItems: ReadonlyArray<ZATCAInvoiceLineItem>,
  ): ReadonlyArray<XMLObject> {
    return buildInvoiceTaxTotal(lineItems);
  }

  protected override buildLegalMonetaryTotal(totalSubtotal: number, totalTaxes: number): XMLObject {
    return buildInvoiceLegalMonetaryTotal(totalSubtotal, totalTaxes);
  }

  override invoiceTypeCode(): ZatcaInvoiceType {
    return ZATCA_INVOICE_TYPES.INVOICE;
  }

  override isSimplified(): boolean {
    return false;
  }

  override isCreditOrDebitNote(): boolean {
    return false;
  }
}
