/**
 * Unit tests — {@link issueSimplifiedTaxInvoice}.
 *
 * Validates the storage handshake (counter increment + previous-hash
 * read), the builder hand-off, and the result-shape contract. Uses
 * the in-memory storage double — no real persistence needed.
 */

import { describe, expect, it } from "vitest";
import type { TenantScope } from "../types/storage.js";
import {
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "../invoices/_test-helpers.js";
import { issueSimplifiedTaxInvoice } from "./issue-simplified-invoice.js";
import { makeMemoryStorage } from "./_memory-storage.js";

describe("issueSimplifiedTaxInvoice", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues an invoice and increments the counter once", async () => {
    const { storage, log } = makeMemoryStorage();
    const keys = readTestKeys();
    const result = await issueSimplifiedTaxInvoice({
      input: {
        kind: "simplified-tax-invoice",
        issueDate: "2024-01-15",
        issueTime: "14:30:45Z",
        lineItems: [makeTestLineItem()],
        buyerName: "Walk-in Customer",
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
    expect(result.invoiceNumber).toBe("INV-0001");
    expect(result.invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(result.signedXml).toContain("<ds:SignatureValue>");
    expect(log.incrementCounter).toBe(1);
    expect(log.getPreviousHash[0]?.kind).toBe("simplified-tax-invoice");
  });

  it("monotonically increments the sequence across multiple invoices", async () => {
    const { storage } = makeMemoryStorage();
    const keys = readTestKeys();
    const first = await issueSimplifiedTaxInvoice({
      input: {
        kind: "simplified-tax-invoice",
        issueDate: "2024-01-15",
        issueTime: "14:30:45Z",
        lineItems: [makeTestLineItem()],
        buyerName: "Customer A",
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
    });
    const second = await issueSimplifiedTaxInvoice({
      input: {
        kind: "simplified-tax-invoice",
        issueDate: "2024-01-15",
        issueTime: "14:31:00Z",
        lineItems: [makeTestLineItem()],
        buyerName: "Customer B",
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
    });
    expect(second.sequence).toBe(first.sequence + 1);
  });

  it("throws ZatcaValidationError when scope does not match egsInfo", async () => {
    const { storage } = makeMemoryStorage();
    const keys = readTestKeys();
    await expect(() =>
      issueSimplifiedTaxInvoice({
        input: {
          kind: "simplified-tax-invoice",
          issueDate: "2024-01-15",
          issueTime: "14:30:45Z",
          lineItems: [makeTestLineItem()],
          buyerName: "X",
        },
        egsInfo,
        storage,
        scope: { ...scope, egsUuid: "00000000-0000-4000-8000-000000000000" as typeof scope.egsUuid },
        signing: {
          certificate: keys.signingCertificatePem,
          privateKey: keys.signingPrivateKeyPem,
        },
      }),
    ).rejects.toThrowError(/does not match/);
  });
});
