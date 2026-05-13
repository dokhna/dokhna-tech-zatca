# `@dokhna-tach/zatca-storage-postgres` — migrations

This directory contains the SQL needed to bring a Postgres database
to the schema the adapter expects. Migrations are plain `.sql`
files — pick the tool that fits your stack.

## Files

| File                | Purpose                                |
|---------------------|----------------------------------------|
| `001_initial.sql`   | Create `zatca_counters`, `zatca_invoices`, indexes. |

## Applying the migration

### psql

```bash
psql "$DATABASE_URL" -f node_modules/@dokhna-tach/zatca-storage-postgres/migrations/001_initial.sql
```

### node-pg directly

```ts
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = readFileSync(
  "node_modules/@dokhna-tach/zatca-storage-postgres/migrations/001_initial.sql",
  "utf8",
);
await pool.query(sql);
```

### Drizzle / Prisma / Kysely

Drop the SQL into your tool's migration directory and let its
migration runner version-track it.

## Conventions

- Every table name is prefixed with `zatca_` to avoid collision with
  app tables.
- The migration is idempotent (`CREATE TABLE IF NOT EXISTS`) so it
  can safely be re-applied.
- The `validation_results` column is `JSONB` so callers can index it
  if they later need to query ZATCA error envelopes.
