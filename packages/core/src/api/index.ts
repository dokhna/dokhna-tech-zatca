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
  ZATCA_ENDPOINTS,
  ZATCA_API_VERSION,
  getZatcaEndpoints,
  type ZatcaEnvironmentEndpoints,
} from "./endpoints.js";

export {
  buildAuthHeaders,
  buildBaseHeaders,
  buildClearanceHeaders,
  buildOtpHeaders,
} from "./headers.js";

export {
  request,
  computeBackoffMs,
  type HttpClientOptions,
  type RequestArgs,
  type RetryOptions,
} from "./http-client.js";

export {
  checkInvoiceCompliance,
  type CheckInvoiceComplianceParams,
} from "./compliance.js";

export {
  singleInvoiceReportingOrClearanceStatus,
  isSimplifiedInvoice,
  type SingleInvoiceSubmissionParams,
  type SingleInvoiceSubmissionResult,
} from "./clearance-reporting.js";

export {
  cancelInvoice,
  type CancelInvoiceParams,
  type ZatcaCancellationResult,
} from "./cancel-invoice.js";

export {
  checkInvoiceStatus,
  type CheckInvoiceStatusParams,
  type ZatcaInvoiceStatusResult,
} from "./check-status.js";

export {
  issueComplianceCertificate,
  type IssueComplianceCertificateParams,
  type IssueComplianceCertificateResult,
} from "./issue-compliance-cert.js";

export {
  issueCSIDS,
  type IssueCSIDSParams,
  type IssueCSIDSResult,
} from "./issue-csids.js";
