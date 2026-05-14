# @dokhna-tech/zatca-storage-postgres

PostgreSQL `StorageAdapter` for [`@dokhna-tech/zatca`](https://www.npmjs.com/package/@dokhna-tech/zatca). Uses the raw [`pg`](https://www.npmjs.com/package/pg) client — no Knex / Prisma / TypeORM dependency. Suitable for production single-VAT and multi-VAT (multi-tenant SaaS) deployments.

[![npm](https://img.shields.io/npm/v/@dokhna-tech/zatca-storage-postgres.svg)](https://www.npmjs.com/package/@dokhna-tech/zatca-storage-postgres)
[![license](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](./LICENSE)

## Install

```bash
npm install @dokhna-tech/zatca @dokhna-tech/zatca-storage-postgres pg
```

Peer dependencies:
- `@dokhna-tech/zatca` — the core library
- `pg >= 8.0.0`

## Migrations

This package ships SQL migrations under `./migrations`. Apply `001_initial.sql` to your database before first use:

```bash
psql "$DATABASE_URL" -f node_modules/@dokhna-tech/zatca-storage-postgres/migrations/001_initial.sql
```

See [`migrations/README.md`](./migrations/README.md) for the schema overview (`zatca_counters`, `zatca_invoices`).

## Usage

```ts
import { Pool } from "pg";
import { createPostgresStorageAdapter } from "@dokhna-tech/zatca-storage-postgres";
import { issueSimplifiedTaxInvoice, asVATNumber, asEGSUuid } from "@dokhna-tech/zatca";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = createPostgresStorageAdapter({ pool });

const result = await issueSimplifiedTaxInvoice({
  storage,
  vatNumber: asVATNumber("310123456700003"),
  egsUuid: asEGSUuid("11111111-2222-3333-4444-555555555555"),
  // ...rest of the invoice payload
});
```

The adapter uses `INSERT ... ON CONFLICT` for counter increments and `SELECT ... FOR UPDATE` semantics where needed to serialise hash-chain writes per `{vatNumber, egsUuid}` scope, so it's safe under concurrent invoice issuance from multiple Node.js processes.

The factory also accepts optional clock and invoice-number formatter overrides; see the TypeScript signature.

## License

BUSL-1.1 — see [LICENSE](./LICENSE). The license converts to Apache 2.0 on 2030-05-13. SaaS / multi-tenant production use requires a commercial license; see the [main repo](https://github.com/dokhna-tech/zatca) for terms.
