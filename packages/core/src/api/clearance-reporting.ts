/**
 * ZATCA single-invoice clearance / reporting endpoint client.
 *
 * Routes the submission to the right ZATCA endpoint based on the
 * invoice type code embedded in the signed XML:
 *
 *   - Standard invoices (`name` attribute starts with `01`) →
 *     `/invoices/clearance/single` — the gateway returns a signed
 *     cleared invoice in the response body.
 *   - Simplified invoices (`name` attribute starts with `02`) →
 *     `/invoices/reporting/single` — the gateway validates and
 *     records the invoice; no cleared XML is returned.
 *
 * Differences vs. rwiqha:
 *   - Routing decision is made by reading the XML once (no second
 *     parse pass).
 *   - Errors throw `ZatcaApiError` (with `validationResults`); no
 *     diagnostic logging on the failure path, no `Error` wrapping.
 *   - HTTP via the new client.
 */

import type { ZatcaClearanceResult, ZatcaEnvironment } from "../types/api.js";
import { ZatcaApiError } from "../types/errors.js";
import { XMLDocument } from "../xml/document.js";
import { getZatcaEndpoints } from "./endpoints.js";
import { buildClearanceHeaders } from "./headers.js";
import { type HttpClientOptions, type RetryOptions, request } from "./http-client.js";

/**
 * Inputs to {@link singleInvoiceReportingOrClearanceStatus}.
 */
export interface SingleInvoiceSubmissionParams {
  /** Signed UBL invoice XML (full document, not base64). */
  readonly signedInvoiceXml: string;
  /** Canonical SHA-256 of the invoice document (base64). */
  readonly invoiceHash: string;
  /** EGS UUID — must match the `<cbc:UUID>` inside the invoice. */
  readonly egsUuid: string;
  /** Production CSID (base64 PEM body, no headers). */
  readonly binarySecurityToken: string;
  /** API secret returned alongside the production CSID. */
  readonly apiSecret: string;
  /** Target environment. */
  readonly environment: ZatcaEnvironment;
  /** Optional HTTP overrides. */
  readonly httpOptions?: Omit<HttpClientOptions, "baseUrl"> & {
    readonly retries?: RetryOptions;
  };
}

/**
 * Outcome describing which endpoint was hit and the parsed body.
 *
 * `endpoint` is useful for callers that route on the actual ZATCA
 * action taken (`reporting` for simplified, `clearance` for standard).
 */
export interface SingleInvoiceSubmissionResult {
  readonly endpoint: "reporting" | "clearance";
  readonly invoiceType: "simplified" | "standard";
  readonly response: ZatcaClearanceResult;
}

interface SubmissionRequestBody {
  readonly invoiceHash: string;
  readonly uuid: string;
  readonly invoice: string;
}

/**
 * Inspect the signed XML and decide which submission endpoint applies.
 *
 * ZATCA's `InvoiceTypeCode` element carries a `name` attribute whose
 * leading two digits encode the invoice category (`01` = standard,
 * `02` = simplified). Throws if the element or attribute is missing.
 */
export function isSimplifiedInvoice(invoiceXml: string): boolean {
  const doc = new XMLDocument(invoiceXml);
  const elements = doc.get("Invoice/cbc:InvoiceTypeCode");
  if (!elements || elements.length === 0) {
    throw new ZatcaApiError(
      "Cannot determine invoice type: `InvoiceTypeCode` element missing from signed XML",
      0,
    );
  }
  const first = elements[0] as Record<string, unknown> | undefined;
  if (!first) {
    throw new ZatcaApiError(
      "Cannot determine invoice type: `InvoiceTypeCode` element missing from signed XML",
      0,
    );
  }
  const nameAttr = first["@_name"];
  if (typeof nameAttr !== "string") {
    throw new ZatcaApiError(
      "Cannot determine invoice type: `InvoiceTypeCode/@name` attribute missing",
      0,
    );
  }
  return nameAttr.startsWith("02");
}

/**
 * Submit a signed invoice to ZATCA's single-invoice flow. Standard
 * invoices go to clearance; simplified invoices go to reporting.
 *
 * Returns both the endpoint that was used and the parsed body, so the
 * caller can react to the specific status field
 * (`clearanceStatus` vs `reportingStatus`).
 */
export async function singleInvoiceReportingOrClearanceStatus(
  params: SingleInvoiceSubmissionParams,
): Promise<SingleInvoiceSubmissionResult> {
  if (!params.signedInvoiceXml) {
    throw new ZatcaApiError("signedInvoiceXml is required for invoice submission", 0);
  }
  if (!params.invoiceHash) {
    throw new ZatcaApiError("invoiceHash is required for invoice submission", 0);
  }
  if (!params.egsUuid) {
    throw new ZatcaApiError("egsUuid is required for invoice submission", 0);
  }
  if (!params.binarySecurityToken) {
    throw new ZatcaApiError("binarySecurityToken is required for invoice submission", 0);
  }
  if (!params.apiSecret) {
    throw new ZatcaApiError("apiSecret is required for invoice submission", 0);
  }

  const simplified = isSimplifiedInvoice(params.signedInvoiceXml);
  const endpoints = getZatcaEndpoints(params.environment);
  const path = simplified ? endpoints.reporting : endpoints.clearance;
  const clientOptions: HttpClientOptions = {
    baseUrl: endpoints.base,
    ...(params.httpOptions ?? {}),
  };
  const headers = buildClearanceHeaders(params.binarySecurityToken, params.apiSecret);
  const body: SubmissionRequestBody = {
    invoiceHash: params.invoiceHash,
    uuid: params.egsUuid,
    invoice: Buffer.from(params.signedInvoiceXml).toString("base64"),
  };

  const response = await request<ZatcaClearanceResult, SubmissionRequestBody>(clientOptions, {
    method: "POST",
    path,
    headers,
    body,
  });

  return {
    endpoint: simplified ? "reporting" : "clearance",
    invoiceType: simplified ? "simplified" : "standard",
    response,
  };
}
