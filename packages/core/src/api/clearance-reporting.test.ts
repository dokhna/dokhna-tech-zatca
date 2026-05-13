/**
 * Tests for `singleInvoiceReportingOrClearanceStatus`.
 *
 * Coverage:
 *   - Simplified invoice (`name="0211010"`) is routed to `/reporting/single`.
 *   - Standard invoice (`name="0100000"`) is routed to `/clearance/single`.
 *   - Endpoint marker in the return value mirrors the route taken.
 *   - 4xx surfaces validation envelope on the error.
 *   - 5xx retried.
 *   - Invoice XML without `InvoiceTypeCode` throws ZatcaApiError(0).
 */

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZatcaApiError } from "../types/errors.js";
import {
  isSimplifiedInvoice,
  singleInvoiceReportingOrClearanceStatus,
} from "./clearance-reporting.js";
import { ZATCA_ENDPOINTS } from "./endpoints.js";

const ENV = "sandbox" as const;
const BASE = ZATCA_ENDPOINTS[ENV].base;
const REPORTING_URL = `${BASE}${ZATCA_ENDPOINTS[ENV].reporting}`;
const CLEARANCE_URL = `${BASE}${ZATCA_ENDPOINTS[ENV].clearance}`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const SIMPLIFIED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:InvoiceTypeCode name="0211010">388</cbc:InvoiceTypeCode>
</Invoice>`;

const STANDARD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>
</Invoice>`;

const INPUT_BASE = {
  invoiceHash: "h==",
  egsUuid: "11111111-2222-3333-4444-555555555555",
  binarySecurityToken: "TOK",
  apiSecret: "SEC",
  environment: ENV,
  httpOptions: { retries: { count: 3, baseMs: 5, jitterMs: 0 } },
} as const;

describe("isSimplifiedInvoice", () => {
  it("returns true for `name` starting with 02", () => {
    expect(isSimplifiedInvoice(SIMPLIFIED_XML)).toBe(true);
  });
  it("returns false for `name` starting with 01", () => {
    expect(isSimplifiedInvoice(STANDARD_XML)).toBe(false);
  });
  it("throws when InvoiceTypeCode is missing", () => {
    expect(() => isSimplifiedInvoice("<Invoice/>")).toThrow(ZatcaApiError);
  });
});

describe("singleInvoiceReportingOrClearanceStatus — routing", () => {
  it("routes simplified invoices to /reporting/single", async () => {
    let reportingHits = 0;
    server.use(
      http.post(REPORTING_URL, () => {
        reportingHits += 1;
        return HttpResponse.json({ reportingStatus: "REPORTED" });
      }),
      http.post(CLEARANCE_URL, () => HttpResponse.json({}, { status: 500 })),
    );
    const out = await singleInvoiceReportingOrClearanceStatus({
      ...INPUT_BASE,
      signedInvoiceXml: SIMPLIFIED_XML,
    });
    expect(reportingHits).toBe(1);
    expect(out.endpoint).toBe("reporting");
    expect(out.invoiceType).toBe("simplified");
    expect(out.response.reportingStatus).toBe("REPORTED");
  });

  it("routes standard invoices to /clearance/single", async () => {
    let clearanceHits = 0;
    server.use(
      http.post(CLEARANCE_URL, () => {
        clearanceHits += 1;
        return HttpResponse.json({
          clearanceStatus: "CLEARED",
          clearedInvoice: "BASE64==",
        });
      }),
      http.post(REPORTING_URL, () => HttpResponse.json({}, { status: 500 })),
    );
    const out = await singleInvoiceReportingOrClearanceStatus({
      ...INPUT_BASE,
      signedInvoiceXml: STANDARD_XML,
    });
    expect(clearanceHits).toBe(1);
    expect(out.endpoint).toBe("clearance");
    expect(out.invoiceType).toBe("standard");
    expect(out.response.clearedInvoice).toBe("BASE64==");
  });

  it("sets Clearance-Status: 1 header on clearance calls", async () => {
    let header = "";
    server.use(
      http.post(CLEARANCE_URL, ({ request: req }) => {
        header = req.headers.get("Clearance-Status") ?? "";
        return HttpResponse.json({ clearanceStatus: "CLEARED" });
      }),
    );
    await singleInvoiceReportingOrClearanceStatus({
      ...INPUT_BASE,
      signedInvoiceXml: STANDARD_XML,
    });
    expect(header).toBe("1");
  });
});

describe("singleInvoiceReportingOrClearanceStatus — error paths", () => {
  it("surfaces validation envelope on 400 (clearance)", async () => {
    const envelope = {
      validationResults: {
        errorMessages: [
          { code: "X", message: "bad", category: "ERROR-INVOICE", status: "ERROR" },
        ],
      },
    };
    server.use(
      http.post(CLEARANCE_URL, () =>
        HttpResponse.json(envelope, { status: 400 }),
      ),
    );
    try {
      await singleInvoiceReportingOrClearanceStatus({
        ...INPUT_BASE,
        signedInvoiceXml: STANDARD_XML,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      const e = err as ZatcaApiError;
      expect(e.statusCode).toBe(400);
      expect(e.validationResults).toEqual(envelope.validationResults);
    }
  });

  it("retries on 503 (reporting) and succeeds on third attempt", async () => {
    let calls = 0;
    server.use(
      http.post(REPORTING_URL, () => {
        calls += 1;
        if (calls < 3) return HttpResponse.json({}, { status: 503 });
        return HttpResponse.json({ reportingStatus: "REPORTED" });
      }),
    );
    const out = await singleInvoiceReportingOrClearanceStatus({
      ...INPUT_BASE,
      signedInvoiceXml: SIMPLIFIED_XML,
    });
    expect(calls).toBe(3);
    expect(out.response.reportingStatus).toBe("REPORTED");
  });

  it("makes 4 calls and throws ZatcaApiError(503) on always-503", async () => {
    let calls = 0;
    server.use(
      http.post(CLEARANCE_URL, () => {
        calls += 1;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    await expect(
      singleInvoiceReportingOrClearanceStatus({
        ...INPUT_BASE,
        signedInvoiceXml: STANDARD_XML,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toBe(4);
  });
});
