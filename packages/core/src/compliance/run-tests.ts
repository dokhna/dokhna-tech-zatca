/**
 * ZATCA compliance test runner.
 *
 * Submits the six required test invoices (one of each Phase 2 kind)
 * through the compliance endpoint and returns a structured report.
 *
 * The runner is decoupled from any specific storage backend: an
 * internal in-memory adapter is used by default so callers can
 * exercise the flow without provisioning a real database. Pass
 * `storage` to use a real adapter (useful for end-to-end rehearsal
 * before going live).
 *
 * Pass criterion (matches rwiqha): a scenario passes iff ZATCA
 * returns no `errorMessages` in `validationResults`. Any non-2xx
 * status surfaces as a `ZatcaApiError` from the underlying client —
 * the runner catches those and records them as `passed: false` with
 * the error message in `errors`.
 */

import type { InvoiceHash } from "../types/branded.js";
import type { EGSUnitInfo } from "../types/egs.js";
import type { InvoiceKind } from "../types/invoice.js";
import type {
  HttpClientOptions,
  RetryOptions,
} from "../api/http-client.js";
import type {
  StorageAdapter,
  TenantScope,
} from "../types/storage.js";
import { ZatcaApiError, ZatcaOnboardingError } from "../types/errors.js";
import type { ZatcaComplianceResult } from "../types/api.js";
import { checkInvoiceCompliance } from "../api/compliance.js";
import { issueSimplifiedTaxInvoice } from "../issue/issue-simplified-invoice.js";
import { issueStandardTaxInvoice } from "../issue/issue-standard-invoice.js";
import { issueSimplifiedCreditNote } from "../issue/issue-simplified-credit-note.js";
import { issueStandardCreditNote } from "../issue/issue-standard-credit-note.js";
import { issueSimplifiedDebitNote } from "../issue/issue-simplified-debit-note.js";
import { issueStandardDebitNote } from "../issue/issue-standard-debit-note.js";
import {
  makeSimplifiedCreditNoteScenario,
  makeSimplifiedDebitNoteScenario,
  makeSimplifiedInvoiceScenario,
  makeStandardCreditNoteScenario,
  makeStandardDebitNoteScenario,
  makeStandardInvoiceScenario,
  type ScenarioDateOverrides,
} from "./test-invoices.js";
import { createInternalMemoryStorage } from "./_internal-memory-storage.js";

/**
 * Compliance-runner inputs.
 *
 * The {@link EGSUnitInfo} **must** carry the compliance certificate +
 * API secret (`egsInfo.certificate.complianceCertificate` /
 * `complianceApiSecret`) — the runner authenticates with those when
 * calling the compliance endpoint.
 */
export interface RunComplianceTestsArgs {
  egsInfo: EGSUnitInfo;
  environment: "sandbox" | "simulation";
  /**
   * Signing keypair used by the Phase 2 issuers. Typically the
   * compliance certificate (binary security token decoded) plus the
   * private key the CSR was generated with.
   */
  signing: { certificate: string; privateKey: string };
  /**
   * Compliance API credentials. The `binarySecurityToken` is the raw
   * base64 string ZATCA returned alongside the compliance certificate
   * (NOT the PEM); `apiSecret` is the paired secret.
   */
  apiCredentials: {
    binarySecurityToken: string;
    apiSecret: string;
  };
  /** Optional bring-your-own storage. Defaults to an internal Map. */
  storage?: StorageAdapter;
  /** Optional tenant scope. Defaults to `(egsInfo.vatNumber, egsInfo.uuid)`. */
  scope?: TenantScope;
  /** Optional HTTP overrides for the compliance client. */
  httpClientOptions?: Omit<HttpClientOptions, "baseUrl"> & {
    retries?: RetryOptions;
  };
  /** Optional issue-date overrides applied to every scenario. */
  dateOverrides?: ScenarioDateOverrides;
}

/** One row of the compliance test report. */
export interface ComplianceTestScenarioResult {
  invoiceKind: InvoiceKind;
  scenarioName: string;
  invoiceNumber: string;
  invoiceHash: InvoiceHash;
  submittedAt: Date;
  response: ZatcaComplianceResult | null;
  passed: boolean;
  errors: ReadonlyArray<string>;
}

/** Full compliance test report. */
export interface ComplianceTestReport {
  overallStatus: "passed" | "failed";
  results: ReadonlyArray<ComplianceTestScenarioResult>;
  finalInvoiceHash: InvoiceHash;
}

/**
 * Evaluate ZATCA's response against the pass criterion.
 *
 * Per rwiqha + the ZATCA spec, a compliance call passes iff the
 * response carries no `errorMessages`. Warnings are surfaced but do
 * not flip the pass flag.
 */
function classifyResponse(response: ZatcaComplianceResult): {
  passed: boolean;
  errors: ReadonlyArray<string>;
} {
  const errs = response.validationResults?.errorMessages ?? [];
  const errors = errs.map((e) => `${e.code}: ${e.message}`);
  return { passed: errors.length === 0, errors };
}

/**
 * Best-effort error message extraction without leaking secret
 * material. We surface the message + status code only.
 */
function describeError(err: unknown): string {
  if (err instanceof ZatcaApiError) {
    return `ZatcaApiError (status ${err.statusCode}): ${err.message}`;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return "Unknown error";
}

/**
 * Runs the six required compliance test scenarios in order.
 *
 * Returns a {@link ComplianceTestReport}. The function does NOT throw
 * on individual scenario failures — they are recorded with
 * `passed: false`. The function only throws on irrecoverable setup
 * errors (e.g. missing compliance credentials on `egsInfo`) wrapped in
 * {@link ZatcaOnboardingError}.
 */
export async function runComplianceTests(
  args: RunComplianceTestsArgs,
): Promise<ComplianceTestReport> {
  if (!args.signing.certificate || !args.signing.privateKey) {
    throw new ZatcaOnboardingError(
      "runComplianceTests requires `signing.certificate` + `signing.privateKey`.",
    );
  }
  if (
    !args.apiCredentials.binarySecurityToken ||
    !args.apiCredentials.apiSecret
  ) {
    throw new ZatcaOnboardingError(
      "runComplianceTests requires `apiCredentials.binarySecurityToken` + `apiCredentials.apiSecret`.",
    );
  }

  const scope: TenantScope = args.scope ?? {
    vatNumber: args.egsInfo.vatNumber,
    egsUuid: args.egsInfo.uuid,
  };
  const storage: StorageAdapter =
    args.storage ?? createInternalMemoryStorage();

  const submitOptions = {
    egsUuid: args.egsInfo.uuid,
    binarySecurityToken: args.apiCredentials.binarySecurityToken,
    apiSecret: args.apiCredentials.apiSecret,
    environment: args.environment,
    ...(args.httpClientOptions !== undefined
      ? { httpOptions: args.httpClientOptions }
      : {}),
  } as const;

  const results: ComplianceTestScenarioResult[] = [];
  let lastInvoiceHash: InvoiceHash | null = null;

  // Scenario 1 — simplified tax invoice
  {
    const scenarioName = "simplified-tax-invoice";
    const submittedAt = new Date();
    try {
      const issued = await issueSimplifiedTaxInvoice({
        input: makeSimplifiedInvoiceScenario(args.dateOverrides),
        egsInfo: args.egsInfo,
        storage,
        scope,
        signing: args.signing,
      });
      lastInvoiceHash = issued.invoiceHash;
      const response = await checkInvoiceCompliance({
        signedInvoiceXml: issued.signedXml,
        invoiceHash: issued.invoiceHash,
        ...submitOptions,
      });
      const { passed, errors } = classifyResponse(response);
      results.push({
        invoiceKind: "simplified-tax-invoice",
        scenarioName,
        invoiceNumber: issued.invoiceNumber,
        invoiceHash: issued.invoiceHash,
        submittedAt,
        response,
        passed,
        errors,
      });
    } catch (err) {
      results.push({
        invoiceKind: "simplified-tax-invoice",
        scenarioName,
        invoiceNumber: "",
        invoiceHash: "" as InvoiceHash,
        submittedAt,
        response: null,
        passed: false,
        errors: [describeError(err)],
      });
    }
  }

  // Scenario 2 — standard tax invoice
  {
    const scenarioName = "standard-tax-invoice";
    const submittedAt = new Date();
    try {
      const issued = await issueStandardTaxInvoice({
        input: makeStandardInvoiceScenario(args.dateOverrides),
        egsInfo: args.egsInfo,
        storage,
        scope,
        signing: args.signing,
      });
      lastInvoiceHash = issued.invoiceHash;
      const response = await checkInvoiceCompliance({
        signedInvoiceXml: issued.signedXml,
        invoiceHash: issued.invoiceHash,
        ...submitOptions,
      });
      const { passed, errors } = classifyResponse(response);
      results.push({
        invoiceKind: "standard-tax-invoice",
        scenarioName,
        invoiceNumber: issued.invoiceNumber,
        invoiceHash: issued.invoiceHash,
        submittedAt,
        response,
        passed,
        errors,
      });
    } catch (err) {
      results.push({
        invoiceKind: "standard-tax-invoice",
        scenarioName,
        invoiceNumber: "",
        invoiceHash: "" as InvoiceHash,
        submittedAt,
        response: null,
        passed: false,
        errors: [describeError(err)],
      });
    }
  }

  // Scenario 3 — simplified credit note
  {
    const scenarioName = "simplified-credit-note";
    const submittedAt = new Date();
    try {
      const issued = await issueSimplifiedCreditNote({
        input: makeSimplifiedCreditNoteScenario(args.dateOverrides),
        egsInfo: args.egsInfo,
        storage,
        scope,
        signing: args.signing,
      });
      lastInvoiceHash = issued.invoiceHash;
      const response = await checkInvoiceCompliance({
        signedInvoiceXml: issued.signedXml,
        invoiceHash: issued.invoiceHash,
        ...submitOptions,
      });
      const { passed, errors } = classifyResponse(response);
      results.push({
        invoiceKind: "simplified-credit-note",
        scenarioName,
        invoiceNumber: issued.invoiceNumber,
        invoiceHash: issued.invoiceHash,
        submittedAt,
        response,
        passed,
        errors,
      });
    } catch (err) {
      results.push({
        invoiceKind: "simplified-credit-note",
        scenarioName,
        invoiceNumber: "",
        invoiceHash: "" as InvoiceHash,
        submittedAt,
        response: null,
        passed: false,
        errors: [describeError(err)],
      });
    }
  }

  // Scenario 4 — standard credit note
  {
    const scenarioName = "standard-credit-note";
    const submittedAt = new Date();
    try {
      const issued = await issueStandardCreditNote({
        input: makeStandardCreditNoteScenario(args.dateOverrides),
        egsInfo: args.egsInfo,
        storage,
        scope,
        signing: args.signing,
      });
      lastInvoiceHash = issued.invoiceHash;
      const response = await checkInvoiceCompliance({
        signedInvoiceXml: issued.signedXml,
        invoiceHash: issued.invoiceHash,
        ...submitOptions,
      });
      const { passed, errors } = classifyResponse(response);
      results.push({
        invoiceKind: "standard-credit-note",
        scenarioName,
        invoiceNumber: issued.invoiceNumber,
        invoiceHash: issued.invoiceHash,
        submittedAt,
        response,
        passed,
        errors,
      });
    } catch (err) {
      results.push({
        invoiceKind: "standard-credit-note",
        scenarioName,
        invoiceNumber: "",
        invoiceHash: "" as InvoiceHash,
        submittedAt,
        response: null,
        passed: false,
        errors: [describeError(err)],
      });
    }
  }

  // Scenario 5 — simplified debit note
  {
    const scenarioName = "simplified-debit-note";
    const submittedAt = new Date();
    try {
      const issued = await issueSimplifiedDebitNote({
        input: makeSimplifiedDebitNoteScenario(args.dateOverrides),
        egsInfo: args.egsInfo,
        storage,
        scope,
        signing: args.signing,
      });
      lastInvoiceHash = issued.invoiceHash;
      const response = await checkInvoiceCompliance({
        signedInvoiceXml: issued.signedXml,
        invoiceHash: issued.invoiceHash,
        ...submitOptions,
      });
      const { passed, errors } = classifyResponse(response);
      results.push({
        invoiceKind: "simplified-debit-note",
        scenarioName,
        invoiceNumber: issued.invoiceNumber,
        invoiceHash: issued.invoiceHash,
        submittedAt,
        response,
        passed,
        errors,
      });
    } catch (err) {
      results.push({
        invoiceKind: "simplified-debit-note",
        scenarioName,
        invoiceNumber: "",
        invoiceHash: "" as InvoiceHash,
        submittedAt,
        response: null,
        passed: false,
        errors: [describeError(err)],
      });
    }
  }

  // Scenario 6 — standard debit note
  {
    const scenarioName = "standard-debit-note";
    const submittedAt = new Date();
    try {
      const issued = await issueStandardDebitNote({
        input: makeStandardDebitNoteScenario(args.dateOverrides),
        egsInfo: args.egsInfo,
        storage,
        scope,
        signing: args.signing,
      });
      lastInvoiceHash = issued.invoiceHash;
      const response = await checkInvoiceCompliance({
        signedInvoiceXml: issued.signedXml,
        invoiceHash: issued.invoiceHash,
        ...submitOptions,
      });
      const { passed, errors } = classifyResponse(response);
      results.push({
        invoiceKind: "standard-debit-note",
        scenarioName,
        invoiceNumber: issued.invoiceNumber,
        invoiceHash: issued.invoiceHash,
        submittedAt,
        response,
        passed,
        errors,
      });
    } catch (err) {
      results.push({
        invoiceKind: "standard-debit-note",
        scenarioName,
        invoiceNumber: "",
        invoiceHash: "" as InvoiceHash,
        submittedAt,
        response: null,
        passed: false,
        errors: [describeError(err)],
      });
    }
  }

  const overallStatus = results.every((r) => r.passed) ? "passed" : "failed";
  return {
    overallStatus,
    results,
    finalInvoiceHash: lastInvoiceHash ?? ("" as InvoiceHash),
  };
}
