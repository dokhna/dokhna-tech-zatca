/**
 * Unit tests — {@link issuePhase1Invoice}.
 */

import { describe, expect, it, vi } from "vitest";
import { makeTestEgsInfo, makeTestLineItem } from "../invoices/_test-helpers.js";
import type { TenantScope } from "../types/storage.js";
import { makeMemoryStorage } from "./_memory-storage.js";
import { issuePhase1Invoice } from "./issue-phase1-invoice.js";

describe("issuePhase1Invoice", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues a Phase 1 invoice with QR but no signedXml / invoiceHash", async () => {
    const { storage, log } = makeMemoryStorage();
    const result = await issuePhase1Invoice({
      input: {
        kind: "phase1-invoice",
        issueDate: "2024-02-01",
        issueTime: "10:00:00Z",
        lineItems: [makeTestLineItem()],
        buyerName: "Walk-in Customer",
      },
      egsInfo,
      storage,
      scope,
    });
    expect(result.sequence).toBe(1);
    expect(result.invoiceNumber).toBe("INV-0001");
    expect(result.qrCode.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("signedXml");
    expect(result).not.toHaveProperty("invoiceHash");
    // Phase 1 does not consult the hash chain.
    expect(log.getPreviousHash).toEqual([]);
  });

  it("calls storage.recordInvoice once with the expected record shape", async () => {
    const { storage } = makeMemoryStorage();
    const recordSpy = vi.spyOn(storage, "recordInvoice");
    const fixedNow = new Date("2024-02-01T10:00:00.000Z");
    const BASE_PIH =
      "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";
    await issuePhase1Invoice({
      input: {
        kind: "phase1-invoice",
        issueDate: "2024-02-01",
        issueTime: "10:00:00Z",
        lineItems: [makeTestLineItem()],
        buyerName: "Walk-in Customer",
      },
      egsInfo,
      storage,
      scope,
      invoiceId: "test-p1inv-id",
      now: () => fixedNow,
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        invoiceId: "test-p1inv-id",
        kind: "phase1-invoice",
        serial: "INV-0001",
        counterNumber: 1,
        uuid: egsInfo.uuid,
        invoiceHash: BASE_PIH,
        previousInvoiceHash: BASE_PIH,
        signedXml: expect.any(String),
        qrBase64: expect.any(String),
        issuedAt: fixedNow,
        status: "pending",
      }),
    );
  });
});
