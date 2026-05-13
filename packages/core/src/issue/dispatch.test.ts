/**
 * Unit tests — {@link issueInvoice}.
 *
 * Exercises every `kind` of the {@link InvoiceInput} union to confirm
 * the dispatcher routes correctly. Each case asserts a discriminator
 * we can observe in the produced XML (subtype literal + invoice-type
 * code) so the routing is verifiable without spying on the issuer
 * implementations.
 */

import { describe, expect, it } from "vitest";
import type { InvoiceInput } from "../types/invoice.js";
import type { TenantScope } from "../types/storage.js";
import type { InvoiceHash } from "../types/branded.js";
import { XMLDocument } from "../xml/document.js";
import {
  BASE_PIH,
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "../invoices/_test-helpers.js";
import { issueInvoice } from "./dispatch.js";
import { makeMemoryStorage } from "./_memory-storage.js";

const egsInfo = makeTestEgsInfo();
const scope: TenantScope = {
  vatNumber: egsInfo.vatNumber,
  egsUuid: egsInfo.uuid,
};

const PLACEHOLDER_CTX = {
  egsInfo,
  invoiceCounterNumber: 0,
  invoiceSerialNumber: "PLACEHOLDER",
  issueDate: "2024-01-15",
  issueTime: "14:30:45Z",
  previousInvoiceHash: BASE_PIH as InvoiceHash,
} as const;

function makeAllVariants(): InvoiceInput[] {
  return [
    {
      ...PLACEHOLDER_CTX,
      kind: "simplified-tax-invoice",
      lineItems: [makeTestLineItem()],
      buyerName: "Walk-in Customer",
    },
    {
      ...PLACEHOLDER_CTX,
      kind: "standard-tax-invoice",
      lineItems: [{ ...makeTestLineItem(), quantity: 1, taxExclusivePrice: 100, name: "Service Fee" }],
      buyerInfo: {
        registrationName: "Acme Buyer Co.",
        identityScheme: "CRN",
        identityNumber: "2020202020",
      },
    },
    {
      ...PLACEHOLDER_CTX,
      kind: "simplified-credit-note",
      lineItems: [makeTestLineItem()],
      cancelation: makeTestCancelation("388"),
    },
    {
      ...PLACEHOLDER_CTX,
      kind: "standard-credit-note",
      lineItems: [{ ...makeTestLineItem(), quantity: 1, taxExclusivePrice: 100, name: "Refund" }],
      buyerInfo: {
        registrationName: "Acme Buyer Co.",
        identityScheme: "CRN",
        identityNumber: "2020202020",
      },
      cancelation: makeTestCancelation("388"),
    },
    {
      ...PLACEHOLDER_CTX,
      kind: "simplified-debit-note",
      lineItems: [makeTestLineItem()],
      cancelation: makeTestCancelation("383"),
    },
    {
      ...PLACEHOLDER_CTX,
      kind: "standard-debit-note",
      lineItems: [{ ...makeTestLineItem(), quantity: 1, taxExclusivePrice: 50, name: "Adjustment" }],
      buyerInfo: {
        registrationName: "Acme Buyer Co.",
        identityScheme: "CRN",
        identityNumber: "2020202020",
      },
      cancelation: makeTestCancelation("383"),
    },
    {
      ...PLACEHOLDER_CTX,
      kind: "phase1-invoice",
      lineItems: [makeTestLineItem()],
      buyerName: "Walk-in Customer",
    },
    {
      ...PLACEHOLDER_CTX,
      kind: "phase1-credit-note",
      lineItems: [makeTestLineItem()],
      buyerName: "Walk-in Customer",
      cancelation: makeTestCancelation("381"),
    },
  ];
}

interface InvoiceTypeCodeNode {
  "@_name"?: string;
  "#text"?: string;
}

function readInvoiceTypeCode(xml: string): InvoiceTypeCodeNode {
  const doc = new XMLDocument(xml);
  const node = doc.get("Invoice/cbc:InvoiceTypeCode")?.[0] as
    | InvoiceTypeCodeNode
    | undefined;
  return node ?? {};
}

describe("issueInvoice — discriminated-union dispatch", () => {
  it("routes each kind to the correct builder (8 variants)", async () => {
    const keys = readTestKeys();
    for (const variant of makeAllVariants()) {
      const { storage } = makeMemoryStorage();
      const result = await issueInvoice({
        input: variant,
        storage,
        scope,
        signing: {
          certificate: keys.signingCertificatePem,
          privateKey: keys.signingPrivateKeyPem,
        },
      });
      const code = readInvoiceTypeCode(result.invoiceXml);
      switch (variant.kind) {
        case "simplified-tax-invoice":
          expect(code["@_name"]).toBe("0211010");
          expect(code["#text"]).toBe("388");
          break;
        case "standard-tax-invoice":
          expect(code["@_name"]).toBe("0100000");
          expect(code["#text"]).toBe("388");
          break;
        case "simplified-credit-note":
          expect(code["@_name"]).toBe("0200000");
          expect(code["#text"]).toBe("388");
          break;
        case "standard-credit-note":
          expect(code["@_name"]).toBe("0100000");
          expect(code["#text"]).toBe("388");
          break;
        case "simplified-debit-note":
          expect(code["@_name"]).toBe("0200000");
          expect(code["#text"]).toBe("383");
          break;
        case "standard-debit-note":
          expect(code["@_name"]).toBe("0100000");
          expect(code["#text"]).toBe("383");
          break;
        case "phase1-invoice":
          expect(code["#text"]).toBe("388");
          break;
        case "phase1-credit-note":
          expect(code["#text"]).toBe("381");
          break;
      }
    }
  });

  it("throws ZatcaValidationError when Phase 2 kind has no signing key", async () => {
    const { storage } = makeMemoryStorage();
    await expect(() =>
      issueInvoice({
        input: {
          ...PLACEHOLDER_CTX,
          kind: "simplified-tax-invoice",
          lineItems: [makeTestLineItem()],
          buyerName: "X",
        },
        storage,
        scope,
      }),
    ).rejects.toThrowError(/requires signing/);
  });
});
