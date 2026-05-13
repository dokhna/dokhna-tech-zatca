/**
 * Unit tests — {@link issueSimplifiedCreditNote}.
 */

import { describe, expect, it, vi } from "vitest";
import type { TenantScope } from "../types/storage.js";
import {
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "../invoices/_test-helpers.js";
import { issueSimplifiedCreditNote } from "./issue-simplified-credit-note.js";
import { makeMemoryStorage } from "./_memory-storage.js";

describe("issueSimplifiedCreditNote", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues a credit note with cancelation block", async () => {
    const { storage, log } = makeMemoryStorage();
    const keys = readTestKeys();
    const result = await issueSimplifiedCreditNote({
      input: {
        kind: "simplified-credit-note",
        issueDate: "2024-01-16",
        issueTime: "09:00:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            name: "Refunded Coffee",
          },
        ],
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
    expect(result.invoiceXml).toContain("<cac:BillingReference>");
    expect(result.invoiceXml).toContain("<cac:PaymentMeans>");
    expect(log.getPreviousHash[0]?.kind).toBe("simplified-credit-note");
  });

  it("calls storage.recordInvoice once with the expected record shape", async () => {
    const { storage } = makeMemoryStorage();
    const keys = readTestKeys();
    const recordSpy = vi.spyOn(storage, "recordInvoice");
    const fixedNow = new Date("2024-01-16T09:00:00.000Z");
    await issueSimplifiedCreditNote({
      input: {
        kind: "simplified-credit-note",
        issueDate: "2024-01-16",
        issueTime: "09:00:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            name: "Refunded Coffee",
          },
        ],
        cancelation: makeTestCancelation("388"),
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
      invoiceId: "test-scn-id",
      now: () => fixedNow,
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        invoiceId: "test-scn-id",
        kind: "simplified-credit-note",
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
