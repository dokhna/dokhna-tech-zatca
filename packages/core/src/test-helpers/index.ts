/**
 * Public test-helpers surface for `@dokhna-tech/zatca`.
 *
 * Imported via the subpath export `@dokhna-tech/zatca/test-helpers`,
 * so callers who write their own `StorageAdapter` can drop a
 * pre-canned vitest suite into their codebase:
 *
 * ```ts
 * import { runStorageAdapterConformance } from "@dokhna-tech/zatca/test-helpers";
 * import { createMemoryStorageAdapter } from "./my-adapter.js";
 *
 * runStorageAdapterConformance(() => createMemoryStorageAdapter());
 * ```
 *
 * The conformance suite is the single source of truth for what
 * "implements the StorageAdapter contract correctly" means. Phase 5's
 * three reference adapters all pass it.
 */

export {
  runStorageAdapterConformance,
  ZATCA_BASE_INVOICE_HASH,
} from "./storage-adapter-conformance.js";
export type {
  ConformanceFixtures,
  RunConformanceOptions,
} from "./storage-adapter-conformance.js";
