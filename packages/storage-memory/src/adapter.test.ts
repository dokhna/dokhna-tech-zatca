/**
 * `MemoryStorageAdapter` — conformance suite wire-up.
 *
 * Defers all behavioural checks to the shared
 * `runStorageAdapterConformance` suite. Per-test isolation is
 * achieved by minting a fresh adapter inside the factory closure
 * called by `beforeAll`.
 */

import { runStorageAdapterConformance } from "@dokhna-tach/zatca/test-helpers";
import { createMemoryStorageAdapter } from "./adapter.js";

runStorageAdapterConformance(() => createMemoryStorageAdapter());
