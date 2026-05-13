/**
 * Tests for `checkInvoiceCompliance`.
 *
 * Coverage:
 *   - Happy path returns parsed body.
 *   - 4xx surfaces ZatcaApiError with the validation envelope parsed.
 *   - 5xx retried, then succeeds.
 *   - 5xx exhaustion throws ZatcaApiError(503) after 4 attempts.
 *   - Request body is the base64-encoded XML + hash + uuid trio.
 *   - Authorization header is HTTP Basic of token:secret.
 */

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZatcaApiError } from "../types/errors.js";
import { checkInvoiceCompliance } from "./compliance.js";
import { ZATCA_ENDPOINTS } from "./endpoints.js";

const ENV = "sandbox" as const;
const COMPLIANCE_URL = `${ZATCA_ENDPOINTS[ENV].base}${ZATCA_ENDPOINTS[ENV].compliance}`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const VALID_INPUT = {
  signedInvoiceXml: "<Invoice/>",
  invoiceHash: "abc123==",
  egsUuid: "11111111-2222-3333-4444-555555555555",
  binarySecurityToken: "TOKEN-BASE64",
  apiSecret: "SECRET",
  environment: ENV,
  httpOptions: { retries: { count: 3, baseMs: 5, jitterMs: 0 } },
} as const;

describe("checkInvoiceCompliance — happy path", () => {
  it("returns parsed response on 200", async () => {
    server.use(
      http.post(COMPLIANCE_URL, () =>
        HttpResponse.json({
          clearanceStatus: "CLEARED",
          validationResults: {
            errorMessages: [],
            warningMessages: [],
            infoMessages: [],
            status: "PASS",
          },
        }),
      ),
    );
    const out = await checkInvoiceCompliance(VALID_INPUT);
    expect(out.clearanceStatus).toBe("CLEARED");
  });

  it("base64-encodes the signed XML in the request body", async () => {
    let received: Record<string, unknown> = {};
    server.use(
      http.post(COMPLIANCE_URL, async ({ request: req }) => {
        received = (await req.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      }),
    );
    await checkInvoiceCompliance(VALID_INPUT);
    expect(received["uuid"]).toBe(VALID_INPUT.egsUuid);
    expect(received["invoiceHash"]).toBe(VALID_INPUT.invoiceHash);
    expect(received["invoice"]).toBe(
      Buffer.from(VALID_INPUT.signedInvoiceXml).toString("base64"),
    );
  });

  it("sets Authorization to HTTP Basic of token:secret", async () => {
    let authHeader = "";
    server.use(
      http.post(COMPLIANCE_URL, ({ request: req }) => {
        authHeader = req.headers.get("Authorization") ?? "";
        return HttpResponse.json({});
      }),
    );
    await checkInvoiceCompliance(VALID_INPUT);
    const expected =
      "Basic " +
      Buffer.from(
        `${VALID_INPUT.binarySecurityToken}:${VALID_INPUT.apiSecret}`,
      ).toString("base64");
    expect(authHeader).toBe(expected);
  });
});

describe("checkInvoiceCompliance — error envelope", () => {
  it("surfaces validation envelope on 400", async () => {
    const envelope = {
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
    };
    server.use(
      http.post(COMPLIANCE_URL, () =>
        HttpResponse.json(envelope, { status: 400 }),
      ),
    );
    try {
      await checkInvoiceCompliance(VALID_INPUT);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      const e = err as ZatcaApiError;
      expect(e.statusCode).toBe(400);
      expect(e.validationResults).toEqual(envelope.validationResults);
    }
  });
});

describe("checkInvoiceCompliance — retry", () => {
  it("retries on 503 and succeeds on third attempt", async () => {
    let calls = 0;
    server.use(
      http.post(COMPLIANCE_URL, () => {
        calls += 1;
        if (calls < 3) return HttpResponse.json({}, { status: 503 });
        return HttpResponse.json({ clearanceStatus: "CLEARED" });
      }),
    );
    const out = await checkInvoiceCompliance(VALID_INPUT);
    expect(out.clearanceStatus).toBe("CLEARED");
    expect(calls).toBe(3);
  });

  it("makes 4 calls then throws on always-503", async () => {
    let calls = 0;
    server.use(
      http.post(COMPLIANCE_URL, () => {
        calls += 1;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    await expect(checkInvoiceCompliance(VALID_INPUT)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(calls).toBe(4);
  });
});

describe("checkInvoiceCompliance — input validation", () => {
  it("throws ZatcaApiError(0) when binarySecurityToken is missing", async () => {
    await expect(
      checkInvoiceCompliance({ ...VALID_INPUT, binarySecurityToken: "" }),
    ).rejects.toBeInstanceOf(ZatcaApiError);
  });

  it("throws ZatcaApiError(0) when apiSecret is missing", async () => {
    await expect(
      checkInvoiceCompliance({ ...VALID_INPUT, apiSecret: "" }),
    ).rejects.toBeInstanceOf(ZatcaApiError);
  });
});
