/**
 * `StorageAdapter` — the bring-your-own-persistence interface that
 * decouples the core package from any specific database.
 *
 * Two storage concerns must be solved before any Phase 2 invoice can
 * be issued:
 *
 * 1. **Counter sequence**: every EGS keeps a strictly monotonic
 *    invoice counter (ICV). `incrementCounter` returns the next
 *    sequence + the printable serial.
 * 2. **Hash chain**: every invoice's signed XML embeds the SHA-256
 *    hash of the previous invoice's XML. `getPreviousHash` returns
 *    that value for the next document; the issuer writes the new
 *    hash back via `recordInvoice`.
 *
 * The contract is intentionally narrow. Reference implementations in
 * `packages/storage-{memory,mongo,postgres}` ship in Phase 5.
 */

import type { EGSUuid, InvoiceHash, VATNumber } from "./branded.js";
import type { InvoiceKind } from "./invoice.js";

/**
 * Tenant scope — the (VAT number, EGS UUID) pair that uniquely
 * identifies the issuer of a document. Multi-tenant SaaS deployments
 * pass a different scope per request; single-VAT deployments use a
 * constant scope.
 */
export interface TenantScope {
  vatNumber: VATNumber;
  egsUuid: EGSUuid;
}

/**
 * Lifecycle states an issued invoice can occupy.
 *
 * - `pending`   — generated but not yet submitted to ZATCA.
 * - `submitted` — submission in flight (idempotency window).
 * - `accepted`  — ZATCA returned a success envelope.
 * - `rejected`  — ZATCA returned `errorMessages`.
 * - `cancelled` — explicitly cancelled by the user (rare; ZATCA
 *                  prefers credit notes for amendment).
 */
export type InvoiceStatus =
  | "pending"
  | "submitted"
  | "accepted"
  | "rejected"
  | "cancelled";

/**
 * Persistent counter row.
 *
 * Adapters that partition by month / year can store extra columns,
 * but core only needs `sequence` + `lastInvoiceNumber` to be
 * idempotent and monotonic.
 */
export interface CounterRecord {
  scope: TenantScope;
  sequence: number;
  lastInvoiceNumber: string;
  updatedAt: Date;
}

/**
 * Persistent invoice row.
 *
 * Distilled from the rwiqha `IZatcaInvoice` / `IZatcaCreditNote`
 * model interfaces, but framework-agnostic and without any host-
 * specific fields (no Mongoose `_id`, no PDF URLs, no GCS keys —
 * those stay on the caller's own model).
 *
 * - `invoiceId`            — caller-chosen primary key (string).
 * - `kind`                 — invoice variant (one of `InvoiceKind`).
 * - `serial`               — printable invoice number.
 * - `counterNumber`        — numeric sequence (matches `incrementCounter`).
 * - `uuid`                 — invoice UUID embedded in the UBL XML.
 * - `invoiceHash`          — base64 SHA-256 hash of this invoice's XML.
 * - `previousInvoiceHash`  — hash of the previous invoice in the chain.
 * - `signedXml`            — full signed UBL XML (may be large; some
 *                             adapters offload to blob storage and
 *                             store a URL — the contract says: round-
 *                             trip whatever you persisted).
 * - `qrBase64`             — printable QR string.
 * - `issuedAt`             — server clock at issuance.
 * - `status`               — current lifecycle state.
 * - `clearanceNumber`      — present on accepted standard invoices.
 * - `validationResults`    — raw ZATCA envelope, kept for audits.
 */
export interface InvoiceRecord {
  invoiceId: string;
  kind: InvoiceKind;
  serial: string;
  counterNumber: number;
  uuid: string;
  invoiceHash: InvoiceHash;
  previousInvoiceHash: InvoiceHash;
  signedXml: string;
  qrBase64: string;
  issuedAt: Date;
  status: InvoiceStatus;
  clearanceNumber?: string;
  validationResults?: unknown;
}

/**
 * Bring-your-own-persistence adapter.
 *
 * Each method MUST be safe to call concurrently for *different*
 * scopes. For the *same* scope, `incrementCounter` MUST be atomic —
 * concurrent issuers may not get the same `sequence` value. Adapters
 * typically achieve this with an upserting `findOneAndUpdate` (Mongo)
 * or a `UPDATE ... RETURNING` row-lock (Postgres).
 *
 * - `incrementCounter`     — increment + return next sequence for the
 *                             scope. Must be atomic.
 * - `getPreviousHash`      — return the hash of the previous document
 *                             in the chain. For the very first
 *                             invoice, return the all-zeros base hash
 *                             (`"NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ=="`
 *                             per the ZATCA spec). The optional
 *                             `invoiceKind` lets adapters partition
 *                             chains by document type.
 * - `recordInvoice`        — persist a freshly issued invoice. MUST
 *                             be idempotent on `invoiceId`.
 * - `loadInvoice`          — fetch by id; returns `null` if unknown.
 * - `updateInvoiceStatus`  — transition the lifecycle state.
 */
export interface StorageAdapter {
  incrementCounter(
    scope: TenantScope,
  ): Promise<{ sequence: number; invoiceNumber: string }>;
  getPreviousHash(
    scope: TenantScope,
    invoiceKind?: InvoiceKind,
  ): Promise<InvoiceHash>;
  recordInvoice(scope: TenantScope, record: InvoiceRecord): Promise<void>;
  loadInvoice(
    scope: TenantScope,
    invoiceId: string,
  ): Promise<InvoiceRecord | null>;
  updateInvoiceStatus(
    scope: TenantScope,
    invoiceId: string,
    status: InvoiceStatus,
  ): Promise<void>;
}
