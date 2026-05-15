/**
 * Tests for `cancelInvoice`.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZatcaApiError } from "../types/errors.js";
import { cancelInvoice } from "./cancel-invoice.js";
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
  reason: "Buyer requested cancellation",
  binarySecurityToken: "TOK",
  apiSecret: "SEC",
  environment: ENV,
  httpOptions: { retries: { count: 3, baseMs: 5, jitterMs: 0 } },
} as const;

describe("cancelInvoice — happy path", () => {
  it("POSTs to /invoices/cancel/{invoiceId} with body", async () => {
    let receivedBody: Record<string, unknown> = {};
    let receivedUrl = "";
    server.use(
      http.post(`${BASE}/invoices/cancel/:id`, async ({ request: req }) => {
        receivedUrl = req.url;
        receivedBody = (await req.json()) as Record<string, unknown>;
        return HttpResponse.json({
          clearanceStatus: "CANCELLED",
          clearanceTimestamp: "2026-05-13T12:00:00Z",
        });
      }),
    );
    const out = await cancelInvoice(INPUT);
    expect(out.clearanceStatus).toBe("CANCELLED");
    expect(receivedUrl).toContain("/invoices/cancel/INV-0001");
    expect(receivedBody).toEqual({
      clearanceNumber: INPUT.clearanceNumber,
      reason: INPUT.reason,
    });
  });
});

describe("cancelInvoice — error paths", () => {
  it("surfaces 400 with validation envelope", async () => {
    const envelope = {
      validationResults: {
        errorMessages: [
          { code: "CNC-1", message: "Invoice not cancellable", category: "ERROR", status: "ERROR" },
        ],
      },
    };
    server.use(
      http.post(`${BASE}/invoices/cancel/:id`, () => HttpResponse.json(envelope, { status: 400 })),
    );
    try {
      await cancelInvoice(INPUT);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      const e = err as ZatcaApiError;
      expect(e.statusCode).toBe(400);
      expect(e.validationResults).toEqual(envelope.validationResults);
    }
  });

  it("retries on 503 and succeeds on third attempt", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/invoices/cancel/:id`, () => {
        calls += 1;
        if (calls < 3) return HttpResponse.json({}, { status: 503 });
        return HttpResponse.json({ clearanceStatus: "CANCELLED" });
      }),
    );
    const out = await cancelInvoice(INPUT);
    expect(out.clearanceStatus).toBe("CANCELLED");
    expect(calls).toBe(3);
  });

  it("makes 4 calls and throws ZatcaApiError(503) on always-503", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/invoices/cancel/:id`, () => {
        calls += 1;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    await expect(cancelInvoice(INPUT)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(calls).toBe(4);
  });

  it("rejects when invoiceId is empty", async () => {
    await expect(cancelInvoice({ ...INPUT, invoiceId: "" })).rejects.toBeInstanceOf(ZatcaApiError);
  });
});
