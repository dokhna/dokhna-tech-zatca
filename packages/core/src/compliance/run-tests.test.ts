/**
 * Tests for {@link runComplianceTests}.
 *
 * Coverage:
 *   - Happy path: 6 staged 200 responses → overallStatus === "passed",
 *     and the runner submitted exactly one request per kind, in order.
 *   - Failed path: one scenario returns `validationResults.errorMessages`
 *     → overallStatus === "failed" but the remaining scenarios still run.
 *   - Setup-error path: missing `apiCredentials.apiSecret` throws
 *     {@link ZatcaOnboardingError} synchronously (no scenarios run).
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZATCA_ENDPOINTS } from "../api/endpoints.js";
import { makeTestEgsInfo, readTestKeys } from "../invoices/_test-helpers.js";
import { ZatcaOnboardingError } from "../types/errors.js";
import { runComplianceTests } from "./run-tests.js";

const ENV = "sandbox" as const;
const COMPLIANCE_URL = `${ZATCA_ENDPOINTS[ENV].base}${ZATCA_ENDPOINTS[ENV].compliance}`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function commonArgs() {
  const egsInfo = makeTestEgsInfo();
  const keys = readTestKeys();
  return {
    egsInfo,
    environment: ENV,
    signing: {
      certificate: keys.signingCertificatePem,
      privateKey: keys.signingPrivateKeyPem,
    },
    apiCredentials: {
      binarySecurityToken: "TOKEN-BASE64",
      apiSecret: "SECRET",
    },
    httpClientOptions: {
      retries: { count: 0, baseMs: 1, jitterMs: 0 },
    },
  } as const;
}

describe("runComplianceTests — happy path", () => {
  it("submits 6 scenarios in order and reports passed", async () => {
    let callCount = 0;
    const submittedHashes: string[] = [];
    server.use(
      http.post(COMPLIANCE_URL, async ({ request: req }) => {
        callCount += 1;
        const body = (await req.json()) as { invoiceHash?: string };
        if (body.invoiceHash !== undefined) {
          submittedHashes.push(body.invoiceHash);
        }
        return HttpResponse.json({
          validationResults: {
            errorMessages: [],
            warningMessages: [],
            infoMessages: [],
            status: "PASS",
          },
          clearanceStatus: "CLEARED",
        });
      }),
    );

    const report = await runComplianceTests(commonArgs());
    expect(callCount).toBe(6);
    expect(report.overallStatus).toBe("passed");
    expect(report.results.length).toBe(6);
    expect(report.results.map((r) => r.invoiceKind)).toEqual([
      "simplified-tax-invoice",
      "standard-tax-invoice",
      "simplified-credit-note",
      "standard-credit-note",
      "simplified-debit-note",
      "standard-debit-note",
    ]);
    for (const r of report.results) {
      expect(r.passed).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    }
    // Every submission carried a unique invoice hash.
    expect(new Set(submittedHashes).size).toBe(6);
    expect(report.finalInvoiceHash).toBe(report.results[5]?.invoiceHash ?? "");
  });
});

describe("runComplianceTests — failure paths", () => {
  it("reports overallStatus='failed' when one scenario returns errorMessages", async () => {
    let callCount = 0;
    server.use(
      http.post(COMPLIANCE_URL, () => {
        callCount += 1;
        // Fail the 3rd call (simplified credit note); pass the rest.
        if (callCount === 3) {
          return HttpResponse.json({
            validationResults: {
              errorMessages: [
                {
                  code: "BR-KSA-31",
                  message: "Hash mismatch",
                  category: "ERROR-INVOICE",
                  status: "ERROR",
                },
              ],
              warningMessages: [],
              infoMessages: [],
              status: "ERROR",
            },
          });
        }
        return HttpResponse.json({
          validationResults: {
            errorMessages: [],
            warningMessages: [],
            infoMessages: [],
            status: "PASS",
          },
        });
      }),
    );

    const report = await runComplianceTests(commonArgs());
    expect(report.overallStatus).toBe("failed");
    // All 6 scenarios still executed.
    expect(report.results.length).toBe(6);
    const failed = report.results.filter((r) => !r.passed);
    expect(failed.length).toBe(1);
    expect(failed[0]?.invoiceKind).toBe("simplified-credit-note");
    expect(failed[0]?.errors[0]).toContain("BR-KSA-31");
  });

  it("records a scenario as failed when the API throws (non-2xx)", async () => {
    let callCount = 0;
    server.use(
      http.post(COMPLIANCE_URL, () => {
        callCount += 1;
        if (callCount === 1) {
          return new HttpResponse(JSON.stringify({ message: "Bad Request" }), { status: 400 });
        }
        return HttpResponse.json({
          validationResults: {
            errorMessages: [],
            warningMessages: [],
            infoMessages: [],
            status: "PASS",
          },
        });
      }),
    );

    const report = await runComplianceTests(commonArgs());
    expect(report.overallStatus).toBe("failed");
    expect(report.results[0]?.passed).toBe(false);
    expect(report.results[0]?.errors[0]).toContain("ZatcaApiError");
  });

  it("throws ZatcaOnboardingError synchronously when api credentials are missing", async () => {
    const args = commonArgs();
    await expect(() =>
      runComplianceTests({
        ...args,
        apiCredentials: { binarySecurityToken: "", apiSecret: "" },
      }),
    ).rejects.toThrowError(ZatcaOnboardingError);
  });

  it("throws ZatcaOnboardingError synchronously when signing key is missing", async () => {
    const args = commonArgs();
    await expect(() =>
      runComplianceTests({
        ...args,
        signing: { certificate: args.signing.certificate, privateKey: "" },
      }),
    ).rejects.toThrowError(ZatcaOnboardingError);
  });

  it("uses caller-supplied storage adapter when provided", async () => {
    let counterCalls = 0;
    let recordCalls = 0;
    const externalStorage = {
      async incrementCounter() {
        counterCalls += 1;
        return {
          sequence: counterCalls,
          invoiceNumber: `EXT-${String(counterCalls).padStart(4, "0")}`,
        };
      },
      async getPreviousHash() {
        return "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as Parameters<
          typeof externalStorage.recordInvoice
        >[1]["invoiceHash"];
      },
      async recordInvoice() {
        recordCalls += 1;
      },
      async loadInvoice() {
        return null;
      },
      async updateInvoiceStatus() {
        // no-op
      },
    };
    server.use(
      http.post(COMPLIANCE_URL, () =>
        HttpResponse.json({
          validationResults: {
            errorMessages: [],
            warningMessages: [],
            infoMessages: [],
            status: "PASS",
          },
        }),
      ),
    );
    const report = await runComplianceTests({
      ...commonArgs(),
      storage: externalStorage,
    });
    expect(report.overallStatus).toBe("passed");
    expect(counterCalls).toBe(6);
    expect(recordCalls).toBe(6);
    // The serial advertised by the external adapter shows up in the
    // results — proves the caller's storage was actually used.
    expect(report.results[0]?.invoiceNumber).toBe("EXT-0001");
  });
});

describe("runComplianceTests — onProgress callback", () => {
  function passingHandler() {
    return http.post(COMPLIANCE_URL, () =>
      HttpResponse.json({
        validationResults: {
          errorMessages: [],
          warningMessages: [],
          infoMessages: [],
          status: "PASS",
        },
      }),
    );
  }

  it("fires once per scenario in submission order with the right shape", async () => {
    server.use(passingHandler());
    const events: Array<{ scenarioName: string; passed: boolean; completedCount: number }> = [];
    await runComplianceTests({
      ...commonArgs(),
      onProgress: (event) => {
        events.push({
          scenarioName: event.scenarioName,
          passed: event.passed,
          completedCount: event.completedCount,
        });
      },
    });
    expect(events).toHaveLength(6);
    expect(events.map((e) => e.scenarioName)).toEqual([
      "simplified-tax-invoice",
      "standard-tax-invoice",
      "simplified-credit-note",
      "standard-credit-note",
      "simplified-debit-note",
      "standard-debit-note",
    ]);
    expect(events.map((e) => e.completedCount)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.every((e) => e.passed)).toBe(true);
  });

  it("fires with passed=false when ZATCA returns errorMessages", async () => {
    let callCount = 0;
    server.use(
      http.post(COMPLIANCE_URL, () => {
        callCount += 1;
        if (callCount === 3) {
          return HttpResponse.json({
            validationResults: {
              errorMessages: [
                {
                  code: "BR-KSA-31",
                  message: "Hash mismatch",
                  category: "ERROR-INVOICE",
                  status: "ERROR",
                },
              ],
              warningMessages: [],
              infoMessages: [],
              status: "ERROR",
            },
          });
        }
        return HttpResponse.json({
          validationResults: {
            errorMessages: [],
            warningMessages: [],
            infoMessages: [],
            status: "PASS",
          },
        });
      }),
    );
    const events: Array<{ scenarioName: string; passed: boolean }> = [];
    await runComplianceTests({
      ...commonArgs(),
      onProgress: (e) => {
        events.push({ scenarioName: e.scenarioName, passed: e.passed });
      },
    });
    const failed = events.filter((e) => !e.passed);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.scenarioName).toBe("simplified-credit-note");
  });

  it("swallows thrown callback exceptions and still completes the run", async () => {
    server.use(passingHandler());
    let fired = 0;
    const report = await runComplianceTests({
      ...commonArgs(),
      onProgress: () => {
        fired += 1;
        throw new Error("callback always throws");
      },
    });
    expect(fired).toBe(6);
    expect(report.overallStatus).toBe("passed");
  });

  it("awaits async callbacks sequentially", async () => {
    server.use(passingHandler());
    const observed: number[] = [];
    let inFlight = 0;
    await runComplianceTests({
      ...commonArgs(),
      onProgress: async (e) => {
        inFlight += 1;
        // If two callbacks ever overlap, inFlight will be >1 here.
        observed.push(inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        // Mark progress so the assertion is meaningful.
        void e;
      },
    });
    expect(observed).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
