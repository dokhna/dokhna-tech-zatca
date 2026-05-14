/**
 * `PostgresStorageAdapter` — raw `pg`-backed `StorageAdapter`.
 *
 * Counter atomicity:
 *   `INSERT ... ON CONFLICT DO UPDATE SET sequence = sequence + 1
 *    RETURNING sequence` — a single statement that is both atomic
 *    (under MVCC) and serializable per row.
 *
 * Hash-chain head:
 *   `SELECT invoice_hash FROM zatca_invoices WHERE vat_number = $1
 *    AND egs_uuid = $2 ORDER BY created_at DESC LIMIT 1`.
 *
 * Idempotency:
 *   Unique compound constraint on `(vat_number, egs_uuid, invoice_id)`.
 *   Re-record with the same `(scope, invoiceId)` is a no-op iff every
 *   field matches; conflicting payloads throw `ZatcaStorageError`.
 *
 * The adapter never owns the `pg.Pool` — the host app passes one in.
 */

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

const log = debug("zatca:storage:postgres");

const ZATCA_BASE_INVOICE_HASH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

/**
 * Minimal subset of `pg.Pool` / `pg.Client` the adapter relies on.
 * Encoded as a structural interface so callers can pass `pg.Pool`,
 * `pg.Client`, or a `pg-mem` backed double interchangeably.
 */
export interface PgQueryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export type QueryResultRow = Record<string, unknown>;

export type InvoiceNumberFormatter = (input: {
  scope: TenantScope;
  sequence: number;
  yearMonth: string;
  year: number;
  month: number;
}) => string;

const defaultFormatter: InvoiceNumberFormatter = ({ year, month, sequence }) =>
  `${year}${String(month).padStart(2, "0")}${String(sequence).padStart(6, "0")}`;

export interface PostgresStorageAdapterOptions {
  /**
   * A live `pg.Pool` (or anything implementing {@link PgQueryable}).
   * The adapter does not call `end()` on the pool — connection
   * lifecycle is the caller's responsibility.
   */
  pool: PgQueryable;
  /**
   * Override the printable invoice number format.
   */
  formatInvoiceNumber?: InvoiceNumberFormatter;
  /**
   * Override the clock — tests can freeze time.
   */
  now?: () => Date;
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

interface InvoiceRow extends QueryResultRow {
  invoice_id: string;
  kind: string;
  serial: string;
  counter_number: number;
  uuid: string;
  invoice_hash: string;
  previous_invoice_hash: string;
  signed_xml: string;
  qr_base64: string;
  status: string;
  issued_at: Date | string;
  clearance_number: string | null;
  validation_results: unknown;
}

function toDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function rowToRecord(row: InvoiceRow): InvoiceRecord {
  const out: InvoiceRecord = {
    invoiceId: row.invoice_id,
    kind: row.kind as InvoiceKind,
    serial: row.serial,
    counterNumber: row.counter_number,
    uuid: row.uuid,
    invoiceHash: row.invoice_hash as InvoiceHash,
    previousInvoiceHash: row.previous_invoice_hash as InvoiceHash,
    signedXml: row.signed_xml,
    qrBase64: row.qr_base64,
    status: row.status as InvoiceStatus,
    issuedAt: toDate(row.issued_at),
  };
  if (row.clearance_number !== null && row.clearance_number !== undefined) {
    out.clearanceNumber = row.clearance_number;
  }
  if (row.validation_results !== null && row.validation_results !== undefined) {
    out.validationResults = row.validation_results;
  }
  return out;
}

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
  return JSON.stringify(a.validationResults) === JSON.stringify(b.validationResults);
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // Postgres SQLSTATE 23505 — unique_violation.
  return (err as { code?: unknown }).code === "23505";
}

/**
 * Construct a {@link StorageAdapter} backed by a `pg`-compatible
 * connection pool. The schema in `migrations/001_initial.sql` must
 * already be applied before the first call.
 */
export function createPostgresStorageAdapter(
  options: PostgresStorageAdapterOptions,
): StorageAdapter {
  const { pool } = options;
  const formatInvoiceNumber = options.formatInvoiceNumber ?? defaultFormatter;
  const clock = options.now ?? (() => new Date());

  return {
    async incrementCounter(scope) {
      const now = clock();
      const { yearMonth, year, month } = yearMonthFor(now);
      const result = await pool.query<{ sequence: number }>(
        `INSERT INTO zatca_counters (vat_number, egs_uuid, year_month, sequence)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (vat_number, egs_uuid, year_month)
         DO UPDATE SET sequence = zatca_counters.sequence + 1
         RETURNING sequence`,
        [scope.vatNumber, scope.egsUuid, yearMonth],
      );
      const firstRow = result.rows[0];
      if (firstRow === undefined) {
        throw new ZatcaStorageError(
          "incrementCounter: upsert returned no row",
        );
      }
      const sequence = Number(firstRow.sequence);
      const invoiceNumber = formatInvoiceNumber({
        scope,
        sequence,
        yearMonth,
        year,
        month,
      });
      log("incrementCounter scope=%s/%s seq=%d", scope.vatNumber, scope.egsUuid, sequence);
      return { sequence, invoiceNumber };
    },

    async getPreviousHash(scope, invoiceKind) {
      const whereKind = invoiceKind === undefined ? "" : "AND kind = $3";
      const values: unknown[] = [scope.vatNumber, scope.egsUuid];
      if (invoiceKind !== undefined) values.push(invoiceKind);
      const result = await pool.query<{ invoice_hash: string }>(
        `SELECT invoice_hash FROM zatca_invoices
         WHERE vat_number = $1 AND egs_uuid = $2 ${whereKind}
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        values,
      );
      const head = result.rows[0];
      if (head === undefined) return ZATCA_BASE_INVOICE_HASH;
      return head.invoice_hash as InvoiceHash;
    },

    async recordInvoice(scope, record) {
      const existingResult = await pool.query<InvoiceRow>(
        `SELECT invoice_id, kind, serial, counter_number, uuid, invoice_hash,
                previous_invoice_hash, signed_xml, qr_base64, status,
                issued_at, clearance_number, validation_results
         FROM zatca_invoices
         WHERE vat_number = $1 AND egs_uuid = $2 AND invoice_id = $3`,
        [scope.vatNumber, scope.egsUuid, record.invoiceId],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow !== undefined) {
        if (!recordsEqual(rowToRecord(existingRow), record)) {
          throw new ZatcaStorageError(
            `recordInvoice(${record.invoiceId}) called twice with conflicting payloads.`,
          );
        }
        log(
          "recordInvoice idempotent scope=%s/%s id=%s",
          scope.vatNumber,
          scope.egsUuid,
          record.invoiceId,
        );
        return;
      }
      const validationJson =
        record.validationResults === undefined
          ? null
          : JSON.stringify(record.validationResults);
      try {
        await pool.query(
          `INSERT INTO zatca_invoices (
             vat_number, egs_uuid, invoice_id, kind, serial, counter_number, uuid,
             invoice_hash, previous_invoice_hash, signed_xml, qr_base64, status,
             issued_at, created_at, clearance_number, validation_results
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12,
             $13, $14, $15, $16
           )`,
          [
            scope.vatNumber,
            scope.egsUuid,
            record.invoiceId,
            record.kind,
            record.serial,
            record.counterNumber,
            record.uuid,
            record.invoiceHash,
            record.previousInvoiceHash,
            record.signedXml,
            record.qrBase64,
            record.status,
            record.issuedAt,
            new Date(),
            record.clearanceNumber ?? null,
            validationJson,
          ],
        );
        log(
          "recordInvoice scope=%s/%s id=%s",
          scope.vatNumber,
          scope.egsUuid,
          record.invoiceId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Race: another caller won. Re-read + compare.
          const winnerResult = await pool.query<InvoiceRow>(
            `SELECT invoice_id, kind, serial, counter_number, uuid, invoice_hash,
                    previous_invoice_hash, signed_xml, qr_base64, status,
                    issued_at, clearance_number, validation_results
             FROM zatca_invoices
             WHERE vat_number = $1 AND egs_uuid = $2 AND invoice_id = $3`,
            [scope.vatNumber, scope.egsUuid, record.invoiceId],
          );
          const winnerRow = winnerResult.rows[0];
          if (winnerRow === undefined) throw err;
          if (!recordsEqual(rowToRecord(winnerRow), record)) {
            throw new ZatcaStorageError(
              `recordInvoice(${record.invoiceId}) lost a race against a conflicting payload.`,
            );
          }
          return;
        }
        throw err;
      }
    },

    async loadInvoice(scope, invoiceId) {
      const result = await pool.query<InvoiceRow>(
        `SELECT invoice_id, kind, serial, counter_number, uuid, invoice_hash,
                previous_invoice_hash, signed_xml, qr_base64, status,
                issued_at, clearance_number, validation_results
         FROM zatca_invoices
         WHERE vat_number = $1 AND egs_uuid = $2 AND invoice_id = $3`,
        [scope.vatNumber, scope.egsUuid, invoiceId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return rowToRecord(row);
    },

    async updateInvoiceStatus(scope, invoiceId, status) {
      const result = await pool.query(
        `UPDATE zatca_invoices SET status = $4
         WHERE vat_number = $1 AND egs_uuid = $2 AND invoice_id = $3`,
        [scope.vatNumber, scope.egsUuid, invoiceId, status],
      );
      if (result.rowCount === 0 || result.rowCount === null) {
        throw new ZatcaStorageError(
          `updateInvoiceStatus called for unknown invoice ${invoiceId}.`,
        );
      }
      log(
        "updateInvoiceStatus scope=%s/%s id=%s status=%s",
        scope.vatNumber,
        scope.egsUuid,
        invoiceId,
        status,
      );
    },
  };
}
