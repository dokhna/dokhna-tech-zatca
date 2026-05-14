/**
 * `@dokhna-tech/zatca-storage-postgres` — public entrypoint.
 *
 * Pass a `pg.Pool` (or compatible {@link PgQueryable}) to
 * `createPostgresStorageAdapter`. The migration in
 * `migrations/001_initial.sql` must be applied before the first
 * call.
 */

export {
  createPostgresStorageAdapter,
  type PostgresStorageAdapterOptions,
  type PgQueryable,
  type QueryResultRow,
  type InvoiceNumberFormatter,
} from "./adapter.js";
