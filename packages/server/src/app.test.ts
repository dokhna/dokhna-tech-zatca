/**
 * Black-box integration tests for the Fastify app.
 *
 * Uses `app.inject({...})` so tests run without binding a real
 * socket. All dependencies are in-memory; the onboarding flow is
 * stubbed via the `onboardingHooks` injection seam so the test
 * never reaches the real ZATCA gateway.
 */

import { createMemoryStorageAdapter } from "@dokhna-tech/zatca-storage-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { type AuditLog, createMemoryAuditLog } from "./audit/index.js";
import type { ServerConfig } from "./config.js";
import { createAesGcmCipher } from "./crypto/index.js";
import { createMemoryRegistry } from "./tenants/index.js";

const ADMIN_KEY = "a".repeat(32);
const SECOND_ADMIN = "b".repeat(32);

function freshConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    timezone: "Asia/Riyadh",
    adminKeysRaw: `ops:${ADMIN_KEY},ci:${SECOND_ADMIN}`,
    masterKeys: [{ kid: "v1", key: Buffer.alloc(32, 1) }],
    activeKid: "v1",
    tenantBearerEnv: "live",
    onboardingTimeoutMs: 30_000,
    idempotencyWindowMs: 60_000,
    instanceId: "test-instance",
    metricsEnabled: false,
    logLevel: "fatal",
    trustProxy: false,
    onboardingMaxConcurrent: 4,
    // High enough to never trip during the test suite. Production
    // default in loadConfig() is 200/min/IP.
    rateLimitMaxPerMinute: 100_000,
  };
}

function stubOnboard(): typeof import("@dokhna-tech/zatca").onboard {
  return (async () => ({
    privateKey: "PRIV",
    csr: "CSR",
    complianceCertificate: "COMP-CERT",
    complianceBinarySecurityToken: "COMP-BST",
    complianceApiSecret: "COMP-SECRET",
    complianceRequestId: "comp-req-1",
    productionCertificate: "PROD-CERT",
    productionBinarySecurityToken: "PROD-BST",
    productionApiSecret: "PROD-SECRET",
    productionRequestId: "prod-req-1",
    complianceTestReport: {
      overallStatus: "passed" as const,
      results: [],
      finalInvoiceHash: "" as never,
    },
  })) as never;
}

async function bootApp(opts: { auditLog?: AuditLog; rateLimitMaxPerMinute?: number } = {}) {
  const cfg = freshConfig();
  if (opts.rateLimitMaxPerMinute !== undefined) {
    (cfg as { rateLimitMaxPerMinute: number }).rateLimitMaxPerMinute = opts.rateLimitMaxPerMinute;
  }
  const cipher = createAesGcmCipher({ keyring: cfg.masterKeys, activeKid: cfg.activeKid });
  const registry = createMemoryRegistry({ cipher });
  const storage = createMemoryStorageAdapter();
  const auditLog = opts.auditLog ?? createMemoryAuditLog();
  const app = await buildApp({
    config: cfg,
    registry,
    storage,
    auditLog,
    onboardingHooks: {
      onboardFn: stubOnboard(),
      getExpiry: () => new Date(Date.now() + 365 * 86_400_000),
    },
  });
  return { app, cfg, registry, storage, auditLog };
}

const TENANT_BODY = {
  tenantRef: "acme",
  vatNumber: "301234567890003",
  egsUuid: "00000000-0000-4000-8000-000000000001",
  vatName: "Acme Trading Co.",
  crn: "1010010101",
  branchName: "Riyadh HQ",
  branchIndustry: "Retail",
  location: {
    cityName: "Riyadh",
    citySubdivision: "Olaya",
    street: "King Fahd Rd",
    plotIdentification: "1234",
    building: "5678",
    postalZone: "12345",
  },
  environment: "simulation" as const,
};

describe("zatca-server app", () => {
  let app: Awaited<ReturnType<typeof bootApp>>["app"];

  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(async () => {
    await app.close();
  });

  describe("ops", () => {
    it("/healthz returns 200 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    });

    it("/readyz returns 200 when registry is reachable", async () => {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("rate limiting (CodeQL js/missing-rate-limiting)", () => {
    it("returns 429 once an IP exceeds the per-minute cap", async () => {
      const { app: throttled } = await bootApp({ rateLimitMaxPerMinute: 2 });
      try {
        const a = await throttled.inject({
          method: "GET",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
        });
        const b = await throttled.inject({
          method: "GET",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
        });
        const c = await throttled.inject({
          method: "GET",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
        });
        expect(a.statusCode).toBe(200);
        expect(b.statusCode).toBe(200);
        expect(c.statusCode).toBe(429);
      } finally {
        await throttled.close();
      }
    });

    it("/healthz is exempt from rate limiting", async () => {
      const { app: throttled } = await bootApp({ rateLimitMaxPerMinute: 1 });
      try {
        await throttled.inject({ method: "GET", url: "/healthz" });
        await throttled.inject({ method: "GET", url: "/healthz" });
        const third = await throttled.inject({ method: "GET", url: "/healthz" });
        expect(third.statusCode).toBe(200);
      } finally {
        await throttled.close();
      }
    });
  });

  describe("admin auth", () => {
    it("401 without Authorization header", async () => {
      const res = await app.inject({ method: "POST", url: "/v1/tenants", payload: TENANT_BODY });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.name).toBe("ZatcaAuthError");
    });

    it("401 with an unknown admin key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${"z".repeat(32)}` },
        payload: TENANT_BODY,
      });
      expect(res.statusCode).toBe(401);
    });

    it("401 with a malformed Authorization scheme", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: { authorization: `Basic ${ADMIN_KEY}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("succeeds with either configured admin key", async () => {
      const a = await app.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(a.statusCode).toBe(200);
      const b = await app.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${SECOND_ADMIN}` },
      });
      expect(b.statusCode).toBe(200);
    });
  });

  describe("tenant CRUD", () => {
    it("POST /v1/tenants creates, GET returns, PATCH updates, DELETE soft-deletes", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: TENANT_BODY,
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().tenantRef).toBe("acme");
      expect(created.json().state).toBe("created");

      const got = await app.inject({
        method: "GET",
        url: "/v1/tenants/acme",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(got.statusCode).toBe(200);
      expect(got.json().tenantRef).toBe("acme");

      const patched = await app.inject({
        method: "PATCH",
        url: "/v1/tenants/acme",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { branchName: "New Branch" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().branchName).toBe("New Branch");

      const deleted = await app.inject({
        method: "DELETE",
        url: "/v1/tenants/acme",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(deleted.statusCode).toBe(204);

      const gone = await app.inject({
        method: "GET",
        url: "/v1/tenants/acme",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(gone.statusCode).toBe(404);
    });

    it("POST /v1/tenants rejects duplicate ref with 409", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: TENANT_BODY,
      });
      expect(first.statusCode).toBe(201);
      const dup = await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: TENANT_BODY,
      });
      expect(dup.statusCode).toBe(409);
    });

    it("validates request body — missing required fields → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { vatNumber: "x" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.name).toBe("ZatcaValidationError");
    });

    it("LIST filters by environment + state", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: TENANT_BODY,
      });
      const sim = await app.inject({
        method: "GET",
        url: "/v1/tenants?environment=simulation",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(sim.json().tenants).toHaveLength(1);
      const prod = await app.inject({
        method: "GET",
        url: "/v1/tenants?environment=production",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(prod.json().tenants).toHaveLength(0);
    });
  });

  describe("onboarding", () => {
    it("POST /v1/tenants/:ref/onboard transitions to production-ready", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: TENANT_BODY,
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/tenants/acme/onboard",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { otp: "123456", solutionName: "Test Suite", environment: "simulation" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe("production-ready");
      expect(res.json().complianceTestStatus).toBe("passed");

      const status = await app.inject({
        method: "GET",
        url: "/v1/tenants/acme/status",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(status.json().state).toBe("production-ready");
    });

    it("returns 404 for an unknown tenant", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/tenants/missing/onboard",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { otp: "1", solutionName: "T" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("OTP never leaks into the audit log", async () => {
      const auditLog = createMemoryAuditLog();
      const { app: fresh } = await bootApp({ auditLog });
      await fresh.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: TENANT_BODY,
      });
      await fresh.inject({
        method: "POST",
        url: "/v1/tenants/acme/onboard",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { otp: "OTP-SECRET-123", solutionName: "T", environment: "simulation" },
      });
      const rows = await auditLog.list();
      expect(JSON.stringify(rows)).not.toContain("OTP-SECRET-123");
      await fresh.close();
    });

    it("/unlock recovers a tenant wedged in state=onboarding with NULL claimExpiresAt (CR-02 + HI-06)", async () => {
      const { app: fresh, registry } = await bootApp();
      try {
        await fresh.inject({
          method: "POST",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: TENANT_BODY,
        });
        // Force the wedged state directly through the registry: a
        // realistic scenario is a crash mid-setState where the
        // expiry never persisted, but the cleanest way to test is to
        // call setState directly.
        await registry.tenants.setState("acme", "onboarding", { claimedBy: "instance-1" });
        const wedged = await registry.tenants.get("acme");
        expect(wedged?.state).toBe("onboarding");
        expect(wedged?.claimExpiresAt).toBeUndefined();
        // /unlock without `force` should still succeed (recoverable
        // because the lock is effectively not held).
        const unlocked = await fresh.inject({
          method: "POST",
          url: "/v1/tenants/acme/unlock",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: {},
        });
        expect(unlocked.statusCode).toBe(200);
        expect(unlocked.json().state).toBe("failed");
      } finally {
        await fresh.close();
      }
    });

    it("/unlock with {force:true} releases an active claim that has a future expiry (HI-06)", async () => {
      const { app: fresh, registry } = await bootApp();
      try {
        await fresh.inject({
          method: "POST",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: TENANT_BODY,
        });
        await registry.tenants.setState("acme", "onboarding", {
          claimedBy: "instance-1",
          claimExpiresAt: new Date(Date.now() + 600_000),
        });
        // Without force: refuse (active claim).
        const refused = await fresh.inject({
          method: "POST",
          url: "/v1/tenants/acme/unlock",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: {},
        });
        expect(refused.statusCode).toBe(400);
        // With force=true: succeeds.
        const forced = await fresh.inject({
          method: "POST",
          url: "/v1/tenants/acme/unlock",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { force: true },
        });
        expect(forced.statusCode).toBe(200);
        expect(forced.json().state).toBe("failed");
      } finally {
        await fresh.close();
      }
    });

    it("re-onboard from a wedged state=onboarding/NULL-expiry succeeds (CR-02)", async () => {
      const { app: fresh, registry } = await bootApp();
      try {
        await fresh.inject({
          method: "POST",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: TENANT_BODY,
        });
        // Wedge: state=onboarding, NULL claimExpiresAt.
        await registry.tenants.setState("acme", "onboarding", { claimedBy: "instance-1" });
        // runOnboarding's expectedFrom loop now includes 'onboarding'
        // so the wedged tenant can recover without /unlock.
        const res = await fresh.inject({
          method: "POST",
          url: "/v1/tenants/acme/onboard",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { otp: "123456", solutionName: "Test", environment: "simulation" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().state).toBe("production-ready");
      } finally {
        await fresh.close();
      }
    });

    it("Idempotency-Key replays the cached response without burning a second OTP (CR-03)", async () => {
      // Count how many times the underlying onboard helper runs. With
      // a matching Idempotency-Key the second call must NOT invoke it.
      let onboardCallCount = 0;
      const countingOnboard = (async () => {
        onboardCallCount += 1;
        return {
          privateKey: "PRIV",
          csr: "CSR",
          complianceCertificate: "COMP-CERT",
          complianceBinarySecurityToken: "COMP-BST",
          complianceApiSecret: "COMP-SECRET",
          complianceRequestId: "comp-req-1",
          productionCertificate: "PROD-CERT",
          productionBinarySecurityToken: "PROD-BST",
          productionApiSecret: "PROD-SECRET",
          productionRequestId: "prod-req-1",
          complianceTestReport: {
            overallStatus: "passed" as const,
            results: [],
            finalInvoiceHash: "" as never,
          },
        };
      }) as never;
      const cfg = freshConfig();
      const cipher = createAesGcmCipher({ keyring: cfg.masterKeys, activeKid: cfg.activeKid });
      const registry = createMemoryRegistry({ cipher });
      const storage = createMemoryStorageAdapter();
      const auditLog = createMemoryAuditLog();
      const fresh = await buildApp({
        config: cfg,
        registry,
        storage,
        auditLog,
        onboardingHooks: {
          onboardFn: countingOnboard,
          getExpiry: () => new Date(Date.now() + 365 * 86_400_000),
        },
      });
      try {
        await fresh.inject({
          method: "POST",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: TENANT_BODY,
        });
        const headers = {
          authorization: `Bearer ${ADMIN_KEY}`,
          "idempotency-key": "client-attempt-1",
        };
        const first = await fresh.inject({
          method: "POST",
          url: "/v1/tenants/acme/onboard",
          headers,
          payload: { otp: "OTP-1", solutionName: "T", environment: "simulation" },
        });
        expect(first.statusCode).toBe(200);
        expect(onboardCallCount).toBe(1);
        // Same Idempotency-Key — replay path. The route MUST NOT
        // invoke the onboarding helper a second time. The replay sets
        // an `x-idempotent-replay` header for client observability.
        const second = await fresh.inject({
          method: "POST",
          url: "/v1/tenants/acme/onboard",
          headers,
          payload: { otp: "OTP-2-DIFFERENT", solutionName: "X", environment: "simulation" },
        });
        expect(second.statusCode).toBe(200);
        expect(onboardCallCount).toBe(1);
        expect(second.headers["x-idempotent-replay"]).toBe("true");
        // A request without an Idempotency-Key bypasses the cache.
        // The route will still fail (tenant is already production-
        // ready) but it must reach runOnboarding before failing — so
        // the count goes up. We test the cache-bypass at the
        // observability layer: no x-idempotent-replay header.
        const third = await fresh.inject({
          method: "POST",
          url: "/v1/tenants/acme/onboard",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { otp: "OTP-3", solutionName: "T", environment: "simulation" },
        });
        expect(third.headers["x-idempotent-replay"]).toBeUndefined();
      } finally {
        await fresh.close();
      }
    });
  });

  describe("transactional integrity (CR-01)", () => {
    it("mutating routes invoke withUnitOfWork so mutation + audit share a tx", async () => {
      // Count UoW invocations: every mutating route must enter the
      // primitive at least once. The pass-through default doesn't
      // give real DB isolation in tests, but it does prove that the
      // wiring is in place — production Postgres will get real
      // BEGIN/COMMIT from `createPostgresWithUnitOfWork`.
      let uowInvocations = 0;
      const cfg = freshConfig();
      const cipher = createAesGcmCipher({ keyring: cfg.masterKeys, activeKid: cfg.activeKid });
      const registry = createMemoryRegistry({ cipher });
      const storage = createMemoryStorageAdapter();
      const auditLog = createMemoryAuditLog();
      const fresh = await buildApp({
        config: cfg,
        registry,
        storage,
        auditLog,
        // Wrap the pass-through default with a counting decorator.
        withUnitOfWork: async (fn) => {
          uowInvocations += 1;
          return fn({
            tenants: registry.tenants,
            vault: registry.vault,
            apiKeys: registry.apiKeys,
            auditLog,
          });
        },
        onboardingHooks: {
          onboardFn: stubOnboard(),
          getExpiry: () => new Date(Date.now() + 365 * 86_400_000),
        },
      });
      try {
        // tenant.created — one UoW.
        await fresh.inject({
          method: "POST",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: TENANT_BODY,
        });
        expect(uowInvocations).toBeGreaterThanOrEqual(1);
        const after1 = uowInvocations;
        // tenant.patched — one more UoW.
        await fresh.inject({
          method: "PATCH",
          url: "/v1/tenants/acme",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { vatName: "Renamed" },
        });
        expect(uowInvocations).toBeGreaterThan(after1);
        const after2 = uowInvocations;
        // apiKey.issued — one more UoW.
        await fresh.inject({
          method: "POST",
          url: "/v1/tenants/acme/api-keys",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { label: "ops" },
        });
        expect(uowInvocations).toBeGreaterThan(after2);
        const after3 = uowInvocations;
        // tenant.onboarded — at least one UoW (the success batch).
        await fresh.inject({
          method: "POST",
          url: "/v1/tenants/acme/onboard",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { otp: "1", solutionName: "T", environment: "simulation" },
        });
        expect(uowInvocations).toBeGreaterThan(after3);
      } finally {
        await fresh.close();
      }
    });

    it("audit-write failure rolls back the tenant.created mutation", async () => {
      // A failing auditLog write inside the UoW must abort the
      // mutation. In the pass-through implementation, our UoW
      // decorator can simulate the rollback by re-deleting whatever
      // was just created when the inner callback throws.
      const cfg = freshConfig();
      const cipher = createAesGcmCipher({ keyring: cfg.masterKeys, activeKid: cfg.activeKid });
      const registry = createMemoryRegistry({ cipher });
      const storage = createMemoryStorageAdapter();
      const failingAudit: AuditLog = {
        write: async () => {
          throw new Error("audit infra down");
        },
        list: async () => [],
      };
      // For the test, simulate a real transactional UoW: when the
      // callback throws, undo any tenant.create call by tracking the
      // tenantRef and soft-deleting on rollback. This stands in for
      // the Postgres BEGIN/ROLLBACK that production gets.
      const fresh = await buildApp({
        config: cfg,
        registry,
        storage,
        auditLog: failingAudit,
        withUnitOfWork: async (fn) => {
          const before = (await registry.tenants.list({ includeDeleted: false })).map(
            (t) => t.tenantRef,
          );
          try {
            return await fn({
              tenants: registry.tenants,
              vault: registry.vault,
              apiKeys: registry.apiKeys,
              auditLog: failingAudit,
            });
          } catch (err) {
            // Rollback simulation: hard-revert anything created
            // inside the tx that wasn't present before.
            const after = await registry.tenants.list({ includeDeleted: false });
            for (const t of after) {
              if (!before.includes(t.tenantRef)) {
                await registry.tenants.softDelete(t.tenantRef);
              }
            }
            throw err;
          }
        },
      });
      try {
        const res = await fresh.inject({
          method: "POST",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: TENANT_BODY,
        });
        // The audit-write blew up; the error mapper turns it into 500.
        expect(res.statusCode).toBe(500);
        // CRITICAL: the tenant must NOT be queryable after rollback.
        // Pre-fix this assertion would have failed because mutation +
        // audit were independent awaits.
        const list = await fresh.inject({
          method: "GET",
          url: "/v1/tenants",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
        });
        expect(list.json().tenants).toHaveLength(0);
      } finally {
        await fresh.close();
      }
    });
  });

  describe("api keys", () => {
    async function setupTenant() {
      await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: TENANT_BODY,
      });
    }

    it("issues, lists, and revokes — plaintext is never re-exposed", async () => {
      await setupTenant();
      const issued = await app.inject({
        method: "POST",
        url: "/v1/tenants/acme/api-keys",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { label: "ops" },
      });
      expect(issued.statusCode).toBe(201);
      const token: string = issued.json().token;
      expect(token).toMatch(/^zts_live_acme_[A-Z2-7]{32}$/);
      const tokenId: string = issued.json().tokenId;

      const list = await app.inject({
        method: "GET",
        url: "/v1/tenants/acme/api-keys",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().keys).toHaveLength(1);
      expect(JSON.stringify(list.json())).not.toContain(token);

      const revoked = await app.inject({
        method: "DELETE",
        url: `/v1/tenants/acme/api-keys/${tokenId}`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(revoked.statusCode).toBe(204);
    });

    it("404 when issuing for unknown tenant", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/tenants/missing/api-keys",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { label: "ops" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("cross-tenant revoke returns 404 and leaves the target token live (CR-04)", async () => {
      await setupTenant();
      // Set up a second tenant so an admin can pose as that tenant's
      // URL while targeting acme's token id.
      await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { ...TENANT_BODY, tenantRef: "globex" },
      });
      // Issue a token under 'acme'.
      const issued = await app.inject({
        method: "POST",
        url: "/v1/tenants/acme/api-keys",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { label: "ops" },
      });
      const tokenId: string = issued.json().tokenId;
      // Attempt to revoke acme's token via globex's URL — must 404,
      // not 204. The route must NOT silently target the wrong tenant.
      const wrong = await app.inject({
        method: "DELETE",
        url: `/v1/tenants/globex/api-keys/${tokenId}`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(wrong.statusCode).toBe(404);
      // The token is still active on acme: a follow-up correct revoke
      // succeeds with 204.
      const right = await app.inject({
        method: "DELETE",
        url: `/v1/tenants/acme/api-keys/${tokenId}`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(right.statusCode).toBe(204);
      // Second attempt is also 404 (already revoked / no active row).
      const second = await app.inject({
        method: "DELETE",
        url: `/v1/tenants/acme/api-keys/${tokenId}`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(second.statusCode).toBe(404);
    });
  });

  describe("tenant bearer auth on invoice routes", () => {
    async function setupAndOnboard(): Promise<{ token: string }> {
      await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: TENANT_BODY,
      });
      await app.inject({
        method: "POST",
        url: "/v1/tenants/acme/onboard",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { otp: "1", solutionName: "T", environment: "simulation" },
      });
      const issued = await app.inject({
        method: "POST",
        url: "/v1/tenants/acme/api-keys",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { label: "ops" },
      });
      return { token: issued.json().token };
    }

    it("401 without bearer", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/tenants/acme/invoices/inv-1",
      });
      expect(res.statusCode).toBe(401);
    });

    it("401 with malformed bearer", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/tenants/acme/invoices/inv-1",
        headers: { authorization: "Bearer not-a-token" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("401 when bearer is for a different tenant than the URL (ME-06)", async () => {
      const { token } = await setupAndOnboard();
      // Create a second tenant to scope the URL to.
      await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: {
          ...TENANT_BODY,
          tenantRef: "globex",
          egsUuid: "00000000-0000-4000-8000-000000000002",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/v1/tenants/globex/invoices/inv-1",
        headers: { authorization: `Bearer ${token}` },
      });
      // ME-06: was 403; now 401 so an attacker cannot distinguish
      // "valid bearer / wrong tenant" from "invalid bearer" and
      // enumerate the tenant directory.
      expect(res.statusCode).toBe(401);
    });

    it("404 for an unknown invoice id under a matched tenant", async () => {
      const { token } = await setupAndOnboard();
      const res = await app.inject({
        method: "GET",
        url: "/v1/tenants/acme/invoices/never-was",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
