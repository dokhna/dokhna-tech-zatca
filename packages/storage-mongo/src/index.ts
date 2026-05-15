/**
 * `@dokhna-tech/zatca-storage-mongo` — public entrypoint.
 *
 * The Mongoose adapter takes a caller-owned `Connection` so multi-
 * tenant SaaS apps can reuse their existing connection pool.
 */

export {
  createMongoStorageAdapter,
  type InvoiceNumberFormatter,
  type MongoStorageAdapterOptions,
} from "./adapter.js";
export {
  buildModels,
  buildSchemas,
  type CounterDoc,
  type InvoiceDoc,
} from "./schema.js";
