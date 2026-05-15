/**
 * Shared arithmetic helpers for simplified + standard debit notes.
 *
 * Debit notes differ from tax invoices / credit notes in three
 * places (verbatim from the legacy source classes):
 *
 * 1. Line-item `<cac:TaxTotal>` *nests* a `<cac:TaxSubtotal>`
 *    breakdown alongside `<cbc:TaxAmount>` instead of emitting
 *    `<cbc:RoundingAmount>`. The standard debit note adds the
 *    `<cbc:RoundingAmount>` back.
 * 2. `cac:AllowanceCharge` is emitted at the line-item top level
 *    only when there are discounts (handled by the
 *    `allowanceChargeAtLineTop` override on the builder).
 * 3. Invoice-level `<cac:TaxTotal>` is a *1-element* array (no KSA
 *    VAT roll-up) and `<cac:LegalMonetaryTotal>` formats every
 *    amount via `toFixedNoRounding(2)` strings (no `Number.parseFloat`
 *    coercion).
 */

import type { ZATCAInvoiceLineItem, ZATCAInvoiceLineItemTax } from "../types/invoice.js";
import type { XMLObject } from "../xml/document.js";
import type { LineItemTotals } from "./base.js";
import { toFixedNoRounding } from "./fixed-no-rounding.js";

/**
 * Builds the per-line totals for a debit note line.
 *
 * `withRoundingAmount = true` matches the *standard* debit note;
 * `false` matches the *simplified* variant.
 */
export function buildDebitNoteLineItemTotals(
  lineItem: ZATCAInvoiceLineItem,
  withRoundingAmount: boolean,
): LineItemTotals {
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
    const t: ZATCAInvoiceLineItemTax = otherTax;
    totalTaxes += Number.parseFloat(toFixedNoRounding((lineSubtotal * t.percentAmount) / 100, 2));
  }
  totalTaxes = Number.parseFloat(toFixedNoRounding(totalTaxes, 2));

  const cacTaxTotal: XMLObject = {
    "cbc:TaxAmount": {
      "@_currencyID": "SAR",
      "#text": toFixedNoRounding(totalTaxes, 2),
    },
  };

  if (withRoundingAmount) {
    cacTaxTotal["cbc:RoundingAmount"] = {
      "@_currencyID": "SAR",
      "#text": (
        Number.parseFloat(toFixedNoRounding(lineSubtotal, 2)) +
        Number.parseFloat(toFixedNoRounding(totalTaxes, 2))
      ).toFixed(2),
    };
  }

  const subtotalCategory: XMLObject = {
    "cbc:ID": {
      "@_schemeAgencyID": 6,
      "@_schemeID": "UN/ECE 5305",
      "#text": lineItem.vatPercent ? "S" : "O",
    },
    "cbc:Percent": toFixedNoRounding(lineItem.vatPercent, 2),
  };
  if (!lineItem.vatPercent) {
    subtotalCategory["cbc:TaxExemptionReason"] = "Not subject to VAT";
  }
  subtotalCategory["cac:TaxScheme"] = {
    "cbc:ID": {
      "@_schemeAgencyID": "6",
      "@_schemeID": "UN/ECE 5153",
      "#text": "VAT",
    },
  };

  cacTaxTotal["cac:TaxSubtotal"] = {
    "cbc:TaxableAmount": {
      "@_currencyID": "SAR",
      "#text": toFixedNoRounding(lineSubtotal, 2),
    },
    "cbc:TaxAmount": {
      "@_currencyID": "SAR",
      "#text": toFixedNoRounding((lineSubtotal * lineItem.vatPercent) / 100, 2),
    },
    "cac:TaxCategory": subtotalCategory,
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
 * Builds the invoice-level `<cac:TaxTotal>` array for debit notes.
 * One element — no KSA roll-up entry.
 */
export function buildDebitNoteTaxTotal(
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
      taxAmount = (otherTax.percentAmount * taxableAmount) / 100;
      pushSubtotal(taxableAmount, taxAmount, otherTax.percentAmount);
      totalTaxes += Number.parseFloat(toFixedNoRounding(taxAmount, 2));
    }
  }

  return [
    {
      "cbc:TaxAmount": {
        "@_currencyID": "SAR",
        "#text": toFixedNoRounding(totalTaxes, 2),
      },
      "cac:TaxSubtotal": taxSubtotals,
    },
  ];
}

/**
 * Builds the `<cac:LegalMonetaryTotal>` block for debit notes.
 * Every amount is rendered as a `toFixedNoRounding(2)` string.
 */
export function buildDebitNoteLegalMonetaryTotal(
  totalSubtotal: number,
  totalTaxes: number,
): XMLObject {
  const totalAmount = totalSubtotal + totalTaxes;
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
      "#text": toFixedNoRounding(totalAmount, 2),
    },
    "cbc:AllowanceTotalAmount": {
      "@_currencyID": "SAR",
      "#text": "0.00",
    },
    "cbc:PrepaidAmount": {
      "@_currencyID": "SAR",
      "#text": "0.00",
    },
    "cbc:PayableAmount": {
      "@_currencyID": "SAR",
      "#text": toFixedNoRounding(totalAmount, 2),
    },
  };
}
