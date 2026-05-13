/**
 * Test-only in-memory `StorageAdapter`.
 *
 * Not exported from the package — Phase 5 ships the real
 * `storage-memory` adapter. This double is intentionally minimal:
 * it satisfies the {@link StorageAdapter} contract with non-persistent
 * Maps so per-test isolation is guaranteed.
 */

import type { InvoiceKind } from "../types/invoice.js";
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
 * Counts the storage method calls so dispatch tests can assert which
 * issuer was invoked without spying on the issuer module.
 */
export interface MemoryStorageCallLog {
  incrementCounter: number;
  getPreviousHash: Array<{ kind?: InvoiceKind }>;
  recordInvoice: number;
}

/**
 * Construct a memory adapter. Counters start at 0 and the previous
 * hash starts at the spec base PIH.
 */
export function makeMemoryStorage(): {
  storage: StorageAdapter;
  log: MemoryStorageCallLog;
} {
  const counters = new Map<string, number>();
  const previousHash = new Map<string, InvoiceHash>();
  const records = new Map<string, InvoiceRecord>();
  const log: MemoryStorageCallLog = {
    incrementCounter: 0,
    getPreviousHash: [],
    recordInvoice: 0,
  };

  const storage: StorageAdapter = {
    async incrementCounter(scope) {
      log.incrementCounter += 1;
      const key = scopeKey(scope);
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return { sequence: next, invoiceNumber: `INV-${String(next).padStart(4, "0")}` };
    },
    async getPreviousHash(scope, kind) {
      log.getPreviousHash.push(kind === undefined ? {} : { kind });
      return previousHash.get(scopeKey(scope)) ?? BASE_PIH;
    },
    async recordInvoice(scope, record) {
      log.recordInvoice += 1;
      records.set(`${scopeKey(scope)}:${record.invoiceId}`, record);
      previousHash.set(scopeKey(scope), record.invoiceHash);
    },
    async loadInvoice(scope, invoiceId) {
      return records.get(`${scopeKey(scope)}:${invoiceId}`) ?? null;
    },
    async updateInvoiceStatus(scope, invoiceId, status: InvoiceStatus) {
      const existing = records.get(`${scopeKey(scope)}:${invoiceId}`);
      if (existing === undefined) {
        throw new ZatcaStorageError(
          `updateInvoiceStatus called for unknown invoice ${invoiceId}.`,
        );
      }
      records.set(`${scopeKey(scope)}:${invoiceId}`, { ...existing, status });
    },
  };

  return { storage, log };
}
