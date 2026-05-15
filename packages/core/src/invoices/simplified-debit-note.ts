/**
 * Simplified debit note builder.
 *
 * Uses the debit-note arithmetic family. Differs from the standard
 * debit note in that the line-item `<cac:TaxTotal>` does NOT include
 * a `<cbc:RoundingAmount>` element (matches the legacy class
 * verbatim).
 */

import { populateSimplifiedDebitNoteTemplate } from "../templates/simplified-debit-note.js";
import type {
  SimplifiedDebitNoteInput,
  ZATCAInvoiceLineItem,
  ZatcaInvoiceType,
} from "../types/invoice.js";
import { ZATCA_INVOICE_TYPES } from "../types/invoice.js";
import type { XMLObject } from "../xml/document.js";
import { BaseInvoiceBuilder, type LineItemTotals } from "./base.js";
import {
  buildDebitNoteLegalMonetaryTotal,
  buildDebitNoteLineItemTotals,
  buildDebitNoteTaxTotal,
} from "./shared-debit-note-arithmetic.js";

export class SimplifiedDebitNoteBuilder extends BaseInvoiceBuilder<SimplifiedDebitNoteInput> {
  protected override templateFn(input: SimplifiedDebitNoteInput): string {
    return populateSimplifiedDebitNoteTemplate(input);
  }

  protected override buildLineItemTotals(lineItem: ZATCAInvoiceLineItem): LineItemTotals {
    return buildDebitNoteLineItemTotals(lineItem, false);
  }

  protected override buildTaxTotal(
    lineItems: ReadonlyArray<ZATCAInvoiceLineItem>,
  ): ReadonlyArray<XMLObject> {
    return buildDebitNoteTaxTotal(lineItems);
  }

  protected override buildLegalMonetaryTotal(totalSubtotal: number, totalTaxes: number): XMLObject {
    return buildDebitNoteLegalMonetaryTotal(totalSubtotal, totalTaxes);
  }

  protected override includeInvoiceQuantityFraction(): boolean {
    return true;
  }

  protected override includePriceBaseQuantity(): boolean {
    return true;
  }

  protected override allowanceChargeAtLineTop(): boolean {
    return true;
  }

  protected override formatPriceAmountText(): boolean {
    return true;
  }

  override invoiceTypeCode(): ZatcaInvoiceType {
    return ZATCA_INVOICE_TYPES.DEBIT_NOTE;
  }

  override isSimplified(): boolean {
    return true;
  }

  override isCreditOrDebitNote(): boolean {
    return true;
  }
}
