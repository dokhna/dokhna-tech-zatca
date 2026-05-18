import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";

import type { PgQueryable } from "../tenants/registry-postgres.js";

import { createPostgresAuditLog } from "./log-postgres.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, "..", "..", "migrations", "postgres", "001_initial.sql");

async function freshPool(): Promise<PgQueryable> {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as PgQueryable;
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  await pool.query(sql);
  return pool;
}

describe("createPostgresAuditLog", () => {
  let pool: PgQueryable;

  beforeEach(async () => {
    pool = await freshPool();
  });

  it("assigns a uuid + clock timestamp on write", async () => {
    const log = createPostgresAuditLog({ pool });
    const entry = await log.write({
      actor: { type: "admin", label: "ops" },
      action: "tenant.created",
      result: "ok",
    });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.at).toBeInstanceOf(Date);
  });

  it("persists every supplied field", async () => {
    const log = createPostgresAuditLog({ pool });
    await log.write({
      actor: { type: "tenant", tenantRef: "acme", tokenId: "tk_1" },
      tenantRef: "acme",
      action: "invoice.issued",
      targetId: "inv-001",
      result: "ok",
      zatcaRequestId: "req-zatca-1",
      requestId: "req-internal-1",
      payload: { kind: "simplified" },
    });
    const rows = await log.list();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.actor).toEqual({ type: "tenant", tenantRef: "acme", tokenId: "tk_1" });
    expect(row?.tenantRef).toBe("acme");
    expect(row?.targetId).toBe("inv-001");
    expect(row?.zatcaRequestId).toBe("req-zatca-1");
    expect(row?.requestId).toBe("req-internal-1");
    expect(row?.payload).toEqual({ kind: "simplified" });
  });

  it("appends; never updates or deletes", async () => {
    const log = createPostgresAuditLog({ pool });
    await log.write({
      actor: { type: "admin", label: "ops" },
      action: "tenant.created",
      result: "ok",
    });
    await log.write({
      actor: { type: "admin", label: "ops" },
      action: "tenant.softDeleted",
      result: "ok",
    });
    expect(await log.list()).toHaveLength(2);
  });

  describe("list filters", () => {
    async function seed(log: ReturnType<typeof createPostgresAuditLog>) {
      await log.write({
        actor: { type: "admin", label: "ops" },
        tenantRef: "acme",
        action: "tenant.created",
        result: "ok",
      });
      await log.write({
        actor: { type: "tenant", tenantRef: "acme", tokenId: "tk_1" },
        tenantRef: "acme",
        action: "invoice.issued",
        result: "ok",
      });
      await log.write({
        actor: { type: "tenant", tenantRef: "globex", tokenId: "tk_2" },
        tenantRef: "globex",
        action: "invoice.issued",
        result: "error",
      });
    }

    it("filters by tenantRef", async () => {
      const log = createPostgresAuditLog({ pool });
      await seed(log);
      expect(await log.list({ tenantRef: "acme" })).toHaveLength(2);
    });

    it("filters by action", async () => {
      const log = createPostgresAuditLog({ pool });
      await seed(log);
      expect(await log.list({ action: "invoice.issued" })).toHaveLength(2);
    });

    it("filters by actor type", async () => {
      const log = createPostgresAuditLog({ pool });
      await seed(log);
      const admin = await log.list({ actorType: "admin" });
      expect(admin).toHaveLength(1);
      expect(admin[0]?.action).toBe("tenant.created");
    });

    it("filters by result", async () => {
      const log = createPostgresAuditLog({ pool });
      await seed(log);
      const errors = await log.list({ result: "error" });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.tenantRef).toBe("globex");
    });

    it("caps at supplied limit", async () => {
      const log = createPostgresAuditLog({ pool });
      await seed(log);
      expect(await log.list({ limit: 1 })).toHaveLength(1);
    });
  });
});
