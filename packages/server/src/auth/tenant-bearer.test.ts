import { describe, expect, it } from "vitest";
import { ZatcaAuthError } from "../errors.js";
import { createMemoryApiKeyStore } from "../tenants/registry-memory.js";

import { createTenantBearerVerifier } from "./tenant-bearer.js";

describe("createTenantBearerVerifier", () => {
  it("returns the resolved key when bearer + tenantRef agree", async () => {
    const apiKeys = createMemoryApiKeyStore();
    const issued = await apiKeys.issue("acme", "k");
    const verifier = createTenantBearerVerifier(apiKeys);
    const resolved = await verifier.verify(`Bearer ${issued.token}`, "acme");
    expect(resolved.tenantRef).toBe("acme");
    expect(resolved.tokenId).toBe(issued.tokenId);
  });

  it("throws 401 on missing header", async () => {
    const verifier = createTenantBearerVerifier(createMemoryApiKeyStore());
    try {
      await verifier.verify(undefined, "acme");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaAuthError);
      expect((err as ZatcaAuthError).statusHint).toBe(401);
    }
  });

  it("throws 401 on a malformed header", async () => {
    const verifier = createTenantBearerVerifier(createMemoryApiKeyStore());
    try {
      await verifier.verify("Basic xyz", "acme");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaAuthError);
      expect((err as ZatcaAuthError).statusHint).toBe(401);
    }
  });

  it("throws 401 on an unknown token", async () => {
    const verifier = createTenantBearerVerifier(createMemoryApiKeyStore());
    try {
      await verifier.verify("Bearer zts_live_acme_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "acme");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaAuthError);
      expect((err as ZatcaAuthError).statusHint).toBe(401);
    }
  });

  it("throws 401 on a revoked token", async () => {
    const apiKeys = createMemoryApiKeyStore();
    const issued = await apiKeys.issue("acme", "k");
    await apiKeys.revoke(issued.tokenId);
    const verifier = createTenantBearerVerifier(apiKeys);
    try {
      await verifier.verify(`Bearer ${issued.token}`, "acme");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaAuthError);
      expect((err as ZatcaAuthError).statusHint).toBe(401);
    }
  });

  it("throws 403 (NOT 401) when token is valid but for a different tenant", async () => {
    const apiKeys = createMemoryApiKeyStore();
    const acmeKey = await apiKeys.issue("acme", "k");
    const verifier = createTenantBearerVerifier(apiKeys);
    try {
      await verifier.verify(`Bearer ${acmeKey.token}`, "globex");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaAuthError);
      expect((err as ZatcaAuthError).statusHint).toBe(403);
      expect((err as ZatcaAuthError).message).toMatch(/not authorized for tenant 'globex'/);
    }
  });
});
