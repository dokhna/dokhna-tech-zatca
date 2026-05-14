/**
 * Unit tests — {@link issueStandardCreditNote}.
 */

import { describe, expect, it, vi } from "vitest";
import {
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "../invoices/_test-helpers.js";
import type { TenantScope } from "../types/storage.js";
import { makeMemoryStorage } from "./_memory-storage.js";
import { issueStandardCreditNote } from "./issue-standard-credit-note.js";

describe("issueStandardCreditNote", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues a standard credit note with buyer + cancelation", async () => {
    const { storage, log } = makeMemoryStorage();
    const keys = readTestKeys();
    const result = await issueStandardCreditNote({
      input: {
        kind: "standard-credit-note",
        issueDate: "2024-01-16",
        issueTime: "10:00:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            taxExclusivePrice: 100,
            name: "Service Refund",
          },
        ],
        buyerInfo: {
          registrationName: "Acme Buyer Co.",
          identityScheme: "CRN",
          identityNumber: "2020202020",
        },
        cancelation: makeTestCancelation("388"),
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
    });
    expect(result.invoiceXml).toContain("Acme Buyer Co.");
    expect(result.invoiceXml).toContain("<cac:BillingReference>");
    expect(log.getPreviousHash[0]?.kind).toBe("standard-credit-note");
  });

  it("calls storage.recordInvoice once with the expected record shape", async () => {
    const { storage } = makeMemoryStorage();
    const keys = readTestKeys();
    const recordSpy = vi.spyOn(storage, "recordInvoice");
    const fixedNow = new Date("2024-01-16T10:00:00.000Z");
    await issueStandardCreditNote({
      input: {
        kind: "standard-credit-note",
        issueDate: "2024-01-16",
        issueTime: "10:00:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            taxExclusivePrice: 100,
            name: "Service Refund",
          },
        ],
        buyerInfo: {
          registrationName: "Acme Buyer Co.",
          identityScheme: "CRN",
          identityNumber: "2020202020",
        },
        cancelation: makeTestCancelation("388"),
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
      invoiceId: "test-stdcn-id",
      now: () => fixedNow,
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        invoiceId: "test-stdcn-id",
        kind: "standard-credit-note",
        serial: "INV-0001",
        counterNumber: 1,
        uuid: egsInfo.uuid,
        invoiceHash: expect.any(String),
        previousInvoiceHash: expect.any(String),
        signedXml: expect.stringContaining("<ds:SignatureValue>"),
        qrBase64: expect.any(String),
        issuedAt: fixedNow,
        status: "pending",
      }),
    );
  });
});
