/**
 * Integration tests for the Postgres-backed registry against `pg-mem`.
 *
 * `pg-mem` is an in-process Postgres mock — covers the SQL paths
 * exercised by the adapter (DDL, JSONB columns, bytea columns, ON
 * CONFLICT DO UPDATE, jsonb_set). Indexes are advisory for
 * correctness, not honoured for query planning. That's fine — these
 * tests cover the contract, not the query plan.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asCommercialRegistrationNumber, asEGSUuid, asVATNumber } from "@dokhna-tech/zatca";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";

import { createAesGcmCipher, type MasterKey } from "../crypto/aes-gcm-cipher.js";
import { ZatcaCipherError, ZatcaRegistryError } from "../errors.js";

import {
  createPostgresApiKeyStore,
  createPostgresCredentialVault,
  createPostgresRegistry,
  createPostgresTenantStore,
  generateTenantRef,
  type PgQueryable,
} from "./registry-postgres.js";
import type { CreateTenantInput, TenantLocation } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, "..", "..", "migrations", "postgres", "001_initial.sql");

const LOCATION: TenantLocation = {
  cityName: "Riyadh",
  citySubdivision: "Olaya",
  street: "King Fahd Rd",
  plotIdentification: "1234",
  building: "5678",
  postalZone: "12345",
};

function buildInput(overrides: Partial<CreateTenantInput> = {}): CreateTenantInput {
  return {
    vatNumber: asVATNumber("301234567890003"),
    egsUuid: asEGSUuid("00000000-0000-4000-8000-000000000001"),
    vatName: "Acme Trading Co.",
    crn: asCommercialRegistrationNumber("1010010101"),
    branchName: "Riyadh HQ",
    branchIndustry: "Retail",
    location: LOCATION,
    environment: "simulation",
    ...overrides,
  };
}

function key(kid: string): MasterKey {
  return { kid, key: Buffer.alloc(32, kid.charCodeAt(0)) };
}

function freshCipher() {
  return createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
}

async function freshPool(): Promise<PgQueryable> {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as PgQueryable;
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  await pool.query(sql);
  return pool;
}

describe("createPostgresTenantStore", () => {
  let pool: PgQueryable;

  beforeEach(async () => {
    pool = await freshPool();
  });

  it("generates a tenantRef when none supplied + persists clean defaults", async () => {
    const store = createPostgresTenantStore({ pool });
    const record = await store.create(buildInput());
    expect(record.tenantRef).toMatch(/^[a-z2-7]+$/);
    expect(record.state).toBe("created");
    expect(record.onboardingProgress.scenarios).toEqual({});
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it("uses caller-supplied tenantRef when provided", async () => {
    const store = createPostgresTenantStore({ pool });
    const record = await store.create(buildInput({ tenantRef: "acme" }));
    expect(record.tenantRef).toBe("acme");
  });

  it("rejects duplicate tenantRef as ZatcaRegistryError", async () => {
    const store = createPostgresTenantStore({ pool });
    await store.create(buildInput({ tenantRef: "acme" }));
    await expect(store.create(buildInput({ tenantRef: "acme" }))).rejects.toThrow(
      ZatcaRegistryError,
    );
  });

  it("returns null for get(unknown) and for soft-deleted records", async () => {
    const store = createPostgresTenantStore({ pool });
    expect(await store.get("missing")).toBeNull();
    await store.create(buildInput({ tenantRef: "acme" }));
    await store.softDelete("acme");
    expect(await store.get("acme")).toBeNull();
  });

  it("patch updates mutable metadata only", async () => {
    const store = createPostgresTenantStore({ pool });
    const created = await store.create(buildInput({ tenantRef: "acme" }));
    const updated = await store.patch("acme", { branchName: "New Branch", label: "test" });
    expect(updated.branchName).toBe("New Branch");
    expect(updated.label).toBe("test");
    expect(updated.vatNumber).toBe(created.vatNumber);
    expect(updated.egsUuid).toBe(created.egsUuid);
  });

  it("patch on unknown tenant throws ZatcaRegistryError", async () => {
    const store = createPostgresTenantStore({ pool });
    await expect(store.patch("missing", { label: "x" })).rejects.toThrow(ZatcaRegistryError);
  });

  describe("setState (CAS)", () => {
    it("transitions without a guard", async () => {
      const store = createPostgresTenantStore({ pool });
      await store.create(buildInput({ tenantRef: "acme" }));
      const out = await store.setState("acme", "production-ready");
      expect(out.state).toBe("production-ready");
    });

    it("rejects when expectedFrom does not match current state", async () => {
      const store = createPostgresTenantStore({ pool });
      await store.create(buildInput({ tenantRef: "acme" }));
      await expect(
        store.setState("acme", "onboarding", { expectedFrom: "production-ready" }),
      ).rejects.toThrow(/Cannot transition tenant 'acme' from 'created'/);
    });

    it("reclaims an expired claim regardless of expectedFrom", async () => {
      const store = createPostgresTenantStore({ pool });
      await store.create(buildInput({ tenantRef: "acme" }));
      await store.setState("acme", "onboarding", {
        expectedFrom: "created",
        claimedBy: "dead-instance",
        claimExpiresAt: new Date(Date.now() - 1000),
      });
      const reclaimed = await store.setState("acme", "onboarding", {
        expectedFrom: "created",
        claimedBy: "fresh-instance",
        claimExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(reclaimed.claimedBy).toBe("fresh-instance");
    });

    it("records lastError on failed state", async () => {
      const store = createPostgresTenantStore({ pool });
      await store.create(buildInput({ tenantRef: "acme" }));
      const out = await store.setState("acme", "failed", { lastError: "OTP rejected" });
      expect(out.onboardingProgress.lastError).toBe("OTP rejected");
    });

    it("unknown tenant throws ZatcaRegistryError with the right shape", async () => {
      const store = createPostgresTenantStore({ pool });
      await expect(store.setState("missing", "production-ready")).rejects.toThrow(
        /Unknown tenant 'missing'/,
      );
    });
  });

  describe("recordOnboardingProgress", () => {
    it("appends scenario results", async () => {
      const store = createPostgresTenantStore({ pool });
      await store.create(buildInput({ tenantRef: "acme" }));
      await store.recordOnboardingProgress("acme", "standard-invoice", true);
      await store.recordOnboardingProgress("acme", "simplified-invoice", false);
      const record = await store.get("acme");
      expect(record?.onboardingProgress.scenarios).toEqual({
        "standard-invoice": "passed",
        "simplified-invoice": "failed",
      });
    });

    it("overwrites prior result for the same scenario", async () => {
      const store = createPostgresTenantStore({ pool });
      await store.create(buildInput({ tenantRef: "acme" }));
      await store.recordOnboardingProgress("acme", "scenario-1", false);
      await store.recordOnboardingProgress("acme", "scenario-1", true);
      const record = await store.get("acme");
      expect(record?.onboardingProgress.scenarios["scenario-1"]).toBe("passed");
    });
  });

  describe("list filters", () => {
    async function seed(store: ReturnType<typeof createPostgresTenantStore>) {
      await store.create(buildInput({ tenantRef: "a", environment: "simulation" }));
      await store.create(
        buildInput({
          tenantRef: "b",
          environment: "production",
          egsUuid: asEGSUuid("00000000-0000-4000-8000-000000000002"),
        }),
      );
    }

    it("filters by environment", async () => {
      const store = createPostgresTenantStore({ pool });
      await seed(store);
      const sim = await store.list({ environment: "simulation" });
      expect(sim.map((r) => r.tenantRef)).toEqual(["a"]);
    });

    it("hides soft-deleted by default and exposes with includeDeleted", async () => {
      const store = createPostgresTenantStore({ pool });
      await seed(store);
      await store.softDelete("a");
      expect(await store.list()).toHaveLength(1);
      expect(await store.list({ includeDeleted: true })).toHaveLength(2);
    });

    it("filters by expiringWithinDays", async () => {
      const store = createPostgresTenantStore({ pool });
      await seed(store);
      const soon = new Date(Date.now() + 5 * 86_400_000);
      const later = new Date(Date.now() + 60 * 86_400_000);
      await store.setProductionExpiry("a", soon);
      await store.setProductionExpiry("b", later);
      const expiring = await store.list({ expiringWithinDays: 30 });
      expect(expiring.map((r) => r.tenantRef)).toEqual(["a"]);
    });
  });
});

describe("createPostgresCredentialVault", () => {
  let pool: PgQueryable;

  beforeEach(async () => {
    pool = await freshPool();
  });

  it("returns null for unknown tenant", async () => {
    const vault = createPostgresCredentialVault({ pool, cipher: freshCipher() });
    expect(await vault.get("missing")).toBeNull();
  });

  it("round-trips full signer material via the cipher", async () => {
    const store = createPostgresTenantStore({ pool });
    await store.create(buildInput({ tenantRef: "acme" }));
    const vault = createPostgresCredentialVault({ pool, cipher: freshCipher() });
    await vault.put("acme", {
      privateKey: "PRIV",
      productionCertificate: "PROD-CERT",
      productionBinarySecurityToken: "PROD-BST",
      productionApiSecret: "PROD-SECRET",
      complianceCertificate: "COMP-CERT",
      complianceBinarySecurityToken: "COMP-BST",
      complianceApiSecret: "COMP-SECRET",
    });
    const out = await vault.get("acme");
    expect(out).toEqual({
      privateKey: "PRIV",
      productionCertificate: "PROD-CERT",
      productionBinarySecurityToken: "PROD-BST",
      productionApiSecret: "PROD-SECRET",
      complianceCertificate: "COMP-CERT",
      complianceBinarySecurityToken: "COMP-BST",
      complianceApiSecret: "COMP-SECRET",
    });
  });

  it("upsert overwrites on subsequent put", async () => {
    const store = createPostgresTenantStore({ pool });
    await store.create(buildInput({ tenantRef: "acme" }));
    const vault = createPostgresCredentialVault({ pool, cipher: freshCipher() });
    await vault.put("acme", {
      privateKey: "P1",
      productionCertificate: "C1",
      productionBinarySecurityToken: "B1",
      productionApiSecret: "S1",
    });
    await vault.put("acme", {
      privateKey: "P2",
      productionCertificate: "C2",
      productionBinarySecurityToken: "B2",
      productionApiSecret: "S2",
    });
    expect((await vault.get("acme"))?.privateKey).toBe("P2");
  });

  it("decrypt failure surfaces as ZatcaCipherError", async () => {
    const store = createPostgresTenantStore({ pool });
    await store.create(buildInput({ tenantRef: "acme" }));
    const writer = createPostgresCredentialVault({ pool, cipher: freshCipher() });
    await writer.put("acme", {
      privateKey: "PRIV",
      productionCertificate: "C",
      productionBinarySecurityToken: "B",
      productionApiSecret: "S",
    });
    // New cipher with a different key — decrypt will fail auth tag.
    const reader = createPostgresCredentialVault({
      pool,
      cipher: createAesGcmCipher({ keyring: [key("v2")], activeKid: "v2" }),
    });
    await expect(reader.get("acme")).rejects.toThrow(ZatcaCipherError);
  });

  it("delete removes the row", async () => {
    const store = createPostgresTenantStore({ pool });
    await store.create(buildInput({ tenantRef: "acme" }));
    const vault = createPostgresCredentialVault({ pool, cipher: freshCipher() });
    await vault.put("acme", {
      privateKey: "P",
      productionCertificate: "C",
      productionBinarySecurityToken: "B",
      productionApiSecret: "S",
    });
    await vault.delete("acme");
    expect(await vault.get("acme")).toBeNull();
  });
});

describe("createPostgresApiKeyStore", () => {
  let pool: PgQueryable;

  beforeEach(async () => {
    pool = await freshPool();
  });

  async function seedTenant(ref: string): Promise<void> {
    const store = createPostgresTenantStore({ pool });
    await store.create(buildInput({ tenantRef: ref }));
  }

  it("issues + resolves a fresh token", async () => {
    await seedTenant("acme");
    const apiKeys = createPostgresApiKeyStore({ pool });
    const issued = await apiKeys.issue("acme", "ops");
    expect(issued.token).toMatch(/^zts_live_acme_[A-Z2-7]{32}$/);
    const resolved = await apiKeys.resolve(issued.token);
    expect(resolved?.tenantRef).toBe("acme");
    expect(resolved?.tokenId).toBe(issued.tokenId);
  });

  it("rejects a malformed token", async () => {
    const apiKeys = createPostgresApiKeyStore({ pool });
    expect(await apiKeys.resolve("not-a-token")).toBeNull();
  });

  it("rejects a token whose env prefix does not match the store", async () => {
    await seedTenant("acme");
    const liveStore = createPostgresApiKeyStore({ pool, env: "live" });
    const testStore = createPostgresApiKeyStore({ pool, env: "test" });
    const liveIssued = await liveStore.issue("acme", "k");
    expect(await testStore.resolve(liveIssued.token)).toBeNull();
  });

  it("revoke makes the token unresolvable", async () => {
    await seedTenant("acme");
    const apiKeys = createPostgresApiKeyStore({ pool });
    const issued = await apiKeys.issue("acme", "k");
    const ok = await apiKeys.revoke("acme", issued.tokenId);
    expect(ok).toBe(true);
    expect(await apiKeys.resolve(issued.token)).toBeNull();
  });

  it("revoke refuses cross-tenant attempts and leaves the row intact (CR-04)", async () => {
    await seedTenant("acme");
    await seedTenant("globex");
    const apiKeys = createPostgresApiKeyStore({ pool });
    const issued = await apiKeys.issue("acme", "k");
    // Wrong tenant — must return false AND leave the token live.
    expect(await apiKeys.revoke("globex", issued.tokenId)).toBe(false);
    expect(await apiKeys.resolve(issued.token)).not.toBeNull();
    // Correct tenant — succeeds.
    expect(await apiKeys.revoke("acme", issued.tokenId)).toBe(true);
    expect(await apiKeys.resolve(issued.token)).toBeNull();
    // Idempotent — second call returns false (no active row).
    expect(await apiKeys.revoke("acme", issued.tokenId)).toBe(false);
  });

  it("list returns no plaintext, only metadata + last4", async () => {
    await seedTenant("acme");
    const apiKeys = createPostgresApiKeyStore({ pool });
    const issued = await apiKeys.issue("acme", "ops");
    const list = await apiKeys.list("acme");
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe("ops");
    expect(list[0]?.last4).toHaveLength(4);
    expect(JSON.stringify(list[0])).not.toContain(issued.token);
  });

  it("revokeAllForTenant invalidates every active key for that tenant only", async () => {
    await seedTenant("acme");
    await seedTenant("globex");
    const apiKeys = createPostgresApiKeyStore({ pool });
    const a1 = await apiKeys.issue("acme", "k1");
    const a2 = await apiKeys.issue("acme", "k2");
    const g1 = await apiKeys.issue("globex", "k3");
    await apiKeys.revokeAllForTenant("acme");
    expect(await apiKeys.resolve(a1.token)).toBeNull();
    expect(await apiKeys.resolve(a2.token)).toBeNull();
    expect(await apiKeys.resolve(g1.token)).not.toBeNull();
  });

  it("updates last_used_at on successful resolve", async () => {
    await seedTenant("acme");
    const apiKeys = createPostgresApiKeyStore({ pool });
    const issued = await apiKeys.issue("acme", "k");
    expect((await apiKeys.list("acme"))[0]?.lastUsedAt).toBeUndefined();
    await apiKeys.resolve(issued.token);
    expect((await apiKeys.list("acme"))[0]?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("createPostgresRegistry", () => {
  it("wires all three stores against one pool", async () => {
    const pool = await freshPool();
    const { tenants, vault, apiKeys } = createPostgresRegistry({
      pool,
      cipher: freshCipher(),
    });
    const created = await tenants.create(buildInput({ tenantRef: "acme" }));
    await vault.put(created.tenantRef, {
      privateKey: "P",
      productionCertificate: "C",
      productionBinarySecurityToken: "B",
      productionApiSecret: "S",
    });
    const key = await apiKeys.issue(created.tenantRef, "ops");
    const resolved = await apiKeys.resolve(key.token);
    expect(resolved?.tenantRef).toBe("acme");
    expect((await vault.get("acme"))?.privateKey).toBe("P");
  });
});

describe("generateTenantRef", () => {
  it("returns URL-safe lowercase base32", () => {
    expect(generateTenantRef()).toMatch(/^[a-z2-7]+$/);
  });
});
