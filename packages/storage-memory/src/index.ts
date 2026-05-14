/**
 * `@dokhna-tech/zatca-storage-memory` — public entrypoint.
 *
 * Ships a single named factory, {@link createMemoryStorageAdapter},
 * that returns a fresh, fully-isolated `StorageAdapter` instance.
 * State is process-local; restart loses everything.
 */

export {
  createMemoryStorageAdapter,
  type MemoryStorageAdapterOptions,
  type InvoiceNumberFormatter,
} from "./adapter.js";
