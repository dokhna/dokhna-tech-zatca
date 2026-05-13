/**
 * Integration tests for {@link onboard}.
 *
 * The OpenSSL CLI helpers are injected (via `args.crypto`) so the
 * tests don't actually shell out; the test cert + key fixtures from
 * `packages/core/src/fixtures/_keys/` stand in for the real key
 * material and the ZATCA gateway is fronted by msw.
 *
 * Coverage:
 *   - Happy path: every external call succeeds → result carries the
 *     compliance + production artifacts and the compliance test
 *     report.
 *   - Compliance certificate failure (step 4 returns 400): onboarding
 *     throws and the CSID endpoint is never called.
 *   - Compliance test failure (one scenario returns errorMessages):
 *     onboarding throws ZatcaOnboardingError and the CSID endpoint
 *     is never called.
 *   - Production environment is rejected (compliance tests cannot
 *     run there).
 */

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZATCA_ENDPOINTS } from "../api/endpoints.js";
import {
  makeTestEgsInfo,
  readTestKeys,
} from "../invoices/_test-helpers.js";
import { ZatcaApiError, ZatcaOnboardingError } from "../types/errors.js";
import { onboard, type OnboardArgs } from "./onboard.js";

const ENV = "sandbox" as const;
const COMPLIANCE_CERT_URL = `${ZATCA_ENDPOINTS[ENV].base}${ZATCA_ENDPOINTS[ENV].complianceCertificate}`;
const COMPLIANCE_URL = `${ZATCA_ENDPOINTS[ENV].base}${ZATCA_ENDPOINTS[ENV].compliance}`;
const CSIDS_URL = `${ZATCA_ENDPOINTS[ENV].base}${ZATCA_ENDPOINTS[ENV].csids}`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * Build an OnboardArgs that uses the bundled fixture cert + key as
 * the "freshly generated" material. The CSR generator returns a
 * placeholder string — ZATCA's response is stubbed anyway.
 */
function makeArgs(overrides: Partial<OnboardArgs> = {}): OnboardArgs {
  const keys = readTestKeys();
  const egsInfo = makeTestEgsInfo();
  return {
    egsInfo,
    otp: "123456",
    environment: ENV,
    solutionName: "TestSolution",
    httpClientOptions: {
      retries: { count: 0, baseMs: 1, jitterMs: 0 },
    },
    crypto: {
      skipOpensslProbe: true,
      generateKeyPair: () => Promise.resolve(keys.signingPrivateKeyPem),
      generateCSR: () =>
        Promise.resolve(
          "-----BEGIN CERTIFICATE REQUEST-----\nMIIB...stub\n-----END CERTIFICATE REQUEST-----\n",
        ),
    },
    ...overrides,
  };
}

/**
 * The compliance-certificate endpoint expects a base64-encoded PEM
 * body in `binarySecurityToken`. We re-pack the fixture cert into
 * that shape so the package's decoder returns a valid PEM that the
 * Phase 2 signing pipeline can consume.
 */
function complianceCertResponseBody(): {
  binarySecurityToken: string;
  secret: string;
  requestID: string;
  dispositionMessage: string;
} {
  const keys = readTestKeys();
  // ZATCA returns `binarySecurityToken` as base64(PEM_body). The
  // package's decoder base64-decodes and re-wraps with armour. So we
  // base64-encode the body (without `-----BEGIN/END-----` lines).
  const body = keys.signingCertificatePem
    .replace("-----BEGIN CERTIFICATE-----\n", "")
    .replace("-----END CERTIFICATE-----", "")
    .trim();
  return {
    binarySecurityToken: Buffer.from(body).toString("base64"),
    secret: "COMP-SECRET",
    requestID: "REQ-COMP-001",
    dispositionMessage: "Compliance certificate issued",
  };
}

/**
 * Stub a passing compliance result envelope.
 */
function passingComplianceResponse() {
  return {
    validationResults: {
      errorMessages: [],
      warningMessages: [],
      infoMessages: [],
      status: "PASS",
    },
    clearanceStatus: "CLEARED",
  };
}

describe("onboard — happy path", () => {
  it("returns compliance + production artifacts when every step succeeds", async () => {
    let csidsCalls = 0;
    server.use(
      http.post(COMPLIANCE_CERT_URL, () =>
        HttpResponse.json(complianceCertResponseBody()),
      ),
      http.post(COMPLIANCE_URL, () =>
        HttpResponse.json(passingComplianceResponse()),
      ),
      http.post(CSIDS_URL, () => {
        csidsCalls += 1;
        return HttpResponse.json({
          binarySecurityToken: Buffer.from("PROD-CERT-BODY").toString("base64"),
          secret: "PROD-SECRET",
          requestID: "REQ-PROD-001",
          dispositionMessage: "Production CSID issued",
        });
      }),
    );

    const result = await onboard(makeArgs());

    expect(result.privateKey).toMatch(/BEGIN EC PRIVATE KEY/);
    expect(result.csr).toMatch(/BEGIN CERTIFICATE REQUEST/);
    expect(result.complianceCertificate).toMatch(/BEGIN CERTIFICATE/);
    expect(result.complianceApiSecret).toBe("COMP-SECRET");
    expect(result.complianceRequestId).toBe("REQ-COMP-001");
    expect(result.productionApiSecret).toBe("PROD-SECRET");
    expect(result.productionRequestId).toBe("REQ-PROD-001");
    expect(result.complianceTestReport.overallStatus).toBe("passed");
    expect(result.complianceTestReport.results.length).toBe(6);
    expect(csidsCalls).toBe(1);
  });
});

describe("onboard — failure paths", () => {
  it("throws and skips CSID when the compliance certificate call returns 4xx", async () => {
    let csidsCalls = 0;
    server.use(
      http.post(COMPLIANCE_CERT_URL, () =>
        HttpResponse.json(
          {
            validationResults: {
              errorMessages: [
                { code: "X", message: "bad otp", category: "ERROR" },
              ],
            },
          },
          { status: 400 },
        ),
      ),
      http.post(CSIDS_URL, () => {
        csidsCalls += 1;
        return HttpResponse.json({});
      }),
    );

    await expect(() => onboard(makeArgs())).rejects.toBeInstanceOf(
      ZatcaApiError,
    );
    expect(csidsCalls).toBe(0);
  });

  it("throws ZatcaOnboardingError and skips CSID when a compliance scenario fails", async () => {
    let csidsCalls = 0;
    let complianceCalls = 0;
    server.use(
      http.post(COMPLIANCE_CERT_URL, () =>
        HttpResponse.json(complianceCertResponseBody()),
      ),
      http.post(COMPLIANCE_URL, () => {
        complianceCalls += 1;
        if (complianceCalls === 2) {
          return HttpResponse.json({
            validationResults: {
              errorMessages: [
                {
                  code: "BR-KSA-99",
                  message: "Standard invoice rejected",
                  category: "ERROR-INVOICE",
                  status: "ERROR",
                },
              ],
            },
          });
        }
        return HttpResponse.json(passingComplianceResponse());
      }),
      http.post(CSIDS_URL, () => {
        csidsCalls += 1;
        return HttpResponse.json({});
      }),
    );

    await expect(() => onboard(makeArgs())).rejects.toBeInstanceOf(
      ZatcaOnboardingError,
    );
    expect(csidsCalls).toBe(0);
  });

  it("throws ZatcaOnboardingError when environment='production' is supplied", async () => {
    server.use(
      http.post(COMPLIANCE_CERT_URL, () =>
        HttpResponse.json(complianceCertResponseBody()),
      ),
    );
    await expect(() =>
      onboard(makeArgs({ environment: "production" })),
    ).rejects.toBeInstanceOf(ZatcaOnboardingError);
  });

  it("throws ZatcaOnboardingError when otp is missing", async () => {
    await expect(() =>
      onboard(makeArgs({ otp: "" })),
    ).rejects.toBeInstanceOf(ZatcaOnboardingError);
  });
});
