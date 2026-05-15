/**
 * Shared per-variant arithmetic helpers.
 *
 * The four "invoice-like" Phase 2 variants (simplified / standard tax
 * invoice, simplified / standard credit note) compute line-item
 * totals, invoice-level `<cac:TaxTotal>` arrays, and the legal
 * monetary total identically — the legacy source files are
 * byte-equal modulo the template + class names. Extracted here.
 *
 * The two debit-note variants share a *different* arithmetic shape
 * (line-item `<cac:TaxTotal>` nests a `<cac:TaxSubtotal>`, no
 * `<cbc:RoundingAmount>` on simplified, line-top `cac:AllowanceCharge`,
 * formatted quantity / price). Their helpers live in
 * `./shared-debit-note-arithmetic.ts`.
 *
 * All math intentionally mirrors the legacy classes verbatim — same
 * order of operations, same `toFixedNoRounding(2)` boundaries — so
 * byte-identical numeric formatting is preserved for the captured
 * golden vectors.
 */

import type { ZATCAInvoiceLineItem, ZATCAInvoiceLineItemTax } from "../types/invoice.js";
import type { XMLObject } from "../xml/document.js";
import type { LineItemTotals } from "./base.js";
import { toFixedNoRounding } from "./fixed-no-rounding.js";

/**
 * Builds the per-line totals for a tax invoice / credit note line.
 *
 * Matches the legacy helper's `constructLineItemTotals` for the four
 * "invoice-like" classes:
 *
 * - `cac:ClassifiedTaxCategory` is an array starting with the VAT
 *   entry and appending each non-VAT tax.
 * - `cac:AllowanceCharge` is one per discount.
 * - `cacTaxTotal` emits `<cbc:TaxAmount>` + `<cbc:RoundingAmount>`
 *   (no nested `<cac:TaxSubtotal>`).
 */
export function buildInvoiceLineItemTotals(lineItem: ZATCAInvoiceLineItem): LineItemTotals {
  let totalDiscounts = 0;
  let totalTaxes = 0;
  const allowanceCharges: XMLObject[] = [];
  const classifiedTaxCategories: XMLObject[] = [];

  const vatEntry: XMLObject = {
    "cbc:ID": lineItem.vatPercent ? "S" : "O",
  };
  if (lineItem.vatPercent) {
    vatEntry["cbc:Percent"] = toFixedNoRounding(lineItem.vatPercent, 2);
  }
  vatEntry["cac:TaxScheme"] = { "cbc:ID": "VAT" };
  classifiedTaxCategories.push(vatEntry);

  for (const discount of lineItem.discounts ?? []) {
    totalDiscounts += discount.amount;
    allowanceCharges.push({
      "cbc:ChargeIndicator": "false",
      "cbc:AllowanceChargeReason": discount.reason,
      "cbc:Amount": {
        "@_currencyID": "SAR",
        "#text": toFixedNoRounding(discount.amount, 2),
      },
    });
  }

  let lineSubtotal = lineItem.taxExclusivePrice * lineItem.quantity - totalDiscounts;
  lineSubtotal = Number.parseFloat(toFixedNoRounding(lineSubtotal, 2));

  totalTaxes =
    Number.parseFloat(toFixedNoRounding(totalTaxes, 2)) +
    Number.parseFloat(toFixedNoRounding((lineSubtotal * lineItem.vatPercent) / 100, 2));
  totalTaxes = Number.parseFloat(toFixedNoRounding(totalTaxes, 2));

  for (const otherTax of lineItem.otherTaxes ?? []) {
    totalTaxes =
      Number.parseFloat(toFixedNoRounding(totalTaxes, 2)) +
      Number.parseFloat(toFixedNoRounding((otherTax.percentAmount * lineSubtotal) / 100, 2));
    totalTaxes = Number.parseFloat(toFixedNoRounding(totalTaxes, 2));
    classifiedTaxCategories.push({
      "cbc:ID": "S",
      "cbc:Percent": toFixedNoRounding(otherTax.percentAmount, 2),
      "cac:TaxScheme": { "cbc:ID": "VAT" },
    });
  }

  const cacTaxTotal: XMLObject = {
    "cbc:TaxAmount": {
      "@_currencyID": "SAR",
      "#text": toFixedNoRounding(totalTaxes, 2),
    },
    "cbc:RoundingAmount": {
      "@_currencyID": "SAR",
      "#text": (
        Number.parseFloat(toFixedNoRounding(lineSubtotal, 2)) +
        Number.parseFloat(toFixedNoRounding(totalTaxes, 2))
      ).toFixed(2),
    },
  };

  return {
    cacAllowanceCharges: allowanceCharges,
    cacClassifiedTaxCategories: classifiedTaxCategories,
    cacTaxTotal,
    lineItemTotalTaxExclusive: lineSubtotal,
    lineItemTotalTaxes: totalTaxes,
    lineItemTotalDiscounts: totalDiscounts,
  };
}

/**
 * Builds the invoice-level `<cac:TaxTotal>` array for tax invoices /
 * credit notes. Returns a 2-element array: the first carries the
 * sub-total breakdown, the second is the KSA-VAT roll-up.
 *
 * Matches the legacy helper's `constructTaxTotal` for the four "invoice-like"
 * classes.
 */
export function buildInvoiceTaxTotal(
  lineItems: ReadonlyArray<ZATCAInvoiceLineItem>,
): ReadonlyArray<XMLObject> {
  const taxSubtotals: XMLObject[] = [];

  function pushSubtotal(taxableAmount: number, taxAmount: number, taxPercent: number): void {
    taxSubtotals.push({
      "cbc:TaxableAmount": {
        "@_currencyID": "SAR",
        "#text": toFixedNoRounding(taxableAmount, 2),
      },
      "cbc:TaxAmount": {
        "@_currencyID": "SAR",
        "#text": toFixedNoRounding(taxAmount, 2),
      },
      "cac:TaxCategory": {
        "cbc:ID": {
          "@_schemeAgencyID": 6,
          "@_schemeID": "UN/ECE 5305",
          "#text": taxPercent ? "S" : "O",
        },
        "cbc:Percent": toFixedNoRounding(taxPercent, 2),
        ...(taxPercent ? {} : { "cbc:TaxExemptionReason": "Not subject to VAT" }),
        "cac:TaxScheme": {
          "cbc:ID": {
            "@_schemeAgencyID": "6",
            "@_schemeID": "UN/ECE 5153",
            "#text": "VAT",
          },
        },
      },
    });
  }

  let totalTaxes = 0;
  for (const lineItem of lineItems) {
    const lineDiscounts = lineItem.discounts?.reduce<number>((p, c) => p + c.amount, 0) ?? 0;
    const taxableAmount = lineItem.taxExclusivePrice * lineItem.quantity - lineDiscounts;
    let taxAmount = (lineItem.vatPercent * taxableAmount) / 100;
    pushSubtotal(taxableAmount, taxAmount, lineItem.vatPercent);
    totalTaxes += Number.parseFloat(toFixedNoRounding(taxAmount, 2));
    for (const otherTax of lineItem.otherTaxes ?? []) {
      const t: ZATCAInvoiceLineItemTax = otherTax;
      taxAmount = (t.percentAmount * taxableAmount) / 100;
      pushSubtotal(taxableAmount, taxAmount, t.percentAmount);
      totalTaxes += Number.parseFloat(toFixedNoRounding(taxAmount, 2));
    }
  }

  totalTaxes = Number.parseFloat(totalTaxes.toFixed(2));

  return [
    {
      "cbc:TaxAmount": {
        "@_currencyID": "SAR",
        "#text": toFixedNoRounding(totalTaxes, 2),
      },
      "cac:TaxSubtotal": taxSubtotals,
    },
    {
      "cbc:TaxAmount": {
        "@_currencyID": "SAR",
        "#text": toFixedNoRounding(totalTaxes, 2),
      },
    },
  ];
}

/**
 * Builds the `<cac:LegalMonetaryTotal>` block for tax invoices /
 * credit notes. Numbers are coerced via `Number.parseFloat(...toFixed(2))`
 * so the `TaxInclusive` / `PayableAmount` values emit as bare floats
 * (no trailing zero) when their two-decimal representation has no
 * fractional remainder — exactly what the captured golden vectors show.
 */
export function buildInvoiceLegalMonetaryTotal(
  totalSubtotal: number,
  totalTaxes: number,
): XMLObject {
  return {
    "cbc:LineExtensionAmount": {
      "@_currencyID": "SAR",
      "#text": toFixedNoRounding(totalSubtotal, 2),
    },
    "cbc:TaxExclusiveAmount": {
      "@_currencyID": "SAR",
      "#text": toFixedNoRounding(totalSubtotal, 2),
    },
    "cbc:TaxInclusiveAmount": {
      "@_currencyID": "SAR",
      "#text": Number.parseFloat((totalSubtotal + totalTaxes).toFixed(2)),
    },
    "cbc:AllowanceTotalAmount": {
      "@_currencyID": "SAR",
      "#text": 0,
    },
    "cbc:PrepaidAmount": {
      "@_currencyID": "SAR",
      "#text": 0,
    },
    "cbc:PayableAmount": {
      "@_currencyID": "SAR",
      "#text": Number.parseFloat((totalSubtotal + totalTaxes).toFixed(2)),
    },
  };
}
