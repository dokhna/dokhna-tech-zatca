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
    await apiKeys.revoke("acme", issued.tokenId);
    const verifier = createTenantBearerVerifier(apiKeys);
    try {
      await verifier.verify(`Bearer ${issued.token}`, "acme");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaAuthError);
      expect((err as ZatcaAuthError).statusHint).toBe(401);
    }
  });

  it("throws 401 (NOT 403) when token is valid but for a different tenant (ME-06)", async () => {
    // ME-06: pre-fix returned 403 here, letting an attacker
    // distinguish "valid token / wrong tenant" from "invalid token"
    // and enumerate the tenant directory. Now BOTH paths return 401
    // with the same wire-side message; the diagnostic detail
    // (presented vs expected tenant) is on Error.cause for server
    // logs only.
    const apiKeys = createMemoryApiKeyStore();
    const acmeKey = await apiKeys.issue("acme", "k");
    const verifier = createTenantBearerVerifier(apiKeys);
    try {
      await verifier.verify(`Bearer ${acmeKey.token}`, "globex");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaAuthError);
      expect((err as ZatcaAuthError).statusHint).toBe(401);
      expect((err as ZatcaAuthError).message).toBe("Invalid or revoked API key.");
      const cause = (err as ZatcaAuthError).cause as
        | { reason: string; presentedTenantRef: string; expectedTenantRef: string }
        | undefined;
      expect(cause?.reason).toBe("wrong_tenant_bearer");
      expect(cause?.presentedTenantRef).toBe("acme");
      expect(cause?.expectedTenantRef).toBe("globex");
    }
  });
});
