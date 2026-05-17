import { asCommercialRegistrationNumber, asEGSUuid, asVATNumber } from "@dokhna-tech/zatca";
import { describe, expect, it } from "vitest";

import { createAesGcmCipher, type MasterKey } from "../crypto/aes-gcm-cipher.js";
import { ZatcaRegistryError } from "../errors.js";
import {
  createMemoryApiKeyStore,
  createMemoryCredentialVault,
  createMemoryRegistry,
  createMemoryTenantStore,
  generateTenantRef,
} from "./registry-memory.js";
import type { CreateTenantInput, TenantLocation } from "./types.js";

const LOCATION: TenantLocation = {
  cityName: "Riyadh",
  citySubdivision: "Olaya",
  street: "King Fahd Rd",
  plotIdentification: "1234",
  building: "5678",
  postalZone: "12345",
};

function input(overrides: Partial<CreateTenantInput> = {}): CreateTenantInput {
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

describe("createMemoryTenantStore", () => {
  describe("create", () => {
    it("generates a tenantRef if none supplied", async () => {
      const store = createMemoryTenantStore();
      const record = await store.create(input());
      expect(record.tenantRef).toMatch(/^[a-z2-7]+$/);
      expect(record.state).toBe("created");
      expect(record.onboardingProgress.scenarios).toEqual({});
    });

    it("uses the caller's tenantRef when supplied", async () => {
      const store = createMemoryTenantStore();
      const record = await store.create(input({ tenantRef: "acme" }));
      expect(record.tenantRef).toBe("acme");
    });

    it("rejects duplicate tenantRef", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "acme" }));
      await expect(store.create(input({ tenantRef: "acme" }))).rejects.toThrow(ZatcaRegistryError);
    });
  });

  describe("get / list", () => {
    it("returns null for unknown tenant", async () => {
      const store = createMemoryTenantStore();
      expect(await store.get("missing")).toBeNull();
    });

    it("hides soft-deleted records from get by default", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "acme" }));
      await store.softDelete("acme");
      expect(await store.get("acme")).toBeNull();
    });

    it("filters by state + environment", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a", environment: "simulation" }));
      await store.create(
        input({
          tenantRef: "b",
          environment: "production",
          egsUuid: asEGSUuid("00000000-0000-4000-8000-000000000002"),
        }),
      );
      const sim = await store.list({ environment: "simulation" });
      expect(sim).toHaveLength(1);
      expect(sim[0]?.tenantRef).toBe("a");
    });

    it("includes deleted only when asked", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      await store.softDelete("a");
      expect(await store.list()).toHaveLength(0);
      expect(await store.list({ includeDeleted: true })).toHaveLength(1);
    });

    it("filters by expiringWithinDays", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      await store.create(
        input({ tenantRef: "b", egsUuid: asEGSUuid("00000000-0000-4000-8000-000000000002") }),
      );
      const soon = new Date(Date.now() + 5 * 86_400_000);
      const later = new Date(Date.now() + 60 * 86_400_000);
      await store.setProductionExpiry("a", soon);
      await store.setProductionExpiry("b", later);
      const expiring = await store.list({ expiringWithinDays: 30 });
      expect(expiring.map((r) => r.tenantRef)).toEqual(["a"]);
    });
  });

  describe("patch", () => {
    it("updates mutable metadata only", async () => {
      const store = createMemoryTenantStore();
      const original = await store.create(input({ tenantRef: "a" }));
      const updated = await store.patch("a", { branchName: "New Branch", label: "test" });
      expect(updated.branchName).toBe("New Branch");
      expect(updated.label).toBe("test");
      expect(updated.vatNumber).toBe(original.vatNumber);
      expect(updated.egsUuid).toBe(original.egsUuid);
    });

    it("rejects patches on unknown tenant", async () => {
      const store = createMemoryTenantStore();
      await expect(store.patch("missing", { label: "x" })).rejects.toThrow(ZatcaRegistryError);
    });
  });

  describe("setState (CAS)", () => {
    it("transitions without a guard", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      const result = await store.setState("a", "production-ready");
      expect(result.state).toBe("production-ready");
    });

    it("enforces expectedFrom guard", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      await expect(
        store.setState("a", "onboarding", { expectedFrom: "production-ready" }),
      ).rejects.toThrow(/Cannot transition tenant 'a' from 'created'/);
    });

    it("respects an expired claim as if the slot were free", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      // Take the lock — state moves to onboarding with a stale expiry.
      await store.setState("a", "onboarding", {
        expectedFrom: "created",
        claimedBy: "instance-1",
        claimExpiresAt: new Date(Date.now() - 1000),
      });
      // Another instance should be able to re-take the lock.
      const reclaimed = await store.setState("a", "onboarding", {
        expectedFrom: "created",
        claimedBy: "instance-2",
        claimExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(reclaimed.claimedBy).toBe("instance-2");
    });

    it("records lastError on failed state", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      const result = await store.setState("a", "failed", { lastError: "OTP expired" });
      expect(result.onboardingProgress.lastError).toBe("OTP expired");
    });

    it("treats a NULL claimExpiresAt while state=onboarding as a stale claim (CR-02)", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      // Acquire the lock normally, but then strip the expiry to
      // simulate the wedged state (crash mid-setState, DBA intervention,
      // future refactor that calls setState('onboarding', {})).
      await store.setState("a", "onboarding", {
        expectedFrom: "created",
        claimedBy: "instance-1",
        claimExpiresAt: new Date(Date.now() + 60_000),
      });
      // Force the wedged state by transitioning back to onboarding
      // with no claimExpiresAt — directly exercises the recovery path.
      await store.setState("a", "onboarding", { claimedBy: "instance-1" });
      const wedged = await store.get("a");
      expect(wedged?.state).toBe("onboarding");
      expect(wedged?.claimExpiresAt).toBeUndefined();
      // A fresh acquire from any of the legal starting states must
      // succeed because the lock is not held.
      const reclaimed = await store.setState("a", "onboarding", {
        expectedFrom: "created",
        claimedBy: "instance-2",
        claimExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(reclaimed.claimedBy).toBe("instance-2");
    });
  });

  describe("recordOnboardingProgress", () => {
    it("appends scenario results", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      await store.recordOnboardingProgress("a", "standard-invoice", true);
      await store.recordOnboardingProgress("a", "simplified-invoice", false);
      const record = await store.get("a");
      expect(record?.onboardingProgress.scenarios).toEqual({
        "standard-invoice": "passed",
        "simplified-invoice": "failed",
      });
    });

    it("overwrites a prior result for the same scenario", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      await store.recordOnboardingProgress("a", "standard-invoice", false);
      await store.recordOnboardingProgress("a", "standard-invoice", true);
      const record = await store.get("a");
      expect(record?.onboardingProgress.scenarios["standard-invoice"]).toBe("passed");
    });
  });

  describe("softDelete", () => {
    it("marks revoked, sets deletedAt, hides from get", async () => {
      const store = createMemoryTenantStore();
      await store.create(input({ tenantRef: "a" }));
      await store.softDelete("a");
      const list = await store.list({ includeDeleted: true });
      expect(list[0]?.state).toBe("revoked");
      expect(list[0]?.deletedAt).toBeInstanceOf(Date);
    });
  });
});

describe("createMemoryCredentialVault", () => {
  it("returns null for unknown tenant", async () => {
    const vault = createMemoryCredentialVault({ cipher: freshCipher() });
    expect(await vault.get("missing")).toBeNull();
  });

  it("round-trips full signer material", async () => {
    const vault = createMemoryCredentialVault({ cipher: freshCipher() });
    await vault.put("a", {
      privateKey: "PRIV",
      productionCertificate: "PROD-CERT",
      productionBinarySecurityToken: "PROD-BST",
      productionApiSecret: "PROD-SECRET",
      complianceCertificate: "COMP-CERT",
      complianceBinarySecurityToken: "COMP-BST",
      complianceApiSecret: "COMP-SECRET",
    });
    const out = await vault.get("a");
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

  it("round-trips production-only signer material", async () => {
    const vault = createMemoryCredentialVault({ cipher: freshCipher() });
    await vault.put("a", {
      privateKey: "PRIV",
      productionCertificate: "PROD-CERT",
      productionBinarySecurityToken: "PROD-BST",
      productionApiSecret: "PROD-SECRET",
    });
    const out = await vault.get("a");
    expect(out?.complianceCertificate).toBeUndefined();
    expect(out?.complianceApiSecret).toBeUndefined();
  });

  it("overwrites on subsequent put", async () => {
    const vault = createMemoryCredentialVault({ cipher: freshCipher() });
    await vault.put("a", {
      privateKey: "P1",
      productionCertificate: "C1",
      productionBinarySecurityToken: "B1",
      productionApiSecret: "S1",
    });
    await vault.put("a", {
      privateKey: "P2",
      productionCertificate: "C2",
      productionBinarySecurityToken: "B2",
      productionApiSecret: "S2",
    });
    expect((await vault.get("a"))?.privateKey).toBe("P2");
  });

  it("delete wipes the row", async () => {
    const vault = createMemoryCredentialVault({ cipher: freshCipher() });
    await vault.put("a", {
      privateKey: "P",
      productionCertificate: "C",
      productionBinarySecurityToken: "B",
      productionApiSecret: "S",
    });
    await vault.delete("a");
    expect(await vault.get("a")).toBeNull();
  });
});

describe("createMemoryApiKeyStore", () => {
  it("issues and resolves a fresh token", async () => {
    const store = createMemoryApiKeyStore();
    const issued = await store.issue("acme", "test-key");
    expect(issued.token).toMatch(/^zts_live_acme_[A-Z2-7]{32}$/);
    const resolved = await store.resolve(issued.token);
    expect(resolved?.tenantRef).toBe("acme");
    expect(resolved?.tokenId).toBe(issued.tokenId);
  });

  it("rejects a token with a wrong tail", async () => {
    const store = createMemoryApiKeyStore();
    await store.issue("acme", "test-key");
    const fake = `zts_live_acme_${"A".repeat(32)}`;
    expect(await store.resolve(fake)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    const store = createMemoryApiKeyStore();
    expect(await store.resolve("not-a-token")).toBeNull();
  });

  it("rejects a token whose env prefix does not match the store", async () => {
    const liveStore = createMemoryApiKeyStore({ env: "live" });
    const testStore = createMemoryApiKeyStore({ env: "test" });
    const liveIssued = await liveStore.issue("acme", "k");
    expect(await testStore.resolve(liveIssued.token)).toBeNull();
  });

  it("revoke makes a previously-valid token unresolvable", async () => {
    const store = createMemoryApiKeyStore();
    const issued = await store.issue("acme", "k");
    const revoked = await store.revoke("acme", issued.tokenId);
    expect(revoked).toBe(true);
    expect(await store.resolve(issued.token)).toBeNull();
  });

  it("revoke refuses cross-tenant — returns false without touching the row (CR-04)", async () => {
    const store = createMemoryApiKeyStore();
    const acmeIssued = await store.issue("acme", "k");
    // Attempt to revoke acme's token via tenant 'globex' — must return
    // false AND leave the token resolvable so a follow-up tenant-correct
    // revoke succeeds.
    const wrongTenant = await store.revoke("globex", acmeIssued.tokenId);
    expect(wrongTenant).toBe(false);
    expect(await store.resolve(acmeIssued.token)).not.toBeNull();
    // Correct tenant succeeds.
    const correctTenant = await store.revoke("acme", acmeIssued.tokenId);
    expect(correctTenant).toBe(true);
    expect(await store.resolve(acmeIssued.token)).toBeNull();
    // Idempotent — second call returns false (no active row to update).
    const second = await store.revoke("acme", acmeIssued.tokenId);
    expect(second).toBe(false);
  });

  it("list returns no plaintext, only last4 + metadata", async () => {
    const store = createMemoryApiKeyStore();
    const issued = await store.issue("acme", "ops");
    const list = await store.list("acme");
    expect(list).toHaveLength(1);
    const entry = list[0];
    expect(entry?.label).toBe("ops");
    expect(entry?.last4).toHaveLength(4);
    expect(JSON.stringify(entry)).not.toContain(issued.token);
  });

  it("revokeAllForTenant invalidates every key for that tenant", async () => {
    const store = createMemoryApiKeyStore();
    const a1 = await store.issue("acme", "k1");
    const a2 = await store.issue("acme", "k2");
    const g1 = await store.issue("globex", "k3");
    await store.revokeAllForTenant("acme");
    expect(await store.resolve(a1.token)).toBeNull();
    expect(await store.resolve(a2.token)).toBeNull();
    expect(await store.resolve(g1.token)).not.toBeNull();
  });

  it("updates lastUsedAt on successful resolve", async () => {
    const store = createMemoryApiKeyStore();
    const issued = await store.issue("acme", "k");
    expect((await store.list("acme"))[0]?.lastUsedAt).toBeUndefined();
    await store.resolve(issued.token);
    expect((await store.list("acme"))[0]?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("createMemoryRegistry", () => {
  it("wires all three stores together", async () => {
    const { tenants, vault, apiKeys } = createMemoryRegistry({ cipher: freshCipher() });
    const created = await tenants.create(input({ tenantRef: "acme" }));
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
  it("returns a URL-safe lowercase base32 slug", () => {
    const ref = generateTenantRef();
    expect(ref).toMatch(/^[a-z2-7]+$/);
    expect(ref.length).toBeGreaterThanOrEqual(16);
  });

  it("produces distinct refs across calls (collision-safe)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateTenantRef());
    expect(seen.size).toBe(1000);
  });
});
