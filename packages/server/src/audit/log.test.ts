import { describe, expect, it } from "vitest";

import { createMemoryAuditLog } from "./log.js";

describe("createMemoryAuditLog", () => {
  it("assigns a uuid + server-clock timestamp on write", async () => {
    const log = createMemoryAuditLog();
    const entry = await log.write({
      actor: { type: "admin", label: "ops" },
      action: "tenant.created",
      result: "ok",
    });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.at).toBeInstanceOf(Date);
  });

  it("persists every supplied field", async () => {
    const log = createMemoryAuditLog();
    const entry = await log.write({
      actor: { type: "tenant", tenantRef: "acme", tokenId: "tk_1" },
      tenantRef: "acme",
      action: "invoice.issued",
      targetId: "inv-001",
      result: "ok",
      zatcaRequestId: "req-zatca-1",
      requestId: "req-internal-1",
      payload: { kind: "simplified" },
    });
    expect(entry.actor).toEqual({ type: "tenant", tenantRef: "acme", tokenId: "tk_1" });
    expect(entry.tenantRef).toBe("acme");
    expect(entry.targetId).toBe("inv-001");
    expect(entry.zatcaRequestId).toBe("req-zatca-1");
    expect(entry.payload).toEqual({ kind: "simplified" });
  });

  it("appends; never updates or deletes", async () => {
    const log = createMemoryAuditLog();
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
    const all = await log.list();
    expect(all).toHaveLength(2);
  });

  describe("list filters", () => {
    async function seed() {
      const log = createMemoryAuditLog();
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
      return log;
    }

    it("filters by tenantRef", async () => {
      const log = await seed();
      const rows = await log.list({ tenantRef: "acme" });
      expect(rows).toHaveLength(2);
    });

    it("filters by action", async () => {
      const log = await seed();
      const rows = await log.list({ action: "invoice.issued" });
      expect(rows).toHaveLength(2);
    });

    it("filters by actor type", async () => {
      const log = await seed();
      const adminRows = await log.list({ actorType: "admin" });
      expect(adminRows).toHaveLength(1);
      expect(adminRows[0]?.action).toBe("tenant.created");
    });

    it("filters by result", async () => {
      const log = await seed();
      const errorRows = await log.list({ result: "error" });
      expect(errorRows).toHaveLength(1);
      expect(errorRows[0]?.tenantRef).toBe("globex");
    });

    it("returns newest-first", async () => {
      const log = await seed();
      const rows = await log.list();
      expect(rows[0]?.action).toBe("invoice.issued");
      expect(rows[rows.length - 1]?.action).toBe("tenant.created");
    });

    it("caps at the supplied limit", async () => {
      const log = await seed();
      expect(await log.list({ limit: 1 })).toHaveLength(1);
    });
  });
});
