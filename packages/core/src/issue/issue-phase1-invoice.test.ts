/**
 * Unit tests — {@link issuePhase1Invoice}.
 */

import { describe, expect, it } from "vitest";
import type { TenantScope } from "../types/storage.js";
import {
  makeTestEgsInfo,
  makeTestLineItem,
} from "../invoices/_test-helpers.js";
import { issuePhase1Invoice } from "./issue-phase1-invoice.js";
import { makeMemoryStorage } from "./_memory-storage.js";

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
});
