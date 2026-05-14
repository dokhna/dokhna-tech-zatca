/**
 * Standard credit note builder.
 *
 * Shares arithmetic with the tax invoice family. Differs from the
 * simplified credit note only by the BR-KSA-06 subtype literal at the
 * template layer and the simplified / standard flag.
 */

import { populateStandardCreditNoteTemplate } from "../templates/standard-credit-note.js";
import type {
  StandardCreditNoteInput,
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

export class StandardCreditNoteBuilder extends BaseInvoiceBuilder<StandardCreditNoteInput> {
  protected override templateFn(input: StandardCreditNoteInput): string {
    return populateStandardCreditNoteTemplate(input);
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
    return ZATCA_INVOICE_TYPES.CREDIT_NOTE;
  }

  override isSimplified(): boolean {
    return false;
  }

  override isCreditOrDebitNote(): boolean {
    return true;
  }
}
