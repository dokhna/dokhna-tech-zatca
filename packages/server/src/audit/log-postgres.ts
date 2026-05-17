/**
 * Postgres-backed `AuditLog` implementation.
 *
 * Pairs with `createPostgresRegistry` in `tenants/registry-postgres.ts`.
 * The two share connection pools; the HTTP layer in PR3 will wrap a
 * mutation + audit-write into a single transaction via
 * {@link withPgTransaction}.
 */

import { randomUUID } from "node:crypto";

import type { PgQueryable } from "../tenants/registry-postgres.js";
import type {
  AuditActor,
  AuditEntry,
  AuditEntryInput,
  AuditListFilter,
  AuditLog,
  AuditResult,
} from "./log.js";
import { capAuditPayload } from "./redact.js";

type AuditRow = {
  id: string;
  at: Date | string;
  actor_type: string;
  actor: unknown;
  tenant_ref: string | null;
  action: string;
  target_id: string | null;
  result: string;
  zatca_request_id: string | null;
  request_id: string | null;
  payload: unknown;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToEntry(row: AuditRow): AuditEntry {
  const out: Record<string, unknown> = {
    id: row.id,
    at: toDate(row.at),
    actor: row.actor as AuditActor,
    action: row.action,
    result: row.result as AuditResult,
  };
  if (row.tenant_ref !== null) out.tenantRef = row.tenant_ref;
  if (row.target_id !== null) out.targetId = row.target_id;
  if (row.zatca_request_id !== null) out.zatcaRequestId = row.zatca_request_id;
  if (row.request_id !== null) out.requestId = row.request_id;
  if (row.payload !== null && row.payload !== undefined) {
    out.payload = row.payload as Readonly<Record<string, unknown>>;
  }
  return out as unknown as AuditEntry;
}

/**
 * Constructor options for the Postgres audit log.
 */
export interface PostgresAuditLogOptions {
  readonly pool: PgQueryable;
  readonly now?: () => Date;
}

export function createPostgresAuditLog(options: PostgresAuditLogOptions): AuditLog {
  const { pool } = options;
  const clock = options.now ?? (() => new Date());

  return {
    async write(input: AuditEntryInput): Promise<AuditEntry> {
      const id = randomUUID();
      const at = clock();
      // ME-25: cap payload size before it hits jsonb.
      const cappedPayload = capAuditPayload(input.payload);
      await pool.query(
        `INSERT INTO zatca_server_audit_log (
           id, at, actor_type, actor, tenant_ref, action, target_id,
           result, zatca_request_id, request_id, payload
         ) VALUES (
           $1, $2, $3, $4::jsonb, $5, $6, $7,
           $8, $9, $10, $11::jsonb
         )`,
        [
          id,
          at,
          input.actor.type,
          JSON.stringify(input.actor),
          input.tenantRef ?? null,
          input.action,
          input.targetId ?? null,
          input.result,
          input.zatcaRequestId ?? null,
          input.requestId ?? null,
          cappedPayload === undefined ? null : JSON.stringify(cappedPayload),
        ],
      );
      // Construct the returned record directly so callers don't pay
      // for an extra round-trip.
      const out: Record<string, unknown> = {
        id,
        at,
        actor: input.actor,
        action: input.action,
        result: input.result,
      };
      if (input.tenantRef !== undefined) out.tenantRef = input.tenantRef;
      if (input.targetId !== undefined) out.targetId = input.targetId;
      if (input.zatcaRequestId !== undefined) out.zatcaRequestId = input.zatcaRequestId;
      if (input.requestId !== undefined) out.requestId = input.requestId;
      if (cappedPayload !== undefined) out.payload = cappedPayload;
      return out as unknown as AuditEntry;
    },

    async list(filter: AuditListFilter = {}) {
      const where: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (filter.tenantRef !== undefined) {
        where.push(`tenant_ref = $${i++}`);
        values.push(filter.tenantRef);
      }
      if (filter.action !== undefined) {
        where.push(`action = $${i++}`);
        values.push(filter.action);
      }
      if (filter.actorType !== undefined) {
        where.push(`actor_type = $${i++}`);
        values.push(filter.actorType);
      }
      if (filter.result !== undefined) {
        where.push(`result = $${i++}`);
        values.push(filter.result);
      }
      if (filter.since !== undefined) {
        where.push(`at >= $${i++}`);
        values.push(filter.since);
      }
      if (filter.until !== undefined) {
        where.push(`at <= $${i++}`);
        values.push(filter.until);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const limit = filter.limit ?? 100;
      values.push(limit);
      const result = await pool.query<AuditRow>(
        `SELECT id, at, actor_type, actor, tenant_ref, action, target_id,
                result, zatca_request_id, request_id, payload
         FROM zatca_server_audit_log
         ${whereSql}
         ORDER BY at DESC
         LIMIT $${i}`,
        values,
      );
      return result.rows.map(rowToEntry);
    },
  };
}
