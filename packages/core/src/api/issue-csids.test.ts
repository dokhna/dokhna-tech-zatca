/**
 * Tests for `issueCSIDS`.
 *
 * Important: confirms that NO mock fallback exists — the legacy
 * helper would return a fake "simulated-prod-…" response on failure;
 * the open-source surface throws instead.
 */

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZatcaApiError } from "../types/errors.js";
import { ZATCA_ENDPOINTS } from "./endpoints.js";
import { issueCSIDS } from "./issue-csids.js";

const ENV = "sandbox" as const;
const URL = `${ZATCA_ENDPOINTS[ENV].base}${ZATCA_ENDPOINTS[ENV].csids}`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const PROD_CERT_BODY = "MIIDXTCCAkWg...PROD";
const PROD_TOKEN_B64 = Buffer.from(PROD_CERT_BODY).toString("base64");

const INPUT = {
  complianceRequestId: "REQ-COMP-1",
  binarySecurityToken: "COMP-TOK",
  apiSecret: "COMP-SEC",
  environment: ENV,
  httpOptions: { retries: { count: 3, baseMs: 5, jitterMs: 0 } },
} as const;

describe("issueCSIDS — happy path", () => {
  it("posts compliance_request_id with Basic auth; decodes prod cert", async () => {
    let authHeader = "";
    let body: Record<string, unknown> = {};
    server.use(
      http.post(URL, async ({ request: req }) => {
        authHeader = req.headers.get("Authorization") ?? "";
        body = (await req.json()) as Record<string, unknown>;
        return HttpResponse.json({
          binarySecurityToken: PROD_TOKEN_B64,
          secret: "PROD-SEC",
          requestID: "REQ-PROD-1",
          dispositionMessage: "Production certificate issued",
        });
      }),
    );
    const out = await issueCSIDS(INPUT);
    const expectedAuth = `Basic ${Buffer.from(
      `${INPUT.binarySecurityToken}:${INPUT.apiSecret}`,
    ).toString("base64")}`;
    expect(authHeader).toBe(expectedAuth);
    expect(body).toEqual({ compliance_request_id: INPUT.complianceRequestId });
    expect(out.binarySecurityToken).toBe(PROD_TOKEN_B64);
    expect(out.issuedCertificate).toBe(PROD_CERT_BODY);
    expect(out.apiSecret).toBe("PROD-SEC");
    expect(out.requestId).toBe("REQ-PROD-1");
  });
});

describe("issueCSIDS — error paths (no mock fallback)", () => {
  it("throws ZatcaApiError on 400 (does NOT return a simulated response)", async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json(
          { validationResults: { errorMessages: [{ code: "X", message: "x", category: "Y" }] } },
          { status: 400 },
        ),
      ),
    );
    const result = issueCSIDS(INPUT);
    await expect(result).rejects.toBeInstanceOf(ZatcaApiError);
    await expect(result).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws on 500 without a `simulated-prod-*` fallback", async () => {
    server.use(http.post(URL, () => HttpResponse.json({ message: "down" }, { status: 500 })));
    try {
      await issueCSIDS({
        ...INPUT,
        httpOptions: { retries: { count: 0, baseMs: 1, jitterMs: 0 } },
      });
      expect.unreachable("should have thrown — no mock fallback exists");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      // Critical: the legacy helper would have returned a fake
      // response containing `simulated-prod-…`. The open-source
      // surface must NEVER do this.
      const e = err as ZatcaApiError;
      const raw = e.rawResponse as Record<string, unknown> | undefined;
      if (raw && typeof raw === "object") {
        const reqId = raw.requestID;
        if (typeof reqId === "string") {
          expect(reqId).not.toMatch(/^simulated-prod-/);
        }
      }
    }
  });

  it("retries on 503 and succeeds on third attempt", async () => {
    let calls = 0;
    server.use(
      http.post(URL, () => {
        calls += 1;
        if (calls < 3) return HttpResponse.json({}, { status: 503 });
        return HttpResponse.json({
          binarySecurityToken: PROD_TOKEN_B64,
          secret: "S",
          requestID: "R",
        });
      }),
    );
    const out = await issueCSIDS(INPUT);
    expect(calls).toBe(3);
    expect(out.requestId).toBe("R");
  });

  it("makes 4 calls and throws on always-503", async () => {
    let calls = 0;
    server.use(
      http.post(URL, () => {
        calls += 1;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    await expect(issueCSIDS(INPUT)).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toBe(4);
  });

  it("rejects when complianceRequestId is missing", async () => {
    await expect(issueCSIDS({ ...INPUT, complianceRequestId: "" })).rejects.toBeInstanceOf(
      ZatcaApiError,
    );
  });

  it("rejects when binarySecurityToken is missing (no dev fallback)", async () => {
    await expect(issueCSIDS({ ...INPUT, binarySecurityToken: "" })).rejects.toBeInstanceOf(
      ZatcaApiError,
    );
  });

  it("rejects when apiSecret is missing (no dev fallback)", async () => {
    await expect(issueCSIDS({ ...INPUT, apiSecret: "" })).rejects.toBeInstanceOf(ZatcaApiError);
  });
});
