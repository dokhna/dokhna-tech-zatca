/**
 * Unit tests — internal in-memory storage adapter used by the
 * compliance runner. Verifies the contract surface so the runner's
 * default storage cannot regress.
 */

import { describe, expect, it } from "vitest";
import type { InvoiceHash } from "../types/branded.js";
import type { EGSUuid, VATNumber } from "../types/branded.js";
import { ZatcaStorageError } from "../types/errors.js";
import type { InvoiceRecord, TenantScope } from "../types/storage.js";
import { createInternalMemoryStorage } from "./_internal-memory-storage.js";

const SCOPE: TenantScope = {
  vatNumber: "301234567890003" as VATNumber,
  egsUuid: "11111111-2222-3333-4444-555555555555" as EGSUuid,
};

function makeRecord(invoiceId: string, hash: string): InvoiceRecord {
  return {
    invoiceId,
    kind: "simplified-tax-invoice",
    serial: invoiceId,
    counterNumber: 1,
    uuid: SCOPE.egsUuid,
    invoiceHash: hash as InvoiceHash,
    previousInvoiceHash: "" as InvoiceHash,
    signedXml: "<Invoice/>",
    qrBase64: "QR==",
    issuedAt: new Date("2024-01-15T12:00:00.000Z"),
    status: "pending",
  };
}

describe("createInternalMemoryStorage", () => {
  it("increments counters monotonically per scope", async () => {
    const storage = createInternalMemoryStorage();
    const a = await storage.incrementCounter(SCOPE);
    const b = await storage.incrementCounter(SCOPE);
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(a.invoiceNumber).toBe("INV-0001");
    expect(b.invoiceNumber).toBe("INV-0002");
  });

  it("returns the base PIH on a fresh scope, then the last recorded hash", async () => {
    const storage = createInternalMemoryStorage();
    const first = await storage.getPreviousHash(SCOPE);
    expect(first).toMatch(/^NWZlY2/);
    await storage.recordInvoice(SCOPE, makeRecord("id-1", "HASH1"));
    const second = await storage.getPreviousHash(SCOPE);
    expect(second).toBe("HASH1");
  });

  it("loads previously recorded invoices, returns null for unknown ids", async () => {
    const storage = createInternalMemoryStorage();
    await storage.recordInvoice(SCOPE, makeRecord("id-x", "H"));
    const found = await storage.loadInvoice(SCOPE, "id-x");
    expect(found?.invoiceId).toBe("id-x");
    const missing = await storage.loadInvoice(SCOPE, "nope");
    expect(missing).toBeNull();
  });

  it("transitions invoice status, throws on unknown id", async () => {
    const storage = createInternalMemoryStorage();
    await storage.recordInvoice(SCOPE, makeRecord("id-y", "H"));
    await storage.updateInvoiceStatus(SCOPE, "id-y", "accepted");
    const after = await storage.loadInvoice(SCOPE, "id-y");
    expect(after?.status).toBe("accepted");
    await expect(() =>
      storage.updateInvoiceStatus(SCOPE, "missing", "accepted"),
    ).rejects.toBeInstanceOf(ZatcaStorageError);
  });
});
