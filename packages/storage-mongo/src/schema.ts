/**
 * Mongoose schemas for the ZATCA storage adapter.
 *
 * Two collections:
 *
 * 1. `zatca_counters` — atomic per-`(vatNumber, egsUuid, yearMonth)`
 *    sequence. Uses a composite-object `_id` so a single document
 *    update is enough to serialize counter increments.
 * 2. `zatca_invoices` — one document per issued invoice. Indexed for
 *    both hash-chain reads (most recent by scope+createdAt) and
 *    idempotency lookups by `(vatNumber, egsUuid, invoiceId)`.
 *
 * Field names are framework-neutral. We deliberately do NOT copy any
 * host-specific shape (which would leak concepts like `store:
 * ObjectId` references); the open-source package only persists what
 * the {@link InvoiceRecord} contract requires.
 */

import type { Connection, Model, Schema as SchemaType } from "mongoose";
import mongoose from "mongoose";

/**
 * Counter document shape.
 *
 * `_id` is a plain JS object — Mongo allows composite `_id` keys as
 * long as the shape is stable. We use this instead of a separate
 * compound unique index so every update is a single-document op.
 */
export interface CounterDoc {
  _id: { vatNumber: string; egsUuid: string; yearMonth: string };
  sequence: number;
}

/**
 * Invoice document shape. Mirrors {@link InvoiceRecord} from
 * `@dokhna-tech/zatca` plus three Mongo-specific fields:
 *
 * - `vatNumber` / `egsUuid` — denormalized from the call-site
 *   `TenantScope` so a single compound index serves both hash-chain
 *   and idempotency reads.
 * - `createdAt` — server-side insertion time used as the canonical
 *   hash-chain sort key. Distinct from `issuedAt` (the wall-clock at
 *   issuance, which is part of the signed XML).
 */
export interface InvoiceDoc {
  _id: mongoose.Types.ObjectId;
  vatNumber: string;
  egsUuid: string;
  invoiceId: string;
  kind: string;
  serial: string;
  counterNumber: number;
  uuid: string;
  invoiceHash: string;
  previousInvoiceHash: string;
  signedXml: string;
  qrBase64: string;
  status: string;
  issuedAt: Date;
  createdAt: Date;
  clearanceNumber?: string;
  validationResults?: unknown;
}

const CounterSchemaDefinition = {
  _id: {
    vatNumber: { type: String, required: true },
    egsUuid: { type: String, required: true },
    yearMonth: { type: String, required: true },
  },
  sequence: { type: Number, required: true, default: 0 },
};

const InvoiceSchemaDefinition = {
  vatNumber: { type: String, required: true, index: true },
  egsUuid: { type: String, required: true, index: true },
  invoiceId: { type: String, required: true },
  kind: { type: String, required: true },
  serial: { type: String, required: true },
  counterNumber: { type: Number, required: true },
  uuid: { type: String, required: true },
  invoiceHash: { type: String, required: true },
  previousInvoiceHash: { type: String, required: true },
  signedXml: { type: String, required: true },
  qrBase64: { type: String, required: true },
  status: { type: String, required: true },
  issuedAt: { type: Date, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
  clearanceNumber: { type: String, required: false },
  validationResults: { type: mongoose.Schema.Types.Mixed, required: false },
};

/**
 * Build the two schemas with their indexes. Exposed as a function so
 * callers controlling their own mongoose instance can wire models
 * against an arbitrary `Connection`.
 */
export function buildSchemas(): {
  counterSchema: SchemaType<CounterDoc>;
  invoiceSchema: SchemaType<InvoiceDoc>;
} {
  // `_id: false` on sub-document not needed — _id is the composite key.
  const counterSchema = new mongoose.Schema<CounterDoc>(CounterSchemaDefinition, {
    _id: false,
    versionKey: false,
  });
  const invoiceSchema = new mongoose.Schema<InvoiceDoc>(InvoiceSchemaDefinition, {
    versionKey: false,
  });
  // Hash-chain head read: most recent by scope.
  invoiceSchema.index({ vatNumber: 1, egsUuid: 1, createdAt: -1 });
  // Hash-chain head read partitioned by kind (multi-stream).
  invoiceSchema.index({ vatNumber: 1, egsUuid: 1, kind: 1, createdAt: -1 });
  // Idempotency lookup + uniqueness.
  invoiceSchema.index({ vatNumber: 1, egsUuid: 1, invoiceId: 1 }, { unique: true });
  return { counterSchema, invoiceSchema };
}

/**
 * Materialize counter + invoice models on the supplied connection.
 * Collection names are fixed (`zatca_counters`, `zatca_invoices`) so
 * cross-process callers see the same data.
 */
export function buildModels(connection: Connection): {
  CounterModel: Model<CounterDoc>;
  InvoiceModel: Model<InvoiceDoc>;
} {
  const { counterSchema, invoiceSchema } = buildSchemas();
  const CounterModel =
    (connection.models.ZatcaCounter as Model<CounterDoc> | undefined) ??
    connection.model<CounterDoc>("ZatcaCounter", counterSchema, "zatca_counters");
  const InvoiceModel =
    (connection.models.ZatcaInvoice as Model<InvoiceDoc> | undefined) ??
    connection.model<InvoiceDoc>("ZatcaInvoice", invoiceSchema, "zatca_invoices");
  return { CounterModel, InvoiceModel };
}
