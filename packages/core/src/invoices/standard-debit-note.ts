/**
 * Standard debit note builder.
 *
 * Uses the debit-note arithmetic family. The line-item
 * `<cac:TaxTotal>` adds `<cbc:RoundingAmount>` versus the simplified
 * variant.
 */

import { populateStandardDebitNoteTemplate } from "../templates/standard-debit-note.js";
import type {
  StandardDebitNoteInput,
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

export class StandardDebitNoteBuilder extends BaseInvoiceBuilder<StandardDebitNoteInput> {
  protected override templateFn(input: StandardDebitNoteInput): string {
    return populateStandardDebitNoteTemplate(input);
  }

  protected override buildLineItemTotals(lineItem: ZATCAInvoiceLineItem): LineItemTotals {
    return buildDebitNoteLineItemTotals(lineItem, true);
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
    return false;
  }

  override isCreditOrDebitNote(): boolean {
    return true;
  }
}
