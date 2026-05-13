/**
 * ZATCA HTTP API response shapes.
 *
 * Phase 4 will implement the actual client; this file locks the public
 * return surface so Phase 3 builders and Phase 6 orchestration code
 * can be written against stable types.
 */

/**
 * Validation message returned in the ZATCA API envelope.
 *
 * - `code`     — ZATCA-defined message code (e.g. `BR-KSA-01`).
 * - `message`  — human-readable description.
 * - `category` — message category (`INFO`, `WARNING`, `ERROR`,
 *                `ERROR-INVOICE`, etc.; ZATCA does not publish a fully
 *                closed list, so this stays a free string).
 * - `status`   — optional severity flag returned on some endpoints
 *                (`PASS`, `WARNING`, `ERROR`).
 */
export interface ZatcaValidationMessage {
  code: string;
  message: string;
  category: string;
  status?: string;
}

/**
 * ZATCA validation envelope (`validationResults` payload field).
 */
export interface ZatcaValidationResults {
  infoMessages?: ReadonlyArray<ZatcaValidationMessage>;
  warningMessages?: ReadonlyArray<ZatcaValidationMessage>;
  errorMessages?: ReadonlyArray<ZatcaValidationMessage>;
  status?: string;
}

/**
 * Body returned by the ZATCA compliance-check endpoint.
 *
 * The compliance API replies with `validationResults`; clearance /
 * reporting may also set `reportingStatus` / `clearanceStatus`. The
 * union covers both shapes — Phase 4 will further refine.
 */
export interface ZatcaComplianceResult {
  validationResults?: ZatcaValidationResults;
  reportingStatus?: string;
  clearanceStatus?: string;
  qrSellerStatus?: string;
  qrBuyerStatus?: string;
  success?: boolean;
}

/**
 * Body returned by the ZATCA single-invoice clearance / reporting
 * endpoint. Standard invoices are *cleared* (response carries a signed
 * cleared XML); simplified invoices are *reported* (validation only).
 *
 * - `clearedInvoice` — base64 signed invoice returned by clearance.
 *                       Absent on reporting (simplified) responses.
 * - `clearanceStatus` — `CLEARED` / `NOT_CLEARED` on clearance.
 * - `reportingStatus` — `REPORTED` / `NOT_REPORTED` on reporting.
 */
export interface ZatcaClearanceResult {
  clearedInvoice?: string;
  clearanceStatus?: string;
  reportingStatus?: string;
  validationResults?: ZatcaValidationResults;
}

/**
 * Generic discriminated-union result for ZATCA API calls.
 *
 * Phase 4's client uses this where users want to opt out of throwing
 * on validation-only failures (e.g. inside the compliance-test
 * runner).
 */
export type ZatcaApiResponse<T> =
  | { ok: true; data: T; requestId?: string }
  | {
      ok: false;
      error: {
        statusCode: number;
        message: string;
        validationResults?: ZatcaValidationResults;
        requestId?: string;
        rawResponse?: unknown;
      };
    };

/**
 * The three ZATCA environments the package will target. Sandbox and
 * simulation are for onboarding / compliance testing; production is
 * live invoicing.
 */
export const ZATCA_ENVIRONMENTS = {
  SANDBOX: "sandbox",
  SIMULATION: "simulation",
  PRODUCTION: "production",
} as const;

/** Literal union of supported ZATCA environment names. */
export type ZatcaEnvironment =
  (typeof ZATCA_ENVIRONMENTS)[keyof typeof ZATCA_ENVIRONMENTS];
