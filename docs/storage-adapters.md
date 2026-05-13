# Storage adapters

The core package never owns persistence. Every issuer function takes a `StorageAdapter` and a `TenantScope`. Three reference adapters ship:

- [`@dokhna-tach/zatca-storage-memory`](../packages/storage-memory/) — in-process; for local dev and tests.
- [`@dokhna-tach/zatca-storage-mongo`](../packages/storage-mongo/) — Mongoose-backed.
- [`@dokhna-tach/zatca-storage-postgres`](../packages/storage-postgres/) — `pg`-backed.

Writing your own takes ~80 lines. See [`examples/byo-storage-prisma/`](../examples/byo-storage-prisma/) for a worked example against Prisma.

## The interface

```ts
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
```

Five methods. The contract:

### `incrementCounter`

- MUST be atomic per `(vatNumber, egsUuid)`. Two concurrent callers must get distinct sequences.
- Returns the sequence (numeric, monotonic from 1) and the printable invoice number (string).
- Pattern (Postgres): `UPDATE counters SET sequence = sequence + 1 WHERE vat = $1 AND egs = $2 RETURNING sequence`.
- Pattern (Mongo): `findOneAndUpdate({ _id: { vat, egs } }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: "after" })`.

### `getPreviousHash`

- Returns the SHA-256 base64 hash of the previous invoice in the chain for this scope.
- For the very first invoice, return the ZATCA base hash:
  ```ts
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;
  ```
- The optional `invoiceKind` argument lets adapters partition the chain by document type if the deployment requires it. Most callers don't.

### `recordInvoice`

- MUST be idempotent on `invoiceId`. Re-recording the *same* record is a no-op; re-recording with conflicting fields throws `ZatcaStorageError`.
- Stores the signed XML, the hash, the QR, and lifecycle metadata.

### `loadInvoice`

- Returns the record or `null`. Never throws on missing.

### `updateInvoiceStatus`

- Transitions the lifecycle: `pending → submitted → accepted | rejected | cancelled`.
- No state-machine enforcement at this layer — host code chooses the rules.

## InvoiceRecord shape

```ts
interface InvoiceRecord {
  invoiceId: string;
  kind: InvoiceKind;          // "simplified-tax-invoice" | "standard-tax-invoice" | ...
  serial: string;             // printable invoice number from incrementCounter
  counterNumber: number;      // numeric sequence
  uuid: string;               // invoice UUID embedded in the UBL
  invoiceHash: InvoiceHash;   // base64 SHA-256 of this invoice's XML
  previousInvoiceHash: InvoiceHash;
  signedXml: string;          // full signed UBL XML
  qrBase64: string;           // base64 Phase 2 TLV QR
  issuedAt: Date;
  status: InvoiceStatus;
  clearanceNumber?: string;   // present on accepted standard invoices
  validationResults?: unknown; // raw ZATCA envelope, kept for audits
}
```

Adapters MAY persist additional columns (month partition keys, PDF URLs, tenant ids) — the contract is "round-trip what core handed you", so extra metadata on your end is fine.

## Worked example: a Prisma adapter

```prisma
// prisma/schema.prisma
model ZatcaInvoice {
  id                  String   @id
  vatNumber           String
  egsUuid             String
  kind                String
  serial              String
  counterNumber       Int
  uuid                String
  invoiceHash         String
  previousInvoiceHash String
  signedXml           String
  qrBase64            String
  issuedAt            DateTime
  status              String
  clearanceNumber     String?
  validationResults   Json?
  createdAt           DateTime @default(now())

  @@unique([vatNumber, egsUuid, id])
  @@index([vatNumber, egsUuid, counterNumber])
}

model ZatcaCounter {
  vatNumber String
  egsUuid   String
  yearMonth String   // "202605"
  sequence  Int      @default(0)
  updatedAt DateTime @updatedAt

  @@id([vatNumber, egsUuid, yearMonth])
}
```

```ts
// src/prisma-adapter.ts
import { PrismaClient } from "@prisma/client";
import type {
  InvoiceHash,
  InvoiceKind,
  InvoiceRecord,
  InvoiceStatus,
  StorageAdapter,
  TenantScope,
} from "@dokhna-tach/zatca";
import { ZatcaStorageError } from "@dokhna-tach/zatca";

const ZATCA_BASE_INVOICE_HASH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

export function createPrismaStorageAdapter(prisma: PrismaClient): StorageAdapter {
  return {
    async incrementCounter(scope) {
      const now = new Date();
      const yearMonth = `${now.getUTCFullYear()}${String(
        now.getUTCMonth() + 1,
      ).padStart(2, "0")}`;

      const updated = await prisma.zatcaCounter.upsert({
        where: {
          vatNumber_egsUuid_yearMonth: {
            vatNumber: scope.vatNumber,
            egsUuid: scope.egsUuid,
            yearMonth,
          },
        },
        update: { sequence: { increment: 1 } },
        create: {
          vatNumber: scope.vatNumber,
          egsUuid: scope.egsUuid,
          yearMonth,
          sequence: 1,
        },
      });

      const sequence = updated.sequence;
      const invoiceNumber = `${yearMonth}${String(sequence).padStart(6, "0")}`;
      return { sequence, invoiceNumber };
    },

    async getPreviousHash(scope) {
      const last = await prisma.zatcaInvoice.findFirst({
        where: { vatNumber: scope.vatNumber, egsUuid: scope.egsUuid },
        orderBy: { counterNumber: "desc" },
        select: { invoiceHash: true },
      });
      return (last?.invoiceHash ?? ZATCA_BASE_INVOICE_HASH) as InvoiceHash;
    },

    async recordInvoice(scope, record) {
      try {
        await prisma.zatcaInvoice.create({
          data: {
            id: record.invoiceId,
            vatNumber: scope.vatNumber,
            egsUuid: scope.egsUuid,
            kind: record.kind,
            serial: record.serial,
            counterNumber: record.counterNumber,
            uuid: record.uuid,
            invoiceHash: record.invoiceHash,
            previousInvoiceHash: record.previousInvoiceHash,
            signedXml: record.signedXml,
            qrBase64: record.qrBase64,
            issuedAt: record.issuedAt,
            status: record.status,
            clearanceNumber: record.clearanceNumber ?? null,
            validationResults: (record.validationResults as object) ?? undefined,
          },
        });
      } catch (cause) {
        // P2002 = unique violation; round-trip check elided for brevity.
        throw new ZatcaStorageError("recordInvoice failed", cause);
      }
    },

    async loadInvoice(scope, invoiceId) {
      const row = await prisma.zatcaInvoice.findFirst({
        where: { vatNumber: scope.vatNumber, egsUuid: scope.egsUuid, id: invoiceId },
      });
      if (!row) return null;
      return {
        invoiceId: row.id,
        kind: row.kind as InvoiceKind,
        serial: row.serial,
        counterNumber: row.counterNumber,
        uuid: row.uuid,
        invoiceHash: row.invoiceHash as InvoiceHash,
        previousInvoiceHash: row.previousInvoiceHash as InvoiceHash,
        signedXml: row.signedXml,
        qrBase64: row.qrBase64,
        issuedAt: row.issuedAt,
        status: row.status as InvoiceStatus,
        ...(row.clearanceNumber ? { clearanceNumber: row.clearanceNumber } : {}),
        ...(row.validationResults ? { validationResults: row.validationResults } : {}),
      };
    },

    async updateInvoiceStatus(scope, invoiceId, status) {
      await prisma.zatcaInvoice.updateMany({
        where: { vatNumber: scope.vatNumber, egsUuid: scope.egsUuid, id: invoiceId },
        data: { status },
      });
    },
  };
}
```

The full runnable version is in [`examples/byo-storage-prisma/`](../examples/byo-storage-prisma/).

## Testing your adapter

The core package ships a conformance suite that exercises 13 scenarios — atomic counter races, hash chain continuity, idempotent recordInvoice, status transitions, multi-tenant isolation. Import and run it against your adapter:

```ts
import { describe } from "vitest";
import { runStorageAdapterConformance } from "@dokhna-tach/zatca/test-helpers";

describe("Prisma adapter conformance", () => {
  runStorageAdapterConformance({
    createAdapter: async () => createPrismaStorageAdapter(testPrisma),
    teardown: async () => { await testPrisma.zatcaInvoice.deleteMany({}); /* ... */ },
  });
});
```

A passing conformance suite means the adapter is correctly handling counter atomicity, hash chain integrity, and idempotency. The reference Mongo and Postgres adapters were built by passing this suite.

## When to partition the hash chain

`getPreviousHash` accepts an optional `invoiceKind`. By default it is ignored — there is one chain per `(vatNumber, egsUuid)` covering all invoice kinds. This matches the ZATCA spec for most deployments.

A deployment that wants separate chains for tax invoices vs credit notes (some auditors prefer this) can use the kind parameter to look up per-kind heads. The choice is yours; just be consistent.
