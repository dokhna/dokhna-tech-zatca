/**
 * `MongoStorageAdapter` — Mongoose-backed `StorageAdapter`.
 *
 * Counter atomicity:
 *   `findOneAndUpdate({ _id: {vat, egs, yearMonth} }, { $inc: { sequence: 1 } },
 *                     { upsert: true, new: true, setDefaultsOnInsert: true })`.
 *
 * Hash-chain head:
 *   `findOne({ vatNumber, egsUuid })` sorted by `createdAt: -1`.
 *
 * Idempotency:
 *   Unique compound index on `(vatNumber, egsUuid, invoiceId)`. Re-record
 *   with the same `(scope, invoiceId)` is a no-op iff every field
 *   matches; conflicting payloads throw `ZatcaStorageError`.
 */

import debug from "debug";
import type { Connection } from "mongoose";
import type {
  InvoiceHash,
  InvoiceKind,
  InvoiceRecord,
  InvoiceStatus,
  StorageAdapter,
  TenantScope,
} from "@dokhna-tech/zatca";
import { ZatcaStorageError } from "@dokhna-tech/zatca";
import { buildModels, type CounterDoc, type InvoiceDoc } from "./schema.js";

const log = debug("zatca:storage:mongo");

const ZATCA_BASE_INVOICE_HASH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

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
 * Options accepted by {@link createMongoStorageAdapter}.
 *
 * - `connection` — a fully initialised Mongoose `Connection` (e.g.
 *   `mongoose.connection` after `mongoose.connect`, or a
 *   `mongoose.createConnection` instance). Required so the adapter
 *   never owns connection lifecycle — the host app does.
 * - `formatInvoiceNumber` — printable invoice number formatter.
 *   Defaults to `YYYYMM######`.
 * - `now` — clock override for tests.
 */
export interface MongoStorageAdapterOptions {
  connection: Connection;
  formatInvoiceNumber?: InvoiceNumberFormatter;
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

function docToRecord(doc: InvoiceDoc): InvoiceRecord {
  const out: InvoiceRecord = {
    invoiceId: doc.invoiceId,
    kind: doc.kind as InvoiceKind,
    serial: doc.serial,
    counterNumber: doc.counterNumber,
    uuid: doc.uuid,
    invoiceHash: doc.invoiceHash as InvoiceHash,
    previousInvoiceHash: doc.previousInvoiceHash as InvoiceHash,
    signedXml: doc.signedXml,
    qrBase64: doc.qrBase64,
    status: doc.status as InvoiceStatus,
    issuedAt: doc.issuedAt,
  };
  if (doc.clearanceNumber !== undefined) {
    out.clearanceNumber = doc.clearanceNumber;
  }
  if (doc.validationResults !== undefined) {
    out.validationResults = doc.validationResults;
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

/**
 * Build a {@link StorageAdapter} backed by Mongoose models on the
 * supplied connection.
 *
 * The adapter never owns the connection. Callers are responsible for
 * `mongoose.connect` / `disconnect` lifecycle.
 */
export function createMongoStorageAdapter(
  options: MongoStorageAdapterOptions,
): StorageAdapter {
  const { connection } = options;
  const formatInvoiceNumber = options.formatInvoiceNumber ?? defaultFormatter;
  const clock = options.now ?? (() => new Date());
  const { CounterModel, InvoiceModel } = buildModels(connection);

  return {
    async incrementCounter(scope) {
      const now = clock();
      const { yearMonth, year, month } = yearMonthFor(now);
      const id: CounterDoc["_id"] = {
        vatNumber: scope.vatNumber,
        egsUuid: scope.egsUuid,
        yearMonth,
      };
      const updated = await CounterModel.findOneAndUpdate(
        { _id: id },
        { $inc: { sequence: 1 } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      ).lean();
      if (updated === null) {
        throw new ZatcaStorageError(
          "incrementCounter: findOneAndUpdate returned null despite upsert=true",
        );
      }
      const sequence = updated.sequence;
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
      const filter: { vatNumber: string; egsUuid: string; kind?: string } = {
        vatNumber: scope.vatNumber,
        egsUuid: scope.egsUuid,
      };
      if (invoiceKind !== undefined) {
        filter.kind = invoiceKind;
      }
      const head = await InvoiceModel.findOne(filter)
        .sort({ createdAt: -1 })
        .select({ invoiceHash: 1 })
        .lean();
      if (head === null) return ZATCA_BASE_INVOICE_HASH;
      return head.invoiceHash as InvoiceHash;
    },

    async recordInvoice(scope, record) {
      const existing = await InvoiceModel.findOne({
        vatNumber: scope.vatNumber,
        egsUuid: scope.egsUuid,
        invoiceId: record.invoiceId,
      }).lean();
      if (existing !== null) {
        const reconstituted = docToRecord(existing);
        if (!recordsEqual(reconstituted, record)) {
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
      try {
        const insert: Partial<InvoiceDoc> = {
          vatNumber: scope.vatNumber,
          egsUuid: scope.egsUuid,
          invoiceId: record.invoiceId,
          kind: record.kind,
          serial: record.serial,
          counterNumber: record.counterNumber,
          uuid: record.uuid,
          invoiceHash: record.invoiceHash,
          previousInvoiceHash: record.previousInvoiceHash,
          signedXml: record.signedXml,
          qrBase64: record.qrBase64,
          status: record.status,
          issuedAt: record.issuedAt,
          createdAt: new Date(),
        };
        if (record.clearanceNumber !== undefined) {
          insert.clearanceNumber = record.clearanceNumber;
        }
        if (record.validationResults !== undefined) {
          insert.validationResults = record.validationResults;
        }
        await InvoiceModel.create(insert);
        log(
          "recordInvoice scope=%s/%s id=%s",
          scope.vatNumber,
          scope.egsUuid,
          record.invoiceId,
        );
      } catch (err) {
        // Duplicate key (race between our lookup + create) — re-resolve
        // by reading the existing row and applying the same equality
        // check the idempotency branch used.
        if (isDuplicateKeyError(err)) {
          const winner = await InvoiceModel.findOne({
            vatNumber: scope.vatNumber,
            egsUuid: scope.egsUuid,
            invoiceId: record.invoiceId,
          }).lean();
          if (winner === null) throw err;
          if (!recordsEqual(docToRecord(winner), record)) {
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
      const doc = await InvoiceModel.findOne({
        vatNumber: scope.vatNumber,
        egsUuid: scope.egsUuid,
        invoiceId,
      }).lean();
      if (doc === null) return null;
      return docToRecord(doc);
    },

    async updateInvoiceStatus(scope, invoiceId, status) {
      const result = await InvoiceModel.updateOne(
        {
          vatNumber: scope.vatNumber,
          egsUuid: scope.egsUuid,
          invoiceId,
        },
        { $set: { status } },
      );
      if (result.matchedCount === 0) {
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

function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 11000;
}
