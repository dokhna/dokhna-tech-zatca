/**
 * Tests for `checkInvoiceStatus`.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZatcaApiError } from "../types/errors.js";
import { checkInvoiceStatus } from "./check-status.js";
import { ZATCA_ENDPOINTS } from "./endpoints.js";

const ENV = "production" as const;
const BASE = ZATCA_ENDPOINTS[ENV].base;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const INPUT = {
  invoiceId: "INV-0001",
  clearanceNumber: "CLR-9999",
  binarySecurityToken: "TOK",
  apiSecret: "SEC",
  environment: ENV,
  httpOptions: { retries: { count: 3, baseMs: 5, jitterMs: 0 } },
} as const;

describe("checkInvoiceStatus — happy path", () => {
  it("GETs /invoices/status/{invoiceId}?clearanceNumber=...", async () => {
    let receivedUrl = "";
    server.use(
      http.get(`${BASE}/invoices/status/:id`, ({ request: req }) => {
        receivedUrl = req.url;
        return HttpResponse.json({
          clearanceStatus: "CLEARED",
          clearanceNumber: INPUT.clearanceNumber,
        });
      }),
    );
    const out = await checkInvoiceStatus(INPUT);
    expect(out.clearanceStatus).toBe("CLEARED");
    expect(receivedUrl).toContain("/invoices/status/INV-0001");
    expect(receivedUrl).toContain("clearanceNumber=CLR-9999");
  });
});

describe("checkInvoiceStatus — error paths", () => {
  it("surfaces 404 with body content", async () => {
    server.use(
      http.get(`${BASE}/invoices/status/:id`, () =>
        HttpResponse.json({ message: "not found" }, { status: 404 }),
      ),
    );
    try {
      await checkInvoiceStatus(INPUT);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      expect((err as ZatcaApiError).statusCode).toBe(404);
    }
  });

  it("retries on 503 and succeeds on third attempt", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/invoices/status/:id`, () => {
        calls += 1;
        if (calls < 3) return HttpResponse.json({}, { status: 503 });
        return HttpResponse.json({ clearanceStatus: "PENDING" });
      }),
    );
    const out = await checkInvoiceStatus(INPUT);
    expect(out.clearanceStatus).toBe("PENDING");
    expect(calls).toBe(3);
  });

  it("makes 4 calls and throws ZatcaApiError(503) on always-503", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/invoices/status/:id`, () => {
        calls += 1;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    await expect(checkInvoiceStatus(INPUT)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(calls).toBe(4);
  });
});
