/**
 * `@dokhna-tech/zatca-storage-mongo` — public entrypoint.
 *
 * The Mongoose adapter takes a caller-owned `Connection` so multi-
 * tenant SaaS apps can reuse their existing connection pool.
 */

export {
  createMongoStorageAdapter,
  type MongoStorageAdapterOptions,
  type InvoiceNumberFormatter,
} from "./adapter.js";
export {
  buildSchemas,
  buildModels,
  type CounterDoc,
  type InvoiceDoc,
} from "./schema.js";
