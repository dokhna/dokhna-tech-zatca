/**
 * Tests for `issueComplianceCertificate`.
 */

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZatcaApiError } from "../types/errors.js";
import { ZATCA_ENDPOINTS } from "./endpoints.js";
import { issueComplianceCertificate } from "./issue-compliance-cert.js";

const ENV = "sandbox" as const;
const URL = `${ZATCA_ENDPOINTS[ENV].base}${ZATCA_ENDPOINTS[ENV].complianceCertificate}`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const FAKE_CSR = "-----BEGIN CERTIFICATE REQUEST-----\nMIIB...\n-----END CERTIFICATE REQUEST-----";
const FAKE_PEM_BODY = "MIIDXTCCAkWg..."; // body without armour
const FAKE_TOKEN_B64 = Buffer.from(FAKE_PEM_BODY).toString("base64");

const INPUT = {
  csr: FAKE_CSR,
  otp: "123456",
  environment: ENV,
  httpOptions: { retries: { count: 3, baseMs: 5, jitterMs: 0 } },
} as const;

describe("issueComplianceCertificate — happy path", () => {
  it("sends OTP header and base64-encoded CSR; decodes returned certificate", async () => {
    let otp = "";
    let body: Record<string, unknown> = {};
    server.use(
      http.post(URL, async ({ request: req }) => {
        otp = req.headers.get("OTP") ?? "";
        body = (await req.json()) as Record<string, unknown>;
        return HttpResponse.json({
          binarySecurityToken: FAKE_TOKEN_B64,
          secret: "SECRET-XYZ",
          requestID: "REQ-1",
          dispositionMessage: "ISSUED",
        });
      }),
    );
    const out = await issueComplianceCertificate(INPUT);
    expect(otp).toBe("123456");
    expect(body["csr"]).toBe(Buffer.from(FAKE_CSR).toString("base64"));
    expect(out.binarySecurityToken).toBe(FAKE_TOKEN_B64);
    expect(out.apiSecret).toBe("SECRET-XYZ");
    expect(out.requestId).toBe("REQ-1");
    expect(out.issuedCertificate).toBe(
      `-----BEGIN CERTIFICATE-----\n${FAKE_PEM_BODY}\n-----END CERTIFICATE-----`,
    );
    expect(out.dispositionMessage).toBe("ISSUED");
  });
});

describe("issueComplianceCertificate — error paths", () => {
  it("throws ZatcaApiError(400) when OTP is rejected", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json({ message: "invalid otp" }, { status: 400 }),
      ),
    );
    try {
      await issueComplianceCertificate(INPUT);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      expect((err as ZatcaApiError).statusCode).toBe(400);
    }
  });

  it("retries on 503 and succeeds on third attempt", async () => {
    let calls = 0;
    server.use(
      http.post(URL, () => {
        calls += 1;
        if (calls < 3) return HttpResponse.json({}, { status: 503 });
        return HttpResponse.json({
          binarySecurityToken: FAKE_TOKEN_B64,
          secret: "S",
          requestID: "R",
        });
      }),
    );
    const out = await issueComplianceCertificate(INPUT);
    expect(out.requestId).toBe("R");
    expect(calls).toBe(3);
  });

  it("makes 4 calls and throws ZatcaApiError(503) on always-503", async () => {
    let calls = 0;
    server.use(
      http.post(URL, () => {
        calls += 1;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    await expect(issueComplianceCertificate(INPUT)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(calls).toBe(4);
  });

  it("rejects 200-response missing binarySecurityToken", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json({ secret: "S", requestID: "R" }),
      ),
    );
    await expect(issueComplianceCertificate(INPUT)).rejects.toBeInstanceOf(
      ZatcaApiError,
    );
  });

  it("rejects when csr is missing", async () => {
    await expect(
      issueComplianceCertificate({ ...INPUT, csr: "" }),
    ).rejects.toBeInstanceOf(ZatcaApiError);
  });

  it("rejects when otp is missing", async () => {
    await expect(
      issueComplianceCertificate({ ...INPUT, otp: "" }),
    ).rejects.toBeInstanceOf(ZatcaApiError);
  });
});
