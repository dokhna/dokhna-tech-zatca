/**
 * Unit tests — {@link issuePhase1CreditNote}.
 */

import { describe, expect, it, vi } from "vitest";
import {
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
} from "../invoices/_test-helpers.js";
import type { TenantScope } from "../types/storage.js";
import { makeMemoryStorage } from "./_memory-storage.js";
import { issuePhase1CreditNote } from "./issue-phase1-credit-note.js";

describe("issuePhase1CreditNote", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues a Phase 1 credit note with cancelation reference", async () => {
    const { storage } = makeMemoryStorage();
    const result = await issuePhase1CreditNote({
      input: {
        kind: "phase1-credit-note",
        issueDate: "2024-02-02",
        issueTime: "11:00:00Z",
        lineItems: [makeTestLineItem()],
        buyerName: "Walk-in Customer",
        cancelation: makeTestCancelation("381"),
      },
      egsInfo,
      storage,
      scope,
    });
    expect(result.sequence).toBe(1);
    expect(result.invoiceXml).toContain("<cac:BillingReference>");
    expect(result.invoiceXml).toContain("<cbc:ID>1</cbc:ID>");
  });

  it("calls storage.recordInvoice once with the expected record shape", async () => {
    const { storage } = makeMemoryStorage();
    const recordSpy = vi.spyOn(storage, "recordInvoice");
    const fixedNow = new Date("2024-02-02T11:00:00.000Z");
    const BASE_PIH =
      "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";
    await issuePhase1CreditNote({
      input: {
        kind: "phase1-credit-note",
        issueDate: "2024-02-02",
        issueTime: "11:00:00Z",
        lineItems: [makeTestLineItem()],
        buyerName: "Walk-in Customer",
        cancelation: makeTestCancelation("381"),
      },
      egsInfo,
      storage,
      scope,
      invoiceId: "test-p1cn-id",
      now: () => fixedNow,
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        invoiceId: "test-p1cn-id",
        kind: "phase1-credit-note",
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
