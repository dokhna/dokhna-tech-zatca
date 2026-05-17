import {
  asCommercialRegistrationNumber,
  asEGSUuid,
  asVATNumber,
  type OnboardingResult,
} from "@dokhna-tech/zatca";
import { describe, expect, it } from "vitest";

import { createMemoryAuditLog } from "../audit/index.js";
import { createAesGcmCipher, type MasterKey } from "../crypto/aes-gcm-cipher.js";
import { ZatcaRegistryError, ZatcaServerError } from "../errors.js";
import { createMemoryRegistry } from "../tenants/registry-memory.js";
import type { CreateTenantInput } from "../tenants/types.js";

import { runOnboarding } from "./run.js";

const LOCATION = {
  cityName: "Riyadh",
  citySubdivision: "Olaya",
  street: "King Fahd Rd",
  plotIdentification: "1234",
  building: "5678",
  postalZone: "12345",
};

function key(kid: string): MasterKey {
  return { kid, key: Buffer.alloc(32, kid.charCodeAt(0)) };
}

function tenantInput(): CreateTenantInput {
  return {
    tenantRef: "acme",
    vatNumber: asVATNumber("301234567890003"),
    egsUuid: asEGSUuid("00000000-0000-4000-8000-000000000001"),
    vatName: "Acme Trading Co.",
    crn: asCommercialRegistrationNumber("1010010101"),
    branchName: "Riyadh HQ",
    branchIndustry: "Retail",
    location: LOCATION,
    environment: "simulation",
  };
}

interface StubOptions {
  failOverall?: boolean;
  scenarios?: ReadonlyArray<{ scenarioName: string; passed: boolean }>;
}

function fakeOnboarding(opts: StubOptions = {}): typeof import("@dokhna-tech/zatca").onboard {
  return async (args) => {
    const scenarios = opts.scenarios ?? [
      { scenarioName: "simplified-tax-invoice", passed: true },
      { scenarioName: "standard-tax-invoice", passed: true },
      { scenarioName: "simplified-credit-note", passed: true },
      { scenarioName: "standard-credit-note", passed: true },
      { scenarioName: "simplified-debit-note", passed: true },
      { scenarioName: "standard-debit-note", passed: true },
    ];
    // Fire the onProgress callback exactly as the real onboard would.
    if (args.onProgress !== undefined) {
      let count = 0;
      for (const s of scenarios) {
        count += 1;
        await args.onProgress({
          scenarioName: s.scenarioName,
          invoiceKind: "simplified-tax-invoice",
          passed: s.passed,
          errors: s.passed ? [] : ["fake-error"],
          completedCount: count,
          totalCount: 6,
        });
      }
    }
    const overallStatus =
      opts.failOverall === true || scenarios.some((s) => !s.passed) ? "failed" : "passed";
    const result: OnboardingResult = {
      privateKey: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----",
      csr: "-----BEGIN CERTIFICATE REQUEST-----\nFAKE\n-----END CERTIFICATE REQUEST-----",
      complianceCertificate: "COMP-CERT",
      complianceBinarySecurityToken: "COMP-BST",
      complianceApiSecret: "COMP-SECRET",
      complianceRequestId: "comp-req-1",
      productionCertificate: "PROD-CERT",
      productionBinarySecurityToken: "PROD-BST",
      productionApiSecret: "PROD-SECRET",
      productionRequestId: "prod-req-1",
      complianceTestReport: {
        overallStatus,
        results: [],
        finalInvoiceHash: "" as never,
      },
    };
    return result;
  };
}

function fixedExpiry(date: Date): (cert: string) => Date {
  return () => date;
}

function freshSetup() {
  const cipher = createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
  const registry = createMemoryRegistry({ cipher });
  const auditLog = createMemoryAuditLog();
  return { cipher, registry, auditLog };
}

describe("runOnboarding", () => {
  describe("happy path", () => {
    it("transitions tenant to production-ready, persists vault, writes audit ok row", async () => {
      const { registry, auditLog } = freshSetup();
      await registry.tenants.create(tenantInput());
      const expiry = new Date(Date.now() + 365 * 86_400_000);
      const result = await runOnboarding({
        tenantRef: "acme",
        otp: "123456",
        solutionName: "test solution",
        environment: "simulation",
        instanceId: "test-instance",
        registry: { tenants: registry.tenants, vault: registry.vault },
        auditLog,
        actor: { type: "admin", label: "ops" },
        onboardFn: fakeOnboarding(),
        getExpiry: fixedExpiry(expiry),
      });

      expect(result.state).toBe("production-ready");
      expect(result.complianceTestStatus).toBe("passed");
      expect(result.productionCertificateExpiresAt).toEqual(expiry);
      expect(result.productionRequestId).toBe("prod-req-1");

      const record = await registry.tenants.get("acme");
      expect(record?.state).toBe("production-ready");
      expect(record?.claimedBy).toBeUndefined();
      expect(record?.claimExpiresAt).toBeUndefined();
      expect(record?.productionCertificateExpiresAt).toEqual(expiry);

      const stored = await registry.vault.get("acme");
      expect(stored?.privateKey).toMatch(/FAKE/);
      expect(stored?.productionCertificate).toBe("PROD-CERT");
      expect(stored?.complianceApiSecret).toBe("COMP-SECRET");

      const audit = await auditLog.list();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe("tenant.onboarded");
      expect(audit[0]?.result).toBe("ok");
      // OTP must not leak into the audit row.
      expect(JSON.stringify(audit[0])).not.toContain("123456");
    });

    it("persists per-scenario progress as the run advances", async () => {
      const { registry, auditLog } = freshSetup();
      await registry.tenants.create(tenantInput());
      await runOnboarding({
        tenantRef: "acme",
        otp: "123456",
        solutionName: "test solution",
        environment: "simulation",
        instanceId: "i",
        registry: { tenants: registry.tenants, vault: registry.vault },
        auditLog,
        actor: { type: "admin", label: "ops" },
        onboardFn: fakeOnboarding(),
        getExpiry: fixedExpiry(new Date()),
      });
      const record = await registry.tenants.get("acme");
      expect(record?.onboardingProgress.scenarios).toEqual({
        "simplified-tax-invoice": "passed",
        "standard-tax-invoice": "passed",
        "simplified-credit-note": "passed",
        "standard-credit-note": "passed",
        "simplified-debit-note": "passed",
        "standard-debit-note": "passed",
      });
    });
  });

  describe("preconditions", () => {
    it("throws ZatcaRegistryError when tenant is unknown", async () => {
      const { registry, auditLog } = freshSetup();
      await expect(
        runOnboarding({
          tenantRef: "missing",
          otp: "1",
          solutionName: "s",
          environment: "simulation",
          instanceId: "i",
          registry: { tenants: registry.tenants, vault: registry.vault },
          auditLog,
          actor: { type: "admin", label: "ops" },
          onboardFn: fakeOnboarding(),
          getExpiry: fixedExpiry(new Date()),
        }),
      ).rejects.toThrow(ZatcaRegistryError);
    });

    it("refuses when another onboarding lock is still active", async () => {
      const { registry, auditLog } = freshSetup();
      await registry.tenants.create(tenantInput());
      await registry.tenants.setState("acme", "onboarding", {
        expectedFrom: "created",
        claimedBy: "other-instance",
        claimExpiresAt: new Date(Date.now() + 60_000),
      });
      await expect(
        runOnboarding({
          tenantRef: "acme",
          otp: "1",
          solutionName: "s",
          environment: "simulation",
          instanceId: "me",
          registry: { tenants: registry.tenants, vault: registry.vault },
          auditLog,
          actor: { type: "admin", label: "ops" },
          onboardFn: fakeOnboarding(),
          getExpiry: fixedExpiry(new Date()),
        }),
      ).rejects.toThrow(/already onboarding/);
    });

    it("reclaims an expired lock from a crashed prior instance", async () => {
      const { registry, auditLog } = freshSetup();
      await registry.tenants.create(tenantInput());
      // Simulate a dead onboarder: state=onboarding, claim in the past.
      await registry.tenants.setState("acme", "onboarding", {
        expectedFrom: "created",
        claimedBy: "dead-instance",
        claimExpiresAt: new Date(Date.now() - 1000),
      });
      // Pre-flight in the wrapper lets this through (claim is expired),
      // and the store's setState honors expired claims as if the slot
      // were free — so a new instance can complete the onboarding.
      const result = await runOnboarding({
        tenantRef: "acme",
        otp: "1",
        solutionName: "s",
        environment: "simulation",
        instanceId: "me",
        registry: { tenants: registry.tenants, vault: registry.vault },
        auditLog,
        actor: { type: "admin", label: "ops" },
        onboardFn: fakeOnboarding(),
        getExpiry: fixedExpiry(new Date()),
      });
      expect(result.state).toBe("production-ready");
      expect((await registry.tenants.get("acme"))?.claimedBy).toBeUndefined();
    });

    it("permits re-onboard after a prior failure", async () => {
      const { registry, auditLog } = freshSetup();
      await registry.tenants.create(tenantInput());
      await registry.tenants.setState("acme", "failed", { lastError: "prior" });
      const result = await runOnboarding({
        tenantRef: "acme",
        otp: "1",
        solutionName: "s",
        environment: "simulation",
        instanceId: "me",
        registry: { tenants: registry.tenants, vault: registry.vault },
        auditLog,
        actor: { type: "admin", label: "ops" },
        onboardFn: fakeOnboarding(),
        getExpiry: fixedExpiry(new Date()),
      });
      expect(result.state).toBe("production-ready");
    });

    it("permits credentials rotation from production-ready", async () => {
      const { registry, auditLog } = freshSetup();
      await registry.tenants.create(tenantInput());
      await registry.tenants.setState("acme", "production-ready", {});
      const result = await runOnboarding({
        tenantRef: "acme",
        otp: "1",
        solutionName: "s",
        environment: "simulation",
        instanceId: "me",
        registry: { tenants: registry.tenants, vault: registry.vault },
        auditLog,
        actor: { type: "admin", label: "ops" },
        onboardFn: fakeOnboarding(),
        getExpiry: fixedExpiry(new Date()),
      });
      expect(result.state).toBe("production-ready");
    });
  });

  describe("failure path", () => {
    it("transitions to failed, writes audit error row, rethrows", async () => {
      const { registry, auditLog } = freshSetup();
      await registry.tenants.create(tenantInput());
      const failing: typeof import("@dokhna-tech/zatca").onboard = async () => {
        throw new Error("ZATCA refused the OTP");
      };
      await expect(
        runOnboarding({
          tenantRef: "acme",
          otp: "1",
          solutionName: "s",
          environment: "simulation",
          instanceId: "me",
          registry: { tenants: registry.tenants, vault: registry.vault },
          auditLog,
          actor: { type: "admin", label: "ops" },
          onboardFn: failing,
          getExpiry: fixedExpiry(new Date()),
        }),
      ).rejects.toThrow(/refused the OTP/);
      const record = await registry.tenants.get("acme");
      expect(record?.state).toBe("failed");
      expect(record?.onboardingProgress.lastError).toMatch(/refused the OTP/);
      expect(record?.claimedBy).toBeUndefined();
      const audit = await auditLog.list();
      expect(audit[0]?.result).toBe("error");
    });

    it("rejects when compliance report comes back failed even if core returned", async () => {
      const { registry, auditLog } = freshSetup();
      await registry.tenants.create(tenantInput());
      await expect(
        runOnboarding({
          tenantRef: "acme",
          otp: "1",
          solutionName: "s",
          environment: "simulation",
          instanceId: "me",
          registry: { tenants: registry.tenants, vault: registry.vault },
          auditLog,
          actor: { type: "admin", label: "ops" },
          onboardFn: fakeOnboarding({ failOverall: true }),
          getExpiry: fixedExpiry(new Date()),
        }),
      ).rejects.toThrow(ZatcaServerError);
      expect((await registry.tenants.get("acme"))?.state).toBe("failed");
    });

    it("rolls up to error when the cert-expiry parse fails", async () => {
      const { registry, auditLog } = freshSetup();
      await registry.tenants.create(tenantInput());
      await expect(
        runOnboarding({
          tenantRef: "acme",
          otp: "1",
          solutionName: "s",
          environment: "simulation",
          instanceId: "me",
          registry: { tenants: registry.tenants, vault: registry.vault },
          auditLog,
          actor: { type: "admin", label: "ops" },
          onboardFn: fakeOnboarding(),
          getExpiry: () => {
            throw new Error("malformed PEM");
          },
        }),
      ).rejects.toThrow(/expiry could not be parsed/);
      expect((await registry.tenants.get("acme"))?.state).toBe("failed");
    });
  });
});
