/**
 * Unit tests — {@link issueStandardTaxInvoice}.
 */

import { describe, expect, it, vi } from "vitest";
import type { TenantScope } from "../types/storage.js";
import {
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "../invoices/_test-helpers.js";
import { issueStandardTaxInvoice } from "./issue-standard-invoice.js";
import { makeMemoryStorage } from "./_memory-storage.js";

describe("issueStandardTaxInvoice", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues a standard invoice and emits the buyer party block", async () => {
    const { storage, log } = makeMemoryStorage();
    const keys = readTestKeys();
    const result = await issueStandardTaxInvoice({
      input: {
        kind: "standard-tax-invoice",
        issueDate: "2024-01-15",
        issueTime: "14:31:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            taxExclusivePrice: 100,
            name: "Service Fee",
          },
        ],
        buyerInfo: {
          registrationName: "Acme Buyer Co.",
          identityScheme: "CRN",
          identityNumber: "2020202020",
        },
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
    });
    expect(result.sequence).toBe(1);
    expect(result.invoiceXml).toContain("Acme Buyer Co.");
    expect(log.getPreviousHash[0]?.kind).toBe("standard-tax-invoice");
  });

  it("calls storage.recordInvoice once with the expected record shape", async () => {
    const { storage } = makeMemoryStorage();
    const keys = readTestKeys();
    const recordSpy = vi.spyOn(storage, "recordInvoice");
    const fixedNow = new Date("2024-01-15T14:31:00.000Z");
    await issueStandardTaxInvoice({
      input: {
        kind: "standard-tax-invoice",
        issueDate: "2024-01-15",
        issueTime: "14:31:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            taxExclusivePrice: 100,
            name: "Service Fee",
          },
        ],
        buyerInfo: {
          registrationName: "Acme Buyer Co.",
          identityScheme: "CRN",
          identityNumber: "2020202020",
        },
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
      invoiceId: "test-std-id",
      now: () => fixedNow,
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        invoiceId: "test-std-id",
        kind: "standard-tax-invoice",
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
