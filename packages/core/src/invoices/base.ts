/**
 * `BaseInvoiceBuilder` — Template Method abstract.
 *
 * Encapsulates the 95% shared pipeline across the six concrete UBL
 * builder classes (simplified / standard × tax invoice / credit note /
 * debit note):
 *
 * 1. Fill the per-variant UBL template (`templateFn`).
 * 2. Parse the result through {@link XMLDocument}.
 * 3. Compute every line-item's totals, the invoice-level tax totals,
 *    and the legal monetary total via the per-variant arithmetic
 *    overrides.
 * 4. Inject the optional `<cac:PaymentMeans>` block when the input is
 *    a credit / debit note carrying a `cancelation`.
 * 5. Inject the buyer party for standard invoices carrying `buyerInfo`,
 *    or a minimal buyer-name fragment for simplified summary invoices.
 * 6. Run the crypto pipeline (`generateSignedXMLString`) — hashes,
 *    signs, builds the Phase 2 QR, injects the UBL signature
 *    extension, returns the signed XML.
 *
 * Subclasses override:
 *
 * - {@link templateFn}        — UBL template populator
 * - {@link parsedInput}       — zod-validated input narrowing
 * - {@link buildLineItemTotals} — per-line totals computation
 * - {@link buildTaxTotal}     — invoice-level tax-total array
 * - {@link buildLegalMonetaryTotal} — final totals block
 * - {@link includeInvoiceQuantityFraction} — debit notes format
 *                              `cbc:InvoicedQuantity` with two decimal
 *                              places; tax invoices / credit notes
 *                              emit the bare integer / float.
 *
 * The six concrete builder classes end up < 100 LOC each.
 */

import { generateSignedXMLString, type SignedXMLResult } from "../crypto/sign.js";
import { buildBuyerInfoXml } from "../issue/build-parties.js";
import type { Base64, InvoiceHash } from "../types/branded.js";
import { ZatcaSigningError } from "../types/errors.js";
import type {
  Phase1CreditNoteInput,
  Phase1InvoiceInput,
  SimplifiedCreditNoteInput,
  SimplifiedDebitNoteInput,
  SimplifiedTaxInvoiceInput,
  StandardCreditNoteInput,
  StandardDebitNoteInput,
  StandardTaxInvoiceInput,
  ZATCAInvoiceLineItem,
  ZatcaInvoiceType,
} from "../types/invoice.js";
import type { XMLObject } from "../xml/document.js";
import { XMLDocument } from "../xml/document.js";
import { toFixedNoRounding } from "./fixed-no-rounding.js";

/** Union of every Phase 2 input shape the abstract supports. */
export type Phase2InvoiceInput =
  | SimplifiedTaxInvoiceInput
  | StandardTaxInvoiceInput
  | SimplifiedCreditNoteInput
  | StandardCreditNoteInput
  | SimplifiedDebitNoteInput
  | StandardDebitNoteInput;

/** Phase 1 inputs — handled by a separate builder family. */
export type Phase1Input = Phase1InvoiceInput | Phase1CreditNoteInput;

/**
 * Signing artefacts required by every Phase 2 builder.
 *
 * The strings are PEM-encoded — base bodies-only stripping happens
 * inside the crypto pipeline.
 */
export interface BuilderParams {
  /** PEM-encoded X.509 certificate (compliance or production). */
  signingCertificatePem: string;
  /** PEM-encoded ECDSA secp256k1 private key. */
  signingPrivateKeyPem: string;
}

/**
 * Result of {@link BaseInvoiceBuilder.build}.
 *
 * - `invoiceXml`   — the pre-sign UBL XML (placeholders for QR +
 *                    extensions still present, but every field
 *                    substituted). Useful for debugging and golden
 *                    vector capture.
 * - `signedXml`    — the fully-signed UBL XML ready for submission.
 * - `invoiceHash`  — base64 SHA-256 of the canonicalised pre-sign
 *                    XML; this is the value the next document in the
 *                    chain reads back as its `previousInvoiceHash`.
 * - `qrCode`       — base64 TLV-encoded Phase 2 QR string.
 */
export interface BuiltInvoice {
  invoiceXml: string;
  signedXml: string;
  invoiceHash: InvoiceHash;
  qrCode: Base64;
}

/**
 * Per-line totals returned by {@link BaseInvoiceBuilder.buildLineItemTotals}.
 */
export interface LineItemTotals {
  /** Pre-built `<cac:AllowanceCharge>` fragments (zero or more). */
  cacAllowanceCharges: ReadonlyArray<XMLObject>;
  /** Pre-built `<cac:ClassifiedTaxCategory>` fragments. */
  cacClassifiedTaxCategories: ReadonlyArray<XMLObject>;
  /** Pre-built `<cac:TaxTotal>` fragment for this line item. */
  cacTaxTotal: XMLObject;
  /** Line subtotal after discounts, pre-tax. */
  lineItemTotalTaxExclusive: number;
  /** Line VAT (+ optional other-tax) total. */
  lineItemTotalTaxes: number;
  /** Sum of line-level discount amounts. */
  lineItemTotalDiscounts: number;
}

/**
 * Per-variant abstract.
 */
export abstract class BaseInvoiceBuilder<TInput extends Phase2InvoiceInput> {
  protected readonly input: TInput;

  constructor(input: TInput) {
    this.input = input;
  }

  /** Fills the UBL template for this variant. */
  protected abstract templateFn(input: TInput): string;

  /**
   * Computes line-item totals + the line-item `<cac:TaxTotal>`
   * fragment for one line. Concrete builders differ in whether they
   * emit `<cbc:RoundingAmount>` (tax invoices + credit notes +
   * standard debit note) or nest a `<cac:TaxSubtotal>` (simplified +
   * standard debit notes).
   */
  protected abstract buildLineItemTotals(lineItem: ZATCAInvoiceLineItem): LineItemTotals;

  /**
   * Returns the invoice-level `<cac:TaxTotal>` value — typically a
   * 2-element array of objects with `<cbc:TaxAmount>` (and an optional
   * `<cac:TaxSubtotal>` array on the first element). Simplified debit
   * notes return a 1-element array.
   */
  protected abstract buildTaxTotal(
    lineItems: ReadonlyArray<ZATCAInvoiceLineItem>,
  ): ReadonlyArray<XMLObject>;

  /**
   * Returns the invoice-level `<cac:LegalMonetaryTotal>` value.
   * Tax invoices + credit notes coerce numbers via `Number.parseFloat`;
   * debit notes use `toFixedNoRounding(2)` strings. The override on
   * each builder mirrors the legacy class's behaviour byte-for-byte.
   */
  protected abstract buildLegalMonetaryTotal(totalSubtotal: number, totalTaxes: number): XMLObject;

  /**
   * Whether `cbc:InvoicedQuantity` should be formatted with
   * `toFixedNoRounding(2)`. Debit notes set this to `true`.
   */
  protected includeInvoiceQuantityFraction(): boolean {
    return false;
  }

  /**
   * Whether `cbc:BaseQuantity` (with `unitCode="PCE"`, text `"1.00"`)
   * is emitted under `cac:Price`. Debit notes set this to `true`.
   */
  protected includePriceBaseQuantity(): boolean {
    return false;
  }

  /**
   * Whether allowance charges are emitted *only* when present
   * (debit-note convention). Tax invoices + credit notes always emit
   * the `cac:AllowanceCharge` array (possibly empty) under
   * `cac:Price`. Debit notes only emit it when non-empty, at the
   * line-item top level instead of under `cac:Price`.
   */
  protected allowanceChargeAtLineTop(): boolean {
    return false;
  }

  /**
   * Whether `cbc:PriceAmount` should be formatted with
   * `toFixedNoRounding(2)`. Debit notes set this to `true`.
   */
  protected formatPriceAmountText(): boolean {
    return false;
  }

  /**
   * Top-level orchestration. Sequence:
   *
   * 1. Render template + parse to {@link XMLDocument}.
   * 2. Inject buyer fragment if `buyerInfo` is present (standard
   *    invoices) or `buyerName` (simplified summary invoices) and the
   *    template variant uses an empty `<cac:AccountingCustomerParty>`.
   * 3. Compute every line item's totals + the corresponding XML
   *    fragment, accumulating invoice subtotals + tax totals.
   * 4. Inject `<cac:PaymentMeans>` if a cancelation is present.
   * 5. Inject the invoice-level tax totals + monetary totals.
   * 6. Append each line item under `<cac:InvoiceLine>`.
   * 7. Run the signing pipeline to produce the signed XML + Phase 2
   *    QR + invoice hash.
   *
   * Throws {@link ZatcaSigningError} when any sub-step fails (e.g.
   * malformed template, parser miss, signing failure).
   */
  build(params: BuilderParams): BuiltInvoice {
    const rawXml = this.templateFn(this.input);
    const doc = new XMLDocument(rawXml);

    this.injectBuyerParty(doc);

    let totalSubtotal = 0;
    let totalTaxes = 0;
    const lineItemXmlList: XMLObject[] = [];

    for (const lineItem of this.input.lineItems) {
      const totals = this.buildLineItemTotals(lineItem);
      const lineXml = this.assembleLineItemXml(lineItem, totals);
      lineItemXmlList.push(lineXml);
      totalSubtotal += Number.parseFloat(toFixedNoRounding(totals.lineItemTotalTaxExclusive, 2));
      totalTaxes += Number.parseFloat(toFixedNoRounding(totals.lineItemTotalTaxes, 2));
    }

    totalSubtotal = Number.parseFloat(totalSubtotal.toFixed(2));
    totalTaxes = Number.parseFloat(totalTaxes.toFixed(2));

    if (this.input.cancelation !== undefined) {
      doc.set("Invoice/cac:PaymentMeans", false, {
        "cbc:PaymentMeansCode": this.input.cancelation.paymentMethod,
        "cbc:InstructionNote": this.input.cancelation.reason,
      });
    }

    const taxTotalArray = this.buildTaxTotal(this.input.lineItems);
    for (const tt of taxTotalArray) {
      doc.set("Invoice/cac:TaxTotal", false, tt);
    }

    doc.set(
      "Invoice/cac:LegalMonetaryTotal",
      true,
      this.buildLegalMonetaryTotal(totalSubtotal, totalTaxes),
    );

    for (const lineXml of lineItemXmlList) {
      doc.set("Invoice/cac:InvoiceLine", false, lineXml);
    }

    const invoiceXml = doc.toString({ no_header: false });

    let signed: SignedXMLResult;
    try {
      signed = generateSignedXMLString({
        invoice_xml: doc,
        certificate_string: params.signingCertificatePem,
        private_key_string: params.signingPrivateKeyPem,
      });
    } catch (cause) {
      throw new ZatcaSigningError(
        "Failed to sign invoice XML in BaseInvoiceBuilder.build().",
        cause,
      );
    }

    return {
      invoiceXml,
      signedXml: signed.signed_invoice_string,
      invoiceHash: signed.invoice_hash,
      qrCode: signed.qr as unknown as Base64,
    };
  }

  /**
   * Builds the pre-sign XML only (no signing). Used by Phase 1
   * builders that share the template + line-item logic but skip the
   * crypto pipeline.
   */
  protected buildUnsignedDocument(): XMLDocument {
    const rawXml = this.templateFn(this.input);
    const doc = new XMLDocument(rawXml);
    this.injectBuyerParty(doc);

    let totalSubtotal = 0;
    let totalTaxes = 0;
    const lineItemXmlList: XMLObject[] = [];

    for (const lineItem of this.input.lineItems) {
      const totals = this.buildLineItemTotals(lineItem);
      const lineXml = this.assembleLineItemXml(lineItem, totals);
      lineItemXmlList.push(lineXml);
      totalSubtotal += Number.parseFloat(toFixedNoRounding(totals.lineItemTotalTaxExclusive, 2));
      totalTaxes += Number.parseFloat(toFixedNoRounding(totals.lineItemTotalTaxes, 2));
    }

    totalSubtotal = Number.parseFloat(totalSubtotal.toFixed(2));
    totalTaxes = Number.parseFloat(totalTaxes.toFixed(2));

    if (this.input.cancelation !== undefined) {
      doc.set("Invoice/cac:PaymentMeans", false, {
        "cbc:PaymentMeansCode": this.input.cancelation.paymentMethod,
        "cbc:InstructionNote": this.input.cancelation.reason,
      });
    }

    const taxTotalArray = this.buildTaxTotal(this.input.lineItems);
    for (const tt of taxTotalArray) {
      doc.set("Invoice/cac:TaxTotal", false, tt);
    }

    doc.set(
      "Invoice/cac:LegalMonetaryTotal",
      true,
      this.buildLegalMonetaryTotal(totalSubtotal, totalTaxes),
    );

    for (const lineXml of lineItemXmlList) {
      doc.set("Invoice/cac:InvoiceLine", false, lineXml);
    }

    return doc;
  }

  /**
   * Injects buyer party XML for standard invoices / credit / debit
   * notes that carry full `buyerInfo`. Simplified summary invoices
   * use the template's `SET_BUYER_INFO` substitution path and do not
   * need an injection step here, but if a `buyerInfo` is *also*
   * supplied (advanced caller), it overrides via `XMLDocument.set`.
   *
   * No-op for inputs without buyer data.
   */
  private injectBuyerParty(doc: XMLDocument): void {
    if (this.input.buyerInfo === undefined) {
      return;
    }
    const buyerXml = buildBuyerInfoXml(this.input.buyerInfo);
    doc.set("Invoice/cac:AccountingCustomerParty", true, buyerXml);
  }

  /**
   * Composes one `<cac:InvoiceLine>` XMLObject from the line-item
   * input + the per-line totals. Honours the four flag-overrides so
   * debit-note quirks (BaseQuantity, formatted quantity / price,
   * conditional allowance placement) can be expressed without
   * duplicating the entire method.
   */
  private assembleLineItemXml(lineItem: ZATCAInvoiceLineItem, totals: LineItemTotals): XMLObject {
    const quantityText = this.includeInvoiceQuantityFraction()
      ? toFixedNoRounding(lineItem.quantity, 2)
      : lineItem.quantity;

    const priceAmountText = this.formatPriceAmountText()
      ? toFixedNoRounding(lineItem.taxExclusivePrice, 2)
      : lineItem.taxExclusivePrice;

    const price: XMLObject = {
      "cbc:PriceAmount": {
        "@_currencyID": "SAR",
        "#text": priceAmountText,
      },
    };

    if (this.includePriceBaseQuantity()) {
      price["cbc:BaseQuantity"] = {
        "@_unitCode": "PCE",
        "#text": "1.00",
      };
    }

    if (!this.allowanceChargeAtLineTop()) {
      // Tax invoices + credit notes always carry an
      // `cac:AllowanceCharge` array under `cac:Price` — even if empty.
      price["cac:AllowanceCharge"] = totals.cacAllowanceCharges;
    }

    const lineXml: XMLObject = {
      "cbc:ID": lineItem.id,
      "cbc:InvoicedQuantity": {
        "@_unitCode": "PCE",
        "#text": quantityText,
      },
      "cbc:LineExtensionAmount": {
        "@_currencyID": "SAR",
        "#text": toFixedNoRounding(totals.lineItemTotalTaxExclusive, 2),
      },
      "cac:TaxTotal": totals.cacTaxTotal,
      "cac:Item": {
        "cbc:Name": lineItem.name,
        "cac:ClassifiedTaxCategory": totals.cacClassifiedTaxCategories,
      },
      "cac:Price": price,
    };

    if (this.allowanceChargeAtLineTop() && totals.cacAllowanceCharges.length > 0) {
      lineXml["cac:AllowanceCharge"] = totals.cacAllowanceCharges;
    }

    return lineXml;
  }

  /**
   * Subclasses expose the document-type-code (`388` / `381` / `383`)
   * — used by tests and the dispatcher for assertions.
   */
  abstract invoiceTypeCode(): ZatcaInvoiceType;

  /**
   * Subclasses report whether they emit the simplified BR-KSA-06
   * subtype literal (`name="0211010"` / `"0200000"`) or the standard
   * one (`name="0100000"`).
   */
  abstract isSimplified(): boolean;

  /** Subclasses report whether the variant is a credit or debit note. */
  abstract isCreditOrDebitNote(): boolean;
}
