/**
 * `BaseInvoiceBuilder` direct tests.
 *
 * Exercises the template-method dispatch by sub-classing the
 * abstract with a deliberately-trivial implementation and asserting
 * the orchestrator wires every step in the right order. Per-variant
 * arithmetic and template parity are covered in the six concrete
 * `*.test.ts` files; this file isolates the *base class* contract.
 */

import { describe, expect, it } from "vitest";
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
import {
  BASE_PIH,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "./_test-helpers.js";

class SpyBuilder extends BaseInvoiceBuilder<SimplifiedTaxInvoiceInput> {
  public calls: string[] = [];

  protected override templateFn(input: SimplifiedTaxInvoiceInput): string {
    this.calls.push("templateFn");
    return populateSimplifiedTaxInvoiceTemplate(input);
  }

  protected override buildLineItemTotals(
    lineItem: ZATCAInvoiceLineItem,
  ): LineItemTotals {
    this.calls.push("buildLineItemTotals");
    return buildInvoiceLineItemTotals(lineItem);
  }

  protected override buildTaxTotal(
    lineItems: ReadonlyArray<ZATCAInvoiceLineItem>,
  ): ReadonlyArray<XMLObject> {
    this.calls.push("buildTaxTotal");
    return buildInvoiceTaxTotal(lineItems);
  }

  protected override buildLegalMonetaryTotal(
    totalSubtotal: number,
    totalTaxes: number,
  ): XMLObject {
    this.calls.push("buildLegalMonetaryTotal");
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

function makeInput(): SimplifiedTaxInvoiceInput {
  return {
    kind: "simplified-tax-invoice",
    egsInfo: makeTestEgsInfo(),
    invoiceCounterNumber: 1,
    invoiceSerialNumber: "INV-0001",
    issueDate: "2024-01-15",
    issueTime: "14:30:45Z",
    previousInvoiceHash: BASE_PIH,
    lineItems: [makeTestLineItem()],
    buyerName: "Walk-in Customer",
  };
}

describe("BaseInvoiceBuilder template-method dispatch", () => {
  it("invokes the four abstract hooks in deterministic order", () => {
    const b = new SpyBuilder(makeInput());
    b.build(readTestKeys());
    // For a single-line invoice we expect:
    //   templateFn  → buildLineItemTotals  → buildTaxTotal  → buildLegalMonetaryTotal
    expect(b.calls).toStrictEqual([
      "templateFn",
      "buildLineItemTotals",
      "buildTaxTotal",
      "buildLegalMonetaryTotal",
    ]);
  });

  it("returns a BuiltInvoice with valid hash + base64 QR + non-empty signed XML", () => {
    const b = new SpyBuilder(makeInput());
    const out = b.build(readTestKeys());
    expect(out.invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(out.signedXml).toContain("<ds:SignatureValue>");
    expect(out.signedXml).toContain("<ext:UBLExtensions>");
    expect(out.qrCode.length).toBeGreaterThan(0);
    // Base64 round-trip sanity.
    expect(Buffer.from(out.qrCode, "base64").length).toBeGreaterThan(0);
  });

  it("invoiceTypeCode / isSimplified / isCreditOrDebitNote expose correct discriminators", () => {
    const b = new SpyBuilder(makeInput());
    expect(b.invoiceTypeCode()).toBe("388");
    expect(b.isSimplified()).toBe(true);
    expect(b.isCreditOrDebitNote()).toBe(false);
  });
});
