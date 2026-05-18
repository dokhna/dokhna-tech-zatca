/**
 * Integration tests for the Mongo-backed registry + audit log.
 *
 * Boots a real `mongod` process in-memory via `mongodb-memory-server`
 * so the tests exercise the actual driver code paths. Cold-start can
 * take ~30s on first run (downloads the binary); warm runs finish in
 * a few seconds. All four interfaces share one boot to amortise.
 */

import { asCommercialRegistrationNumber, asEGSUuid, asVATNumber } from "@dokhna-tech/zatca";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Connection } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createMongoAuditLog } from "../audit/log-mongo.js";
import { createAesGcmCipher, type MasterKey } from "../crypto/aes-gcm-cipher.js";
import { ZatcaCipherError, ZatcaRegistryError } from "../errors.js";

import {
  createMongoApiKeyStore,
  createMongoCredentialVault,
  createMongoRegistry,
  createMongoTenantStore,
} from "./registry-mongo.js";
import type { CreateTenantInput, TenantLocation } from "./types.js";

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

let mongod: MongoMemoryServer;
let connection: Connection;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongod.getUri());
  await connection.asPromise();
}, 60_000);

afterAll(async () => {
  await connection.close();
  await mongod.stop();
});

afterEach(async () => {
  // Reset state between tests without restarting mongod.
  await connection.dropDatabase();
});

describe("createMongoTenantStore", () => {
  it("generates a tenantRef when none supplied + persists clean defaults", async () => {
    const store = createMongoTenantStore({ connection });
    const record = await store.create(buildInput());
    expect(record.tenantRef).toMatch(/^[a-z2-7]+$/);
    expect(record.state).toBe("created");
    expect(record.onboardingProgress.scenarios).toEqual({});
  });

  it("uses caller-supplied tenantRef", async () => {
    const store = createMongoTenantStore({ connection });
    const record = await store.create(buildInput({ tenantRef: "acme" }));
    expect(record.tenantRef).toBe("acme");
  });

  it("rejects duplicate tenantRef", async () => {
    const store = createMongoTenantStore({ connection });
    await store.create(buildInput({ tenantRef: "acme" }));
    await expect(store.create(buildInput({ tenantRef: "acme" }))).rejects.toThrow(
      ZatcaRegistryError,
    );
  });

  it("get returns null for unknown + soft-deleted records", async () => {
    const store = createMongoTenantStore({ connection });
    expect(await store.get("missing")).toBeNull();
    await store.create(buildInput({ tenantRef: "acme" }));
    await store.softDelete("acme");
    expect(await store.get("acme")).toBeNull();
  });

  it("patch updates only mutable metadata", async () => {
    const store = createMongoTenantStore({ connection });
    const created = await store.create(buildInput({ tenantRef: "acme" }));
    const updated = await store.patch("acme", { branchName: "New Branch", label: "test" });
    expect(updated.branchName).toBe("New Branch");
    expect(updated.label).toBe("test");
    expect(updated.vatNumber).toBe(created.vatNumber);
  });

  describe("setState (CAS via findOneAndUpdate)", () => {
    it("transitions without guard", async () => {
      const store = createMongoTenantStore({ connection });
      await store.create(buildInput({ tenantRef: "acme" }));
      const out = await store.setState("acme", "production-ready");
      expect(out.state).toBe("production-ready");
      expect(out.claimedBy).toBeUndefined();
    });

    it("rejects when expectedFrom does not match", async () => {
      const store = createMongoTenantStore({ connection });
      await store.create(buildInput({ tenantRef: "acme" }));
      await expect(
        store.setState("acme", "onboarding", { expectedFrom: "production-ready" }),
      ).rejects.toThrow(/Cannot transition tenant 'acme' from 'created'/);
    });

    it("reclaims an expired claim regardless of expectedFrom", async () => {
      const store = createMongoTenantStore({ connection });
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
      const store = createMongoTenantStore({ connection });
      await store.create(buildInput({ tenantRef: "acme" }));
      const out = await store.setState("acme", "failed", { lastError: "OTP rejected" });
      expect(out.onboardingProgress.lastError).toBe("OTP rejected");
    });
  });

  describe("recordOnboardingProgress", () => {
    it("appends scenario results", async () => {
      const store = createMongoTenantStore({ connection });
      await store.create(buildInput({ tenantRef: "acme" }));
      await store.recordOnboardingProgress("acme", "standard-invoice", true);
      await store.recordOnboardingProgress("acme", "simplified-invoice", false);
      const record = await store.get("acme");
      expect(record?.onboardingProgress.scenarios).toEqual({
        "standard-invoice": "passed",
        "simplified-invoice": "failed",
      });
    });
  });

  describe("list filters", () => {
    async function seed(store: ReturnType<typeof createMongoTenantStore>) {
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
      const store = createMongoTenantStore({ connection });
      await seed(store);
      const sim = await store.list({ environment: "simulation" });
      expect(sim.map((r) => r.tenantRef)).toEqual(["a"]);
    });

    it("hides soft-deleted by default + exposes with includeDeleted", async () => {
      const store = createMongoTenantStore({ connection });
      await seed(store);
      await store.softDelete("a");
      expect(await store.list()).toHaveLength(1);
      expect(await store.list({ includeDeleted: true })).toHaveLength(2);
    });

    it("filters by expiringWithinDays", async () => {
      const store = createMongoTenantStore({ connection });
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

describe("createMongoCredentialVault", () => {
  it("returns null for unknown tenant", async () => {
    const vault = createMongoCredentialVault({ connection, cipher: freshCipher() });
    expect(await vault.get("missing")).toBeNull();
  });

  it("round-trips full signer material", async () => {
    const vault = createMongoCredentialVault({ connection, cipher: freshCipher() });
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
    const vault = createMongoCredentialVault({ connection, cipher: freshCipher() });
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

  it("re-put without compliance fields clears stale compliance values (HI-10)", async () => {
    const vault = createMongoCredentialVault({ connection, cipher: freshCipher() });
    await vault.put("acme", {
      privateKey: "PRIV",
      productionCertificate: "PROD-CERT",
      productionBinarySecurityToken: "PROD-BST",
      productionApiSecret: "PROD-SECRET",
      complianceCertificate: "COMP-CERT",
      complianceBinarySecurityToken: "COMP-BST",
      complianceApiSecret: "COMP-SECRET",
    });
    await vault.put("acme", {
      privateKey: "PRIV2",
      productionCertificate: "PROD-CERT2",
      productionBinarySecurityToken: "PROD-BST2",
      productionApiSecret: "PROD-SECRET2",
    });
    const out = await vault.get("acme");
    expect(out?.complianceCertificate).toBeUndefined();
    expect(out?.complianceBinarySecurityToken).toBeUndefined();
    expect(out?.complianceApiSecret).toBeUndefined();
    expect(out?.privateKey).toBe("PRIV2");
  });

  it("decrypt failure under a rotated-out kid throws ZatcaCipherError", async () => {
    const writer = createMongoCredentialVault({ connection, cipher: freshCipher() });
    await writer.put("acme", {
      privateKey: "PRIV",
      productionCertificate: "C",
      productionBinarySecurityToken: "B",
      productionApiSecret: "S",
    });
    const reader = createMongoCredentialVault({
      connection,
      cipher: createAesGcmCipher({ keyring: [key("v2")], activeKid: "v2" }),
    });
    await expect(reader.get("acme")).rejects.toThrow(ZatcaCipherError);
  });

  it("delete removes the row", async () => {
    const vault = createMongoCredentialVault({ connection, cipher: freshCipher() });
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

describe("createMongoApiKeyStore", () => {
  it("issues + resolves a fresh token", async () => {
    const apiKeys = createMongoApiKeyStore({ connection });
    const issued = await apiKeys.issue("acme", "ops");
    expect(issued.token).toMatch(/^zts_live_acme_[A-Z2-7]{32}$/);
    const resolved = await apiKeys.resolve(issued.token);
    expect(resolved?.tenantRef).toBe("acme");
    expect(resolved?.tokenId).toBe(issued.tokenId);
  });

  it("rejects a token whose env prefix does not match the store", async () => {
    const live = createMongoApiKeyStore({ connection, env: "live" });
    const test = createMongoApiKeyStore({ connection, env: "test" });
    const liveIssued = await live.issue("acme", "k");
    expect(await test.resolve(liveIssued.token)).toBeNull();
  });

  it("revoke makes the token unresolvable", async () => {
    const apiKeys = createMongoApiKeyStore({ connection });
    const issued = await apiKeys.issue("acme", "k");
    const ok = await apiKeys.revoke("acme", issued.tokenId);
    expect(ok).toBe(true);
    expect(await apiKeys.resolve(issued.token)).toBeNull();
  });

  it("revoke refuses cross-tenant attempts and leaves the row intact (CR-04)", async () => {
    const apiKeys = createMongoApiKeyStore({ connection });
    const issued = await apiKeys.issue("acme", "k");
    expect(await apiKeys.revoke("globex", issued.tokenId)).toBe(false);
    expect(await apiKeys.resolve(issued.token)).not.toBeNull();
    expect(await apiKeys.revoke("acme", issued.tokenId)).toBe(true);
    expect(await apiKeys.resolve(issued.token)).toBeNull();
    expect(await apiKeys.revoke("acme", issued.tokenId)).toBe(false);
  });

  it("list returns no plaintext, only metadata + last4", async () => {
    const apiKeys = createMongoApiKeyStore({ connection });
    const issued = await apiKeys.issue("acme", "ops");
    const list = await apiKeys.list("acme");
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe("ops");
    expect(list[0]?.last4).toHaveLength(4);
    expect(JSON.stringify(list[0])).not.toContain(issued.token);
  });

  it("revokeAllForTenant invalidates every active key for that tenant only", async () => {
    const apiKeys = createMongoApiKeyStore({ connection });
    const a1 = await apiKeys.issue("acme", "k1");
    const a2 = await apiKeys.issue("acme", "k2");
    const g1 = await apiKeys.issue("globex", "k3");
    await apiKeys.revokeAllForTenant("acme");
    expect(await apiKeys.resolve(a1.token)).toBeNull();
    expect(await apiKeys.resolve(a2.token)).toBeNull();
    expect(await apiKeys.resolve(g1.token)).not.toBeNull();
  });

  it("updates lastUsedAt on successful resolve", async () => {
    const apiKeys = createMongoApiKeyStore({ connection });
    const issued = await apiKeys.issue("acme", "k");
    expect((await apiKeys.list("acme"))[0]?.lastUsedAt).toBeUndefined();
    await apiKeys.resolve(issued.token);
    expect((await apiKeys.list("acme"))[0]?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("createMongoAuditLog", () => {
  it("assigns uuid + timestamp on write", async () => {
    const log = createMongoAuditLog({ connection });
    const entry = await log.write({
      actor: { type: "admin", label: "ops" },
      action: "tenant.created",
      result: "ok",
    });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.at).toBeInstanceOf(Date);
  });

  it("persists every field + filters list", async () => {
    const log = createMongoAuditLog({ connection });
    await log.write({
      actor: { type: "tenant", tenantRef: "acme", tokenId: "tk_1" },
      tenantRef: "acme",
      action: "invoice.issued",
      targetId: "inv-001",
      result: "ok",
      zatcaRequestId: "rq",
      requestId: "ri",
      payload: { kind: "simplified" },
    });
    await log.write({
      actor: { type: "tenant", tenantRef: "globex", tokenId: "tk_2" },
      tenantRef: "globex",
      action: "invoice.issued",
      result: "error",
    });
    expect(await log.list({ tenantRef: "acme" })).toHaveLength(1);
    expect(await log.list({ result: "error" })).toHaveLength(1);
    expect(await log.list({ action: "invoice.issued" })).toHaveLength(2);
    expect(await log.list({ limit: 1 })).toHaveLength(1);
    const rows = await log.list({ tenantRef: "acme" });
    expect(rows[0]?.actor).toEqual({ type: "tenant", tenantRef: "acme", tokenId: "tk_1" });
    expect(rows[0]?.payload).toEqual({ kind: "simplified" });
  });
});

describe("createMongoRegistry", () => {
  it("wires all three stores against one connection", async () => {
    const { tenants, vault, apiKeys } = createMongoRegistry({
      connection,
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
