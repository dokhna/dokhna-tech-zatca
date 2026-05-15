/**
 * Public surface of the ZATCA API client.
 *
 * Re-exports the six high-level operations (compliance check,
 * clearance / reporting submission, cancel, status, compliance
 * certificate issuance, production CSID issuance), the endpoint
 * matrix, the header builders, and the low-level HTTP client for
 * power users who want to drive the gateway directly.
 */

export {
  type CancelInvoiceParams,
  cancelInvoice,
  type ZatcaCancellationResult,
} from "./cancel-invoice.js";
export {
  type CheckInvoiceStatusParams,
  checkInvoiceStatus,
  type ZatcaInvoiceStatusResult,
} from "./check-status.js";
export {
  isSimplifiedInvoice,
  type SingleInvoiceSubmissionParams,
  type SingleInvoiceSubmissionResult,
  singleInvoiceReportingOrClearanceStatus,
} from "./clearance-reporting.js";

export {
  type CheckInvoiceComplianceParams,
  checkInvoiceCompliance,
} from "./compliance.js";
export {
  getZatcaEndpoints,
  ZATCA_API_VERSION,
  ZATCA_ENDPOINTS,
  type ZatcaEnvironmentEndpoints,
} from "./endpoints.js";
export {
  buildAuthHeaders,
  buildBaseHeaders,
  buildClearanceHeaders,
  buildOtpHeaders,
} from "./headers.js";
export {
  computeBackoffMs,
  type HttpClientOptions,
  type RequestArgs,
  type RetryOptions,
  request,
} from "./http-client.js";

export {
  type IssueComplianceCertificateParams,
  type IssueComplianceCertificateResult,
  issueComplianceCertificate,
} from "./issue-compliance-cert.js";

export {
  type IssueCSIDSParams,
  type IssueCSIDSResult,
  issueCSIDS,
} from "./issue-csids.js";
