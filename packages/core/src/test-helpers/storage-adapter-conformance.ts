/**
 * Shared `StorageAdapter` conformance test suite.
 *
 * This is a `describe`-returning function that exercises every
 * requirement of the {@link StorageAdapter} contract. Reference
 * adapters in `packages/storage-{memory,mongo,postgres}` call it; so
 * can third parties writing their own adapters.
 *
 * The suite runs against `vitest`. It imports `describe` / `it` /
 * `expect` / `beforeAll` / `afterAll` explicitly to stay
 * independent of the host project's vitest globals config.
 *
 * Coverage:
 *
 * 1.  Monotonic sequences within a scope.
 * 2.  Per-scope counter isolation (no cross-tenant bleed).
 * 3.  Counter atomicity under high concurrency.
 * 4.  ZATCA "first invoice" sentinel hash on empty scopes.
 * 5.  Hash chain head reflects the most recent recorded invoice.
 * 6.  Hash chains do not cross scope boundaries.
 * 7.  `recordInvoice` + `loadInvoice` round-trip.
 * 8.  `recordInvoice` is idempotent on `(scope, invoiceId)`.
 * 9.  Re-recording the same `invoiceId` with a different payload is a
 *     contract violation. Adapters MUST either (a) throw a
 *     `ZatcaStorageError` or (b) document an upsert override. The
 *     reference adapters in this package all throw.
 * 10. `loadInvoice` returns `null` for unknown ids.
 * 11. `updateInvoiceStatus` transitions state correctly.
 * 12. `updateInvoiceStatus` throws `ZatcaStorageError` for unknown
 *     ids.
 * 13. Multi-VAT stress test — 3 tenants × 100 concurrent invoices.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EGSUuid, InvoiceHash, VATNumber } from "../types/branded.js";
import { ZatcaStorageError } from "../types/errors.js";
import type { InvoiceKind } from "../types/invoice.js";
import type {
  InvoiceRecord,
  InvoiceStatus,
  StorageAdapter,
  TenantScope,
} from "../types/storage.js";

/**
 * The ZATCA Phase 2 "first invoice" PIH sentinel.
 *
 * This is the base64 of the *hex string* of `SHA-256("")`, which is
 * the value the rwiqha reference implementation and every adapter in
 * this monorepo return when `getPreviousHash` is called for an empty
 * scope. Exposed so adapter authors can re-use the same constant.
 */
export const ZATCA_BASE_INVOICE_HASH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

/** Sample 44-char base64 SHA-256 — `base64(sha256("a"))`. */
const SAMPLE_HASH_A =
  "ypeBEsobvcr6wjGzmiPcTaeG7/gUfE5yuYB3ha/uSLs=" as InvoiceHash;

/** Sample 44-char base64 SHA-256 — `base64(sha256("b"))`. */
const SAMPLE_HASH_B =
  "PiPoFgA5WUoziU9lZOGxNIu9egCI1CxKy3PurtWcAJ0=" as InvoiceHash;

/** Sample 44-char base64 SHA-256 — `base64(sha256("c"))`. */
const SAMPLE_HASH_C =
  "Ky7AAuiTUiHQ8eiwaHEgcaGoFE6cv2P+8utR2QwHl7g=" as InvoiceHash;

const SAMPLE_HASHES: ReadonlyArray<InvoiceHash> = [
  SAMPLE_HASH_A,
  SAMPLE_HASH_B,
  SAMPLE_HASH_C,
];

/**
 * Fixture helpers exposed to per-`it` blocks. Each call to
 * `newScope()` produces a unique `(vatNumber, egsUuid)` pair so tests
 * never collide on a shared backend; `newInvoiceRecord` fills in
 * sensible defaults for any field the test does not override.
 */
export interface ConformanceFixtures {
  newScope(): TenantScope;
  newInvoiceRecord(
    scope: TenantScope,
    overrides?: Partial<InvoiceRecord>,
  ): InvoiceRecord;
}

/**
 * Options for {@link runStorageAdapterConformance}.
 *
 * - `teardown` — called after each test with the freshly-built adapter
 *   so backends that hold open sockets or background workers can
 *   release them.
 * - `concurrency` — how many concurrent `incrementCounter` /
 *   `recordInvoice` calls the stress tests issue per scope. Defaults
 *   to 100. Lower it for adapters with tight connection pools.
 * - `skipConflictingRecordTest` — set to `true` if your adapter
 *   intentionally upserts on duplicate `invoiceId` rather than
 *   throwing. Default `false`.
 */
export interface RunConformanceOptions {
  teardown?: (adapter: StorageAdapter) => Promise<void> | void;
  concurrency?: number;
  skipConflictingRecordTest?: boolean;
}

/**
 * Generate a deterministic VAT number that satisfies the brand format
 * (15 digits, starts and ends with `3`). The middle digits are seeded
 * from `seed` so two test runs with the same seed reproduce the same
 * scope, but parallel scopes never collide within a run.
 */
function makeVatNumber(seed: number): VATNumber {
  const padded = String(seed).padStart(13, "0");
  return `3${padded}3` as VATNumber;
}

/** RFC 4122 v4 UUID. Returns a plain string; no zod runtime check. */
function makeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for runtimes without WebCrypto (unlikely on Node 20+).
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  // Set version + variant bits per RFC 4122.
  // biome-ignore lint/style/noNonNullAssertion: bytes.length === 16 guarantees indices.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  // biome-ignore lint/style/noNonNullAssertion: same as above.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let scopeSeq = 0;
function nextScopeSeed(): number {
  scopeSeq += 1;
  // Wide spread so concurrent suites in the same process don't share
  // VATs even if scopeSeq is reset by hot-reload.
  return Date.now() % 1_000_000_000 + scopeSeq;
}

function buildFixtures(): ConformanceFixtures {
  return {
    newScope(): TenantScope {
      const seed = nextScopeSeed();
      return {
        vatNumber: makeVatNumber(seed),
        egsUuid: makeUuid() as EGSUuid,
      };
    },
    newInvoiceRecord(
      scope: TenantScope,
      overrides?: Partial<InvoiceRecord>,
    ): InvoiceRecord {
      const base: InvoiceRecord = {
        invoiceId: makeUuid(),
        kind: "simplified-tax-invoice" satisfies InvoiceKind,
        serial: "INV-000001",
        counterNumber: 1,
        uuid: makeUuid(),
        invoiceHash: SAMPLE_HASH_A,
        previousInvoiceHash: ZATCA_BASE_INVOICE_HASH,
        signedXml: `<Invoice scope="${scope.vatNumber}/${scope.egsUuid}"/>`,
        qrBase64: "QkFTRTY0LVFS",
        issuedAt: new Date(),
        status: "pending" satisfies InvoiceStatus,
      };
      return { ...base, ...overrides };
    },
  };
}

/**
 * Mount the shared conformance suite against an adapter factory.
 *
 * The `factory` is invoked once per top-level `describe` (i.e. once
 * per call to `runStorageAdapterConformance`). Tests share the
 * adapter; isolation is achieved by minting a fresh `TenantScope` per
 * `it` block via {@link ConformanceFixtures.newScope}.
 *
 * Mongo / Postgres adapters can pass `teardown` so they can close
 * their connection pool after the suite finishes.
 */
export function runStorageAdapterConformance(
  factory: () => Promise<StorageAdapter> | StorageAdapter,
  options: RunConformanceOptions = {},
): void {
  const concurrency = options.concurrency ?? 100;
  const skipConflict = options.skipConflictingRecordTest ?? false;

  describe("StorageAdapter conformance", () => {
    const fixtures = buildFixtures();
    let adapter: StorageAdapter;

    beforeAll(async () => {
      adapter = await factory();
    });

    afterAll(async () => {
      if (options.teardown !== undefined) {
        await options.teardown(adapter);
      }
    });

    // ---------------------------------------------------------------------
    // Counter semantics
    // ---------------------------------------------------------------------

    it("incrementCounter issues strictly increasing sequences within a scope", async () => {
      const scope = fixtures.newScope();
      const a = await adapter.incrementCounter(scope);
      const b = await adapter.incrementCounter(scope);
      const c = await adapter.incrementCounter(scope);
      expect(b.sequence).toBeGreaterThan(a.sequence);
      expect(c.sequence).toBeGreaterThan(b.sequence);
      expect(a.invoiceNumber).not.toEqual(b.invoiceNumber);
      expect(b.invoiceNumber).not.toEqual(c.invoiceNumber);
    });

    it("incrementCounter scopes sequences per (vatNumber, egsUuid)", async () => {
      const scopeA = fixtures.newScope();
      const scopeB = fixtures.newScope();
      const a1 = await adapter.incrementCounter(scopeA);
      const a2 = await adapter.incrementCounter(scopeA);
      const b1 = await adapter.incrementCounter(scopeB);
      const b2 = await adapter.incrementCounter(scopeB);
      // Each scope's first call returns 1, second call returns 2 —
      // independent of any other scope's traffic.
      expect(a1.sequence).toBe(1);
      expect(a2.sequence).toBe(2);
      expect(b1.sequence).toBe(1);
      expect(b2.sequence).toBe(2);
    });

    it("incrementCounter is atomic under concurrent calls", async () => {
      const scope = fixtures.newScope();
      const results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          adapter.incrementCounter(scope),
        ),
      );
      const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
      const distinct = new Set(sequences);
      expect(distinct.size).toBe(concurrency);
      // Sequences must be exactly 1..concurrency for a brand-new scope.
      expect(sequences[0]).toBe(1);
      expect(sequences[sequences.length - 1]).toBe(concurrency);
    });

    // ---------------------------------------------------------------------
    // Hash chain
    // ---------------------------------------------------------------------

    it("getPreviousHash returns the spec sentinel when no prior invoice exists", async () => {
      const scope = fixtures.newScope();
      const hash = await adapter.getPreviousHash(scope);
      expect(hash).toBe(ZATCA_BASE_INVOICE_HASH);
    });

    it("getPreviousHash returns the most recent invoice hash within a scope", async () => {
      const scope = fixtures.newScope();
      // Record three invoices with distinct hashes, in time order.
      for (let i = 0; i < SAMPLE_HASHES.length; i += 1) {
        const hash = SAMPLE_HASHES[i] as InvoiceHash;
        await adapter.recordInvoice(
          scope,
          fixtures.newInvoiceRecord(scope, {
            invoiceHash: hash,
            counterNumber: i + 1,
            serial: `INV-${String(i + 1).padStart(6, "0")}`,
            issuedAt: new Date(Date.now() + i * 10),
          }),
        );
      }
      const head = await adapter.getPreviousHash(scope);
      expect(head).toBe(SAMPLE_HASH_C);
    });

    it("getPreviousHash does not bleed across (vatNumber, egsUuid) scopes", async () => {
      const scopeA = fixtures.newScope();
      const scopeB = fixtures.newScope();
      await adapter.recordInvoice(
        scopeA,
        fixtures.newInvoiceRecord(scopeA, { invoiceHash: SAMPLE_HASH_A }),
      );
      const headA = await adapter.getPreviousHash(scopeA);
      const headB = await adapter.getPreviousHash(scopeB);
      expect(headA).toBe(SAMPLE_HASH_A);
      expect(headB).toBe(ZATCA_BASE_INVOICE_HASH);
    });

    // ---------------------------------------------------------------------
    // Record / load / status
    // ---------------------------------------------------------------------

    it("recordInvoice followed by loadInvoice round-trips the record", async () => {
      const scope = fixtures.newScope();
      const record = fixtures.newInvoiceRecord(scope);
      await adapter.recordInvoice(scope, record);
      const loaded = await adapter.loadInvoice(scope, record.invoiceId);
      expect(loaded).not.toBeNull();
      // Compare field-by-field; some adapters round-trip Date through
      // ISO strings, so normalize.
      if (loaded === null) {
        throw new Error("expected loaded record to be non-null");
      }
      expect(loaded.invoiceId).toBe(record.invoiceId);
      expect(loaded.kind).toBe(record.kind);
      expect(loaded.serial).toBe(record.serial);
      expect(loaded.counterNumber).toBe(record.counterNumber);
      expect(loaded.uuid).toBe(record.uuid);
      expect(loaded.invoiceHash).toBe(record.invoiceHash);
      expect(loaded.previousInvoiceHash).toBe(record.previousInvoiceHash);
      expect(loaded.signedXml).toBe(record.signedXml);
      expect(loaded.qrBase64).toBe(record.qrBase64);
      expect(loaded.status).toBe(record.status);
      expect(loaded.issuedAt.getTime()).toBe(record.issuedAt.getTime());
    });

    it("recordInvoice is idempotent on (scope, invoiceId)", async () => {
      const scope = fixtures.newScope();
      const record = fixtures.newInvoiceRecord(scope);
      await adapter.recordInvoice(scope, record);
      await adapter.recordInvoice(scope, record);
      const loaded = await adapter.loadInvoice(scope, record.invoiceId);
      expect(loaded).not.toBeNull();
    });

    if (!skipConflict) {
      it("recordInvoice rejects re-record with a conflicting payload", async () => {
        const scope = fixtures.newScope();
        const record = fixtures.newInvoiceRecord(scope);
        await adapter.recordInvoice(scope, record);
        const mutated: InvoiceRecord = {
          ...record,
          invoiceHash: SAMPLE_HASH_B,
        };
        await expect(adapter.recordInvoice(scope, mutated)).rejects.toBeInstanceOf(
          ZatcaStorageError,
        );
      });
    }

    it("loadInvoice returns null for an unknown invoiceId", async () => {
      const scope = fixtures.newScope();
      const loaded = await adapter.loadInvoice(scope, makeUuid());
      expect(loaded).toBeNull();
    });

    it("updateInvoiceStatus transitions the persisted status", async () => {
      const scope = fixtures.newScope();
      const record = fixtures.newInvoiceRecord(scope, { status: "pending" });
      await adapter.recordInvoice(scope, record);
      await adapter.updateInvoiceStatus(scope, record.invoiceId, "accepted");
      const loaded = await adapter.loadInvoice(scope, record.invoiceId);
      expect(loaded?.status).toBe("accepted");
    });

    it("updateInvoiceStatus throws ZatcaStorageError for an unknown invoiceId", async () => {
      const scope = fixtures.newScope();
      await expect(
        adapter.updateInvoiceStatus(scope, makeUuid(), "accepted"),
      ).rejects.toBeInstanceOf(ZatcaStorageError);
    });

    // ---------------------------------------------------------------------
    // Multi-VAT stress
    // ---------------------------------------------------------------------

    it("handles multi-VAT concurrent traffic without collisions", async () => {
      const scopes = [
        fixtures.newScope(),
        fixtures.newScope(),
        fixtures.newScope(),
      ];
      const perScope = concurrency;
      // Fire perScope `incrementCounter` calls per scope, all in
      // parallel. After settlement, each scope must have seen exactly
      // sequences 1..perScope.
      const all = scopes.flatMap((scope) =>
        Array.from({ length: perScope }, async () => {
          const next = await adapter.incrementCounter(scope);
          return { scope, sequence: next.sequence };
        }),
      );
      const settled = await Promise.all(all);
      for (const scope of scopes) {
        const mine = settled
          .filter((s) => s.scope === scope)
          .map((s) => s.sequence)
          .sort((a, b) => a - b);
        const distinct = new Set(mine);
        expect(mine.length).toBe(perScope);
        expect(distinct.size).toBe(perScope);
        expect(mine[0]).toBe(1);
        expect(mine[mine.length - 1]).toBe(perScope);
      }
    });
  });
}
