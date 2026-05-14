/**
 * `MemoryStorageAdapter` — in-process reference implementation of the
 * `StorageAdapter` contract.
 *
 * Intended uses:
 *
 * - Local development without a real database.
 * - CI / unit tests that need a working storage backend.
 * - The conformance fixture for `@dokhna-tech/zatca/test-helpers`.
 *
 * Not intended for production: state lives entirely in process memory
 * and is lost on restart. For real deployments use
 * `@dokhna-tech/zatca-storage-mongo` or
 * `@dokhna-tech/zatca-storage-postgres`.
 *
 * Concurrency model:
 *
 * - One `Mutex` per `(vatNumber, egsUuid, yearMonth)` counter row.
 *   `incrementCounter` is therefore atomic per scope+month even when
 *   100s of awaits race for the same counter.
 * - `recordInvoice` and `updateInvoiceStatus` share a per-scope mutex
 *   so the hash-chain head and the records map stay consistent.
 */

import { Mutex } from "async-mutex";
import debug from "debug";
import type {
  InvoiceHash,
  InvoiceKind,
  InvoiceRecord,
  InvoiceStatus,
  StorageAdapter,
  TenantScope,
} from "@dokhna-tech/zatca";
import { ZatcaStorageError } from "@dokhna-tech/zatca";

const log = debug("zatca:storage:memory");

/**
 * Same sentinel as the conformance suite. Re-declared here (rather
 * than imported) so the memory adapter has no runtime dependency on
 * `/test-helpers`, which would pull a vitest peer dep into prod.
 */
const ZATCA_BASE_INVOICE_HASH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

/**
 * Format the printable invoice number from a counter sequence.
 *
 * Default mirrors the rwiqha implementation: `YYYYMM######` (year
 * concatenated with two-digit month and six-digit zero-padded
 * sequence). Override via constructor option.
 */
export type InvoiceNumberFormatter = (input: {
  scope: TenantScope;
  sequence: number;
  yearMonth: string;
  year: number;
  month: number;
}) => string;

const defaultFormatter: InvoiceNumberFormatter = ({ year, month, sequence }) =>
  `${year}${String(month).padStart(2, "0")}${String(sequence).padStart(6, "0")}`;

/**
 * Options accepted by {@link createMemoryStorageAdapter}.
 */
export interface MemoryStorageAdapterOptions {
  /**
   * Override the printable invoice-number format. Default mirrors the
   * rwiqha-backend production format: `YYYYMM######`.
   */
  formatInvoiceNumber?: InvoiceNumberFormatter;
  /**
   * Override the clock. Tests can pin time for deterministic counter
   * keys.
   */
  now?: () => Date;
}

interface CounterCell {
  readonly mutex: Mutex;
  sequence: number;
}

interface ScopeCell {
  readonly mutex: Mutex;
  readonly records: Map<string, InvoiceRecord>;
  // Hash chain head, partitioned by InvoiceKind so multi-stream
  // deployments are supported. `undefined` key means "any kind" — the
  // default chain used when callers do not pass an `invoiceKind`.
  readonly chainHead: Map<InvoiceKind | "__any__", InvoiceHash>;
}

function scopeKey(scope: TenantScope): string {
  return `${scope.vatNumber}:${scope.egsUuid}`;
}

function counterKey(scope: TenantScope, yearMonth: string): string {
  return `${scopeKey(scope)}:${yearMonth}`;
}

function yearMonthFor(date: Date): { yearMonth: string; year: number; month: number } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return {
    year,
    month,
    yearMonth: `${year}${String(month).padStart(2, "0")}`,
  };
}

/**
 * Construct a fresh in-process storage adapter. Each call yields an
 * independent state — perfect for per-test isolation.
 */
export function createMemoryStorageAdapter(
  options: MemoryStorageAdapterOptions = {},
): StorageAdapter {
  const formatInvoiceNumber = options.formatInvoiceNumber ?? defaultFormatter;
  const clock = options.now ?? (() => new Date());

  const counters = new Map<string, CounterCell>();
  const scopes = new Map<string, ScopeCell>();

  function getOrCreateCounter(scope: TenantScope, yearMonth: string): CounterCell {
    const key = counterKey(scope, yearMonth);
    let cell = counters.get(key);
    if (cell === undefined) {
      cell = { mutex: new Mutex(), sequence: 0 };
      counters.set(key, cell);
    }
    return cell;
  }

  function getOrCreateScope(scope: TenantScope): ScopeCell {
    const key = scopeKey(scope);
    let cell = scopes.get(key);
    if (cell === undefined) {
      cell = {
        mutex: new Mutex(),
        records: new Map<string, InvoiceRecord>(),
        chainHead: new Map<InvoiceKind | "__any__", InvoiceHash>(),
      };
      scopes.set(key, cell);
    }
    return cell;
  }

  return {
    async incrementCounter(scope) {
      const now = clock();
      const { yearMonth, year, month } = yearMonthFor(now);
      const cell = getOrCreateCounter(scope, yearMonth);
      return cell.mutex.runExclusive(() => {
        cell.sequence += 1;
        const sequence = cell.sequence;
        const invoiceNumber = formatInvoiceNumber({
          scope,
          sequence,
          yearMonth,
          year,
          month,
        });
        log("incrementCounter scope=%s seq=%d", scopeKey(scope), sequence);
        return { sequence, invoiceNumber };
      });
    },

    async getPreviousHash(scope, invoiceKind) {
      const cell = scopes.get(scopeKey(scope));
      if (cell === undefined) {
        return ZATCA_BASE_INVOICE_HASH;
      }
      const key: InvoiceKind | "__any__" = invoiceKind ?? "__any__";
      const head = cell.chainHead.get(key);
      return head ?? ZATCA_BASE_INVOICE_HASH;
    },

    async recordInvoice(scope, record) {
      const cell = getOrCreateScope(scope);
      await cell.mutex.runExclusive(() => {
        const existing = cell.records.get(record.invoiceId);
        if (existing !== undefined) {
          if (!recordsEqual(existing, record)) {
            throw new ZatcaStorageError(
              `recordInvoice(${record.invoiceId}) called twice with conflicting payloads.`,
            );
          }
          log("recordInvoice idempotent scope=%s id=%s", scopeKey(scope), record.invoiceId);
          return;
        }
        cell.records.set(record.invoiceId, record);
        cell.chainHead.set("__any__", record.invoiceHash);
        cell.chainHead.set(record.kind, record.invoiceHash);
        log(
          "recordInvoice scope=%s id=%s kind=%s",
          scopeKey(scope),
          record.invoiceId,
          record.kind,
        );
      });
    },

    async loadInvoice(scope, invoiceId) {
      const cell = scopes.get(scopeKey(scope));
      if (cell === undefined) return null;
      return cell.records.get(invoiceId) ?? null;
    },

    async updateInvoiceStatus(scope, invoiceId, status: InvoiceStatus) {
      const cell = scopes.get(scopeKey(scope));
      if (cell === undefined) {
        throw new ZatcaStorageError(
          `updateInvoiceStatus called for unknown invoice ${invoiceId}.`,
        );
      }
      await cell.mutex.runExclusive(() => {
        const existing = cell.records.get(invoiceId);
        if (existing === undefined) {
          throw new ZatcaStorageError(
            `updateInvoiceStatus called for unknown invoice ${invoiceId}.`,
          );
        }
        cell.records.set(invoiceId, { ...existing, status });
        log(
          "updateInvoiceStatus scope=%s id=%s status=%s",
          scopeKey(scope),
          invoiceId,
          status,
        );
      });
    },
  };
}

/**
 * Conservative structural equality for {@link InvoiceRecord}. Used by
 * `recordInvoice` to distinguish a true retry (allowed) from a
 * conflicting payload (must throw).
 *
 * `Date` fields compared by epoch ms; `validationResults` compared by
 * JSON shape (best-effort — adapters that round-trip through real DBs
 * see no looser shape than this).
 */
function recordsEqual(a: InvoiceRecord, b: InvoiceRecord): boolean {
  if (a.invoiceId !== b.invoiceId) return false;
  if (a.kind !== b.kind) return false;
  if (a.serial !== b.serial) return false;
  if (a.counterNumber !== b.counterNumber) return false;
  if (a.uuid !== b.uuid) return false;
  if (a.invoiceHash !== b.invoiceHash) return false;
  if (a.previousInvoiceHash !== b.previousInvoiceHash) return false;
  if (a.signedXml !== b.signedXml) return false;
  if (a.qrBase64 !== b.qrBase64) return false;
  if (a.status !== b.status) return false;
  if (a.issuedAt.getTime() !== b.issuedAt.getTime()) return false;
  if (a.clearanceNumber !== b.clearanceNumber) return false;
  // validationResults is `unknown`; safe to JSON-compare.
  return JSON.stringify(a.validationResults) === JSON.stringify(b.validationResults);
}
