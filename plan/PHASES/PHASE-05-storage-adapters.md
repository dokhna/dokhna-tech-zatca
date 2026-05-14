# Phase 5 — Storage Adapters

**Status:** pending
**Agent:** architect (design pass) → typescript-pro (interface lock) → backend-developer (impls)
**Estimated effort:** 1–2 sessions

## Goal

Lock the `StorageAdapter` contract and ship three reference implementations:
- `@dokhna-tech/zatca-storage-memory` — in-process, async-mutex-guarded
- `@dokhna-tech/zatca-storage-mongo` — Mongoose, clean schema
- `@dokhna-tech/zatca-storage-postgres` — raw `pg` + SQL migrations

After this phase, multi-VAT SaaS deployments are unblocked.

## Source files to read first

- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.get.next.sequence.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.get.previous.invoice.hash.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.invoice.model.ts` (schema inspiration only — do NOT copy `IZatcaInvoice`)
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.counter.model.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.credit.notes/zatca.credit.note.model.ts`

## Contract (locked from Phase 1, restated here)

```ts
export interface StorageAdapter {
  incrementCounter(scope: TenantScope): Promise<{ sequence: number; invoiceNumber: string }>;
  getPreviousHash(scope: TenantScope, invoiceKind?: InvoiceKind): Promise<InvoiceHash>;
  recordInvoice(scope: TenantScope, record: InvoiceRecord): Promise<void>;
  loadInvoice(scope: TenantScope, invoiceId: string): Promise<InvoiceRecord | null>;
  updateInvoiceStatus(scope: TenantScope, invoiceId: string, status: InvoiceStatus): Promise<void>;
}

export type TenantScope = { vatNumber: VATNumber; egsUuid: EGSUuid };

export type InvoiceRecord = {
  invoiceId: string;             // UUID
  invoiceNumber: string;         // ZATCA invoice number
  invoiceKind: InvoiceKind;
  invoiceHash: InvoiceHash;
  previousInvoiceHash: InvoiceHash;
  signedXml: string;
  qrCode: Base64;
  status: InvoiceStatus;
  createdAt: Date;
  zatcaResponse?: unknown;       // raw response from ZATCA on submit
};

export type InvoiceStatus = "pending" | "submitted" | "accepted" | "rejected" | "cancelled";
```

## Critical invariants the adapter must guarantee

1. **Counter atomicity.** `incrementCounter` must be atomic per `(vatNumber, egsUuid, year-month)`. Concurrent callers MUST receive distinct sequence numbers.
2. **Hash chain integrity.** `getPreviousHash` must return the hash of the last successfully recorded invoice for the scope (sorted by `createdAt` desc, or by `sequence` desc — whichever is monotonic in the adapter). If no prior invoice exists, return the ZATCA "first invoice" sentinel (`0` repeated 64 times, or whatever the spec mandates — check `zatca.get.previous.invoice.hash.function.ts`).
3. **Record idempotency.** `recordInvoice` should be idempotent on `(scope.vatNumber, scope.egsUuid, invoiceId)`. Re-submission with the same invoiceId is a no-op (or upsert with same content).
4. **Transactional ideal.** The orchestrator in Phase 6 will call `incrementCounter` then `getPreviousHash` then build the invoice then `recordInvoice`. If the adapter supports transactions, expose them via an optional `withTransaction(fn)` method. Document this in the contract.

## Files to create

### `packages/storage-memory/`

```
src/
├── index.ts
├── adapter.ts          # MemoryStorageAdapter implements StorageAdapter
├── adapter.test.ts
```

Implementation: `Map<string, ...>` keyed by `${vatNumber}:${egsUuid}` plus an `async-mutex` per key to serialise increments.

### `packages/storage-mongo/`

```
src/
├── index.ts
├── schema.ts           # Mongoose schemas (clean — do NOT copy rwiqha's IZatcaInvoice shape)
├── adapter.ts          # MongoStorageAdapter
├── adapter.test.ts     # uses mongodb-memory-server for tests
```

Atomic counter: `findOneAndUpdate({ scope, yearMonth }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: 'after' })`.

Hash chain query: indexed `{ vatNumber: 1, egsUuid: 1, createdAt: -1 }`.

### `packages/storage-postgres/`

```
src/
├── index.ts
├── adapter.ts          # PostgresStorageAdapter
├── adapter.test.ts     # uses testcontainers for tests
└── migrations/
    ├── 001_initial.sql
    └── 001_initial.drizzle.ts   # optional Drizzle helper for users on Drizzle
```

Atomic counter: `INSERT ... ON CONFLICT (vat_number, egs_uuid, year_month) DO UPDATE SET sequence = counters.sequence + 1 RETURNING sequence`.

Hash chain query: composite index on `(vat_number, egs_uuid, created_at DESC)`.

## Multi-VAT stress test

Each adapter MUST pass the same shared test suite (placed in `packages/core/src/test-helpers/storage-adapter-conformance.ts` — exported for users to validate their own adapters):

```ts
export function runStorageAdapterConformance(factory: () => Promise<StorageAdapter>) {
  describe("StorageAdapter conformance", () => {
    it("issues distinct sequence numbers under concurrency");
    it("scopes counters per (vatNumber, egsUuid)");
    it("returns the correct previous hash for a scope");
    it("is idempotent on recordInvoice for the same invoiceId");
    // ...
  });
}
```

The conformance test runs 3 simulated tenants × 100 concurrent invoices each, asserts zero collisions per tenant.

## Exit tests

1. `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test` pass.
2. All three adapters pass the shared conformance suite.
3. Multi-VAT stress test (3 × 100 = 300 invoices) completes with zero counter collisions on each adapter.
4. `pnpm publish --dry-run` for each of the four packages emits sensible tarballs.

## What this phase does NOT do

- No PDF/email — out of scope entirely.
- No onboarding orchestration — Phase 6.
- No docs — Phase 7.
