/**
 * Simplified tax invoice builder.
 *
 * Concrete subclass of {@link BaseInvoiceBuilder} for the
 * `simplified-tax-invoice` variant. Wires the per-variant template
 * populator + the shared tax-invoice arithmetic helpers.
 */

import type {
  SimplifiedTaxInvoiceInput,
  ZATCAInvoiceLineItem,
  ZatcaInvoiceType,
} from "../types/invoice.js";
import { ZATCA_INVOICE_TYPES } from "../types/invoice.js";
import type { XMLObject } from "../xml/document.js";
import { populateSimplifiedTaxInvoiceTemplate } from "../templates/simplified-tax-invoice.js";
import {
  BaseInvoiceBuilder,
  type LineItemTotals,
} from "./base.js";
import {
  buildInvoiceLegalMonetaryTotal,
  buildInvoiceLineItemTotals,
  buildInvoiceTaxTotal,
} from "./shared-tax-arithmetic.js";

export class SimplifiedTaxInvoiceBuilder extends BaseInvoiceBuilder<SimplifiedTaxInvoiceInput> {
  protected override templateFn(input: SimplifiedTaxInvoiceInput): string {
    return populateSimplifiedTaxInvoiceTemplate(input);
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
    return ZATCA_INVOICE_TYPES.INVOICE;
  }

  override isSimplified(): boolean {
    return true;
  }

  override isCreditOrDebitNote(): boolean {
    return false;
  }
}
