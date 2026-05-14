/**
 * Unit tests — {@link issueSimplifiedDebitNote}.
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
import { issueSimplifiedDebitNote } from "./issue-simplified-debit-note.js";

describe("issueSimplifiedDebitNote", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues a simplified debit note", async () => {
    const { storage, log } = makeMemoryStorage();
    const keys = readTestKeys();
    const result = await issueSimplifiedDebitNote({
      input: {
        kind: "simplified-debit-note",
        issueDate: "2024-01-17",
        issueTime: "11:00:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            name: "Adjustment",
          },
        ],
        cancelation: makeTestCancelation("383"),
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
    expect(log.getPreviousHash[0]?.kind).toBe("simplified-debit-note");
  });

  it("calls storage.recordInvoice once with the expected record shape", async () => {
    const { storage } = makeMemoryStorage();
    const keys = readTestKeys();
    const recordSpy = vi.spyOn(storage, "recordInvoice");
    const fixedNow = new Date("2024-01-17T11:00:00.000Z");
    await issueSimplifiedDebitNote({
      input: {
        kind: "simplified-debit-note",
        issueDate: "2024-01-17",
        issueTime: "11:00:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            name: "Adjustment",
          },
        ],
        cancelation: makeTestCancelation("383"),
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
      invoiceId: "test-sdn-id",
      now: () => fixedNow,
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        invoiceId: "test-sdn-id",
        kind: "simplified-debit-note",
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
