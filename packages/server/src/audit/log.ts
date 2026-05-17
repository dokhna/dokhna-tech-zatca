/**
 * Append-only audit log for tenant + invoice + admin operations.
 *
 * ZATCA is a tax authority — every mutation must be auditable with
 * actor + timestamp + ZATCA `requestId` (when present) for the Saudi
 * tax-record retention period. The DB-backed impls in PR2 write each
 * row in the same transaction as the mutation; the in-memory impl
 * here keeps the contract honest in tests but obviously cannot offer
 * a real transactional guarantee.
 *
 * Callers MUST pre-redact secret material out of `payload` before
 * handing it to `write` — `redactSecrets` is the supplied helper.
 * The log never tries to interpret `payload`; it just persists what
 * it's given.
 */

import { randomUUID } from "node:crypto";

/**
 * What kind of caller initiated the mutation.
 *
 * - `admin`  — admin bearer matched; `label` is the matched key label.
 * - `tenant` — tenant bearer matched; `tenantRef` + `tokenId` identify it.
 * - `system` — server-initiated (background expiry sweep, lock cleanup).
 */
export type AuditActor =
  | { readonly type: "admin"; readonly label: string }
  | { readonly type: "tenant"; readonly tenantRef: string; readonly tokenId: string }
  | { readonly type: "system" };

/**
 * Catalogue of mutating actions. Closed set so audit queries can
 * filter / aggregate without parsing strings. New actions get added
 * here as routes land.
 */
export type AuditAction =
  | "tenant.created"
  | "tenant.patched"
  | "tenant.softDeleted"
  | "tenant.onboarded"
  | "tenant.credentialsRotated"
  | "tenant.unlocked"
  | "tenant.stateTransitioned"
  | "invoice.issued"
  | "invoice.cancelled"
  | "invoice.statusChecked"
  | "invoice.complianceChecked"
  | "apiKey.issued"
  | "apiKey.revoked";

/**
 * Per-row outcome — `ok` for a successful mutation, `error` for one
 * that failed (the row is still written so the failure is auditable).
 */
export type AuditResult = "ok" | "error";

/**
 * Caller-supplied fields. `at`, `id`, and any defaults are filled in
 * by the log on write.
 */
export interface AuditEntryInput {
  readonly actor: AuditActor;
  readonly tenantRef?: string;
  readonly action: AuditAction;
  readonly targetId?: string;
  readonly result: AuditResult;
  readonly zatcaRequestId?: string;
  readonly requestId?: string;
  /**
   * Pre-redacted payload. Callers MUST scrub OTPs, private keys, BSTs,
   * api secrets, and bearer tokens BEFORE calling `write`. See
   * `redactSecrets`.
   */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Persisted audit row.
 */
export interface AuditEntry extends AuditEntryInput {
  readonly id: string;
  readonly at: Date;
}

/**
 * Filter accepted by `AuditLog.list`. All fields are AND-combined.
 */
export interface AuditListFilter {
  readonly tenantRef?: string;
  readonly action?: AuditAction;
  readonly actorType?: AuditActor["type"];
  readonly since?: Date;
  readonly until?: Date;
  readonly result?: AuditResult;
  /** Cap on the number of rows returned. Defaults to 100. */
  readonly limit?: number;
}

/**
 * Append-only audit log.
 *
 * Implementations MUST:
 * - Assign a stable, unique `id` per write.
 * - Stamp `at` to the server clock at write time.
 * - Never mutate or delete an existing row (no update, no soft delete).
 * - Return rows newest-first from `list`.
 */
export interface AuditLog {
  write(input: AuditEntryInput): Promise<AuditEntry>;
  list(filter?: AuditListFilter): Promise<ReadonlyArray<AuditEntry>>;
}

/**
 * Build an in-process audit log. State lives in a single array;
 * intended for tests + dev. The DB-backed impls in PR2 use real
 * append-only tables with the same contract.
 */
export function createMemoryAuditLog(options: { now?: () => Date } = {}): AuditLog {
  const clock = options.now ?? (() => new Date());
  const rows: AuditEntry[] = [];

  return {
    async write(input: AuditEntryInput) {
      const entry: AuditEntry = {
        id: randomUUID(),
        at: clock(),
        actor: input.actor,
        ...(input.tenantRef !== undefined ? { tenantRef: input.tenantRef } : {}),
        action: input.action,
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        result: input.result,
        ...(input.zatcaRequestId !== undefined ? { zatcaRequestId: input.zatcaRequestId } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      };
      rows.push(entry);
      return entry;
    },

    async list(filter: AuditListFilter = {}) {
      const out: AuditEntry[] = [];
      // Walk in reverse insertion order so LIFO is preserved for
      // ties when the clock returns identical instants for adjacent
      // writes (common in tests; possible in production under fast
      // sub-millisecond bursts).
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i] as AuditEntry;
        if (filter.tenantRef !== undefined && row.tenantRef !== filter.tenantRef) continue;
        if (filter.action !== undefined && row.action !== filter.action) continue;
        if (filter.actorType !== undefined && row.actor.type !== filter.actorType) continue;
        if (filter.result !== undefined && row.result !== filter.result) continue;
        if (filter.since !== undefined && row.at < filter.since) continue;
        if (filter.until !== undefined && row.at > filter.until) continue;
        out.push(row);
      }
      // V8's sort is stable: equal timestamps preserve LIFO order
      // from the reverse walk above.
      out.sort((a, b) => b.at.getTime() - a.at.getTime());
      const limit = filter.limit ?? 100;
      return out.slice(0, limit);
    },
  };
}
