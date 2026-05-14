/**
 * Internal in-memory `StorageAdapter` used by {@link runComplianceTests}
 * when the caller does not supply a real adapter.
 *
 * This is **not** exported from the package — `@dokhna-tech/zatca-
 * storage-memory` is the real, race-safe, BYO-mutex adapter Phase 5
 * ships. Because `storage-memory` peer-depends on `@dokhna-tech/zatca`
 * we cannot reach for it from inside core without creating a
 * circular workspace dependency, so this file provides a minimal
 * single-process equivalent for the compliance runner only.
 *
 * Concurrency: this implementation is sequential, not race-safe. The
 * compliance runner submits its six scenarios one at a time, so the
 * weaker guarantees are fine for that one use case. Do NOT export
 * this for general use.
 */

import type { InvoiceHash } from "../types/branded.js";
import type {
  InvoiceRecord,
  InvoiceStatus,
  StorageAdapter,
  TenantScope,
} from "../types/storage.js";
import { ZatcaStorageError } from "../types/errors.js";

const BASE_PIH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

function scopeKey(scope: TenantScope): string {
  return `${scope.vatNumber}:${scope.egsUuid}`;
}

/**
 * Construct a sequential in-memory adapter for the compliance runner.
 */
export function createInternalMemoryStorage(): StorageAdapter {
  const counters = new Map<string, number>();
  const previousHash = new Map<string, InvoiceHash>();
  const records = new Map<string, InvoiceRecord>();

  return {
    async incrementCounter(scope: TenantScope) {
      const key = scopeKey(scope);
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return {
        sequence: next,
        invoiceNumber: `INV-${String(next).padStart(4, "0")}`,
      };
    },
    async getPreviousHash(scope: TenantScope) {
      return previousHash.get(scopeKey(scope)) ?? BASE_PIH;
    },
    async recordInvoice(scope: TenantScope, record: InvoiceRecord) {
      records.set(`${scopeKey(scope)}:${record.invoiceId}`, record);
      previousHash.set(scopeKey(scope), record.invoiceHash);
    },
    async loadInvoice(scope: TenantScope, invoiceId: string) {
      return records.get(`${scopeKey(scope)}:${invoiceId}`) ?? null;
    },
    async updateInvoiceStatus(
      scope: TenantScope,
      invoiceId: string,
      status: InvoiceStatus,
    ) {
      const existing = records.get(`${scopeKey(scope)}:${invoiceId}`);
      if (existing === undefined) {
        throw new ZatcaStorageError(
          `updateInvoiceStatus called for unknown invoice ${invoiceId}.`,
        );
      }
      records.set(`${scopeKey(scope)}:${invoiceId}`, { ...existing, status });
    },
  };
}
