# byo-storage-prisma

Worked example of implementing a custom `StorageAdapter` for `@dokhna-tach/zatca` against Prisma + SQLite.

## Why this example

The reference adapters (`-memory`, `-mongo`, `-postgres`) cover most deployments, but some shops are standardised on Prisma. The five-method `StorageAdapter` interface is small enough to implement against any ORM; this example shows the shape end-to-end.

## Run it

```bash
# from the repo root
pnpm install

# generate the Prisma client from prisma/schema.prisma
pnpm --filter @dokhna-tach-examples/byo-storage-prisma prisma:generate

# apply the schema to a local SQLite file
cp examples/byo-storage-prisma/.env.example examples/byo-storage-prisma/.env
cd examples/byo-storage-prisma
pnpm exec prisma migrate dev --name init
cd -

# issue two demo invoices
pnpm --filter @dokhna-tach-examples/byo-storage-prisma start
```

The demo populates `prisma/dev.db` and prints the issued invoice numbers + hashes.

## Files

- `prisma/schema.prisma` — schema matching `InvoiceRecord` + a counter table.
- `src/prisma-adapter.ts` — the adapter; takes a structural `PrismaLike` so it typechecks before `prisma generate` runs.
- `src/index.ts` — short demo that issues 2 invoices for one tenant.

## Mapping `StorageAdapter` to Prisma

| Adapter method | Prisma call |
|----------------|-------------|
| `incrementCounter` | `zatcaCounter.upsert` with `{ sequence: { increment: 1 } }` |
| `getPreviousHash` | `zatcaInvoice.findFirst` ordered by `counterNumber desc`, selecting `invoiceHash` |
| `recordInvoice` | `zatcaInvoice.create` — handle P2002 (unique violation) for idempotency |
| `loadInvoice` | `zatcaInvoice.findFirst` by `(vatNumber, egsUuid, id)` |
| `updateInvoiceStatus` | `zatcaInvoice.updateMany` |

## Idempotency note

The example's `recordInvoice` wraps every error as `ZatcaStorageError`. A production version should distinguish Prisma's P2002 unique-violation error code, re-fetch the existing row, and compare field-by-field. If the payloads match, it's a no-op; if they don't, throw. The reference Mongo and Postgres adapters do this — see `packages/storage-mongo/src/adapter.ts` for the pattern.

## Conformance testing

Once your adapter compiles, run the conformance suite against it:

```ts
import { describe } from "vitest";
import { runStorageAdapterConformance } from "@dokhna-tach/zatca/test-helpers";

describe("Prisma adapter conformance", () => {
  runStorageAdapterConformance({
    createAdapter: async () => createPrismaStorageAdapter(testPrisma),
    teardown: async () => {
      await testPrisma.zatcaInvoice.deleteMany({});
      await testPrisma.zatcaCounter.deleteMany({});
    },
  });
});
```

A passing run (13 scenarios — atomic counter races, hash chain continuity, idempotent recordInvoice, status transitions, multi-tenant isolation) is the contract.

## Where to go next

- Storage interface reference: [`../../docs/storage-adapters.md`](../../docs/storage-adapters.md).
- Multi-tenant SaaS patterns: [`../../docs/multi-vat-saas.md`](../../docs/multi-vat-saas.md).
