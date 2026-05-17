/**
 * End-to-end onboarding orchestrator.
 *
 * Wires the Phase 2 crypto primitives (key + CSR generation, OpenSSL
 * probe), the Phase 4 API client (compliance certificate + CSID
 * issuance), and the Phase 6 compliance test runner into a single
 * call that takes a fresh EGS profile + a Fatoora-portal OTP and
 * returns the artifacts the caller must persist.
 *
 * The function does NOT write anything to disk. The caller is
 * responsible for storing `privateKey`, `complianceApiSecret`, and
 * `productionApiSecret` — these are secret material and must never
 * leave their security boundary.
 *
 * Steps:
 *
 * 1. {@link probeOpenssl} — fail fast if the CLI is missing.
 * 2. {@link generateSecp256k1KeyPair} — produce the secp256k1 PEM.
 * 3. {@link generateCSR} — render the ZATCA-compliant CSR.
 * 4. {@link issueComplianceCertificate} — exchange the CSR + OTP for
 *    the compliance certificate + API secret.
 * 5. {@link runComplianceTests} — issue + submit the six required test
 *    invoices. Short-circuits with {@link ZatcaOnboardingError} on any
 *    scenario failure.
 * 6. {@link issueCSIDS} — exchange the compliance credentials for the
 *    production CSID.
 * 7. Return all artifacts.
 *
 * Test injection: the optional `crypto` field lets callers replace
 * the OpenSSL-CLI helpers with deterministic fixtures (used in unit
 * tests so we don't actually shell out). Production callers should
 * leave it undefined and rely on the real implementations.
 */

import type { HttpClientOptions, RetryOptions } from "../api/http-client.js";
import { issueComplianceCertificate } from "../api/issue-compliance-cert.js";
import { issueCSIDS } from "../api/issue-csids.js";
import {
  type ComplianceProgressCallback,
  type ComplianceTestReport,
  runComplianceTests,
} from "../compliance/run-tests.js";
import {
  type CSRGenerationEgsInfo,
  generateCSR as defaultGenerateCSR,
} from "../crypto/generate-csr.js";
import { generateSecp256k1KeyPair as defaultGenerateKeyPair } from "../crypto/generate-keys.js";
import { ensureOpenssl } from "../crypto/openssl-probe.js";
import type { ZatcaEnvironment } from "../types/api.js";
import type { EGSUnitInfo } from "../types/egs.js";
import { ZatcaOnboardingError } from "../types/errors.js";

/**
 * The slice of {@link EGSUnitInfo} the caller must supply at
 * onboarding time. The certificate artifacts are excluded — those are
 * what the onboarding flow produces.
 */
export type OnboardingEgsInfo = Omit<EGSUnitInfo, "certificate">;

/**
 * Inputs to {@link onboard}.
 */
export interface OnboardArgs {
  egsInfo: OnboardingEgsInfo;
  /** 6-digit OTP from the Fatoora portal. */
  otp: string;
  environment: ZatcaEnvironment;
  /** Solution provider name (BSN) embedded in the CSR. */
  solutionName: string;
  /** Optional HTTP overrides applied to every ZATCA API call. */
  httpClientOptions?: Omit<HttpClientOptions, "baseUrl"> & {
    retries?: RetryOptions;
  };
  /**
   * Optional crypto injection — replaces the OpenSSL-CLI helpers with
   * caller-supplied implementations. Used by unit tests so the flow
   * runs without shelling out. Production callers should leave this
   * undefined.
   */
  crypto?: {
    generateKeyPair?: () => Promise<string>;
    generateCSR?: (params: {
      egsInfo: CSRGenerationEgsInfo;
      production: boolean;
      solutionName: string;
    }) => Promise<string>;
    skipOpensslProbe?: boolean;
  };
  /**
   * Optional observation hook fired after each compliance scenario
   * settles (passed or failed). Used by hosts that want to persist
   * per-scenario progress so the operator can poll the lifecycle
   * state even if the onboarding HTTP socket drops mid-run.
   *
   * The callback is observational: exceptions thrown inside it are
   * swallowed by {@link runComplianceTests} and do NOT abort the
   * onboarding flow. The callback may be async; the runner awaits
   * it before issuing the next scenario.
   */
  onProgress?: ComplianceProgressCallback;
}

/**
 * Result returned by {@link onboard}. Treat `privateKey`,
 * `complianceApiSecret`, and `productionApiSecret` as secrets — never
 * log them, never write them to a non-encrypted store.
 */
export interface OnboardingResult {
  /** PEM-encoded secp256k1 private key. **Secret.** */
  privateKey: string;
  /** PEM-encoded Certificate Signing Request. */
  csr: string;
  /** PEM-encoded compliance certificate from ZATCA. */
  complianceCertificate: string;
  /** Base64 raw compliance binary security token. */
  complianceBinarySecurityToken: string;
  /** API secret paired with the compliance certificate. **Secret.** */
  complianceApiSecret: string;
  /** ZATCA `requestID` from the compliance issuance call. */
  complianceRequestId: string;
  /** PEM-encoded production certificate from ZATCA. */
  productionCertificate: string;
  /** Base64 raw production binary security token. */
  productionBinarySecurityToken: string;
  /** API secret paired with the production certificate. **Secret.** */
  productionApiSecret: string;
  /** ZATCA `requestID` from the CSID issuance call. */
  productionRequestId: string;
  /** Full compliance-test report (six scenarios). */
  complianceTestReport: ComplianceTestReport;
}

/**
 * Translates the public camelCase {@link OnboardingEgsInfo} into the
 * snake_case shape the {@link generateCSR} helper expects.
 */
function toCsrEgsInfo(info: OnboardingEgsInfo, privateKey: string): CSRGenerationEgsInfo {
  return {
    custom_id: info.customId,
    model: info.model,
    VAT_name: info.vatName,
    VAT_number: info.vatNumber,
    branch_name: info.branchName,
    branch_industry: info.branchIndustry,
    location: {
      city: info.location.cityName,
      street: info.location.street,
      building: info.location.building,
    },
    private_key: privateKey,
  };
}

/**
 * Builds a transient {@link EGSUnitInfo} that includes the compliance
 * certificate + private key, suitable for handing to the compliance
 * test runner.
 */
function withComplianceCertificate(
  info: OnboardingEgsInfo,
  privateKey: string,
  complianceCertificate: string,
  complianceApiSecret: string,
  _complianceBinarySecurityToken: string,
): EGSUnitInfo {
  return {
    ...info,
    certificate: {
      privateKey,
      complianceCertificate,
      complianceApiSecret,
      // The production fields are not yet known — leave undefined.
    },
    // The base type carries the rest of the runtime metadata used by
    // the issuers (vatNumber, uuid, etc.).
  } as EGSUnitInfo & {
    certificate: {
      privateKey: string;
      complianceCertificate: string;
      complianceApiSecret: string;
      complianceBinarySecurityToken?: string;
    };
  };
  // (The `complianceBinarySecurityToken` is threaded separately to
  // `runComplianceTests` via its `apiCredentials.binarySecurityToken`
  // argument; we accept it here for symmetry but do not store it on
  // the type itself.)
}

/**
 * Runs the full ZATCA onboarding pipeline.
 *
 * @param args - EGS info, 6-digit Fatoora-portal OTP, target
 *               environment (sandbox / simulation only), and the
 *               solution-provider name embedded in the CSR.
 * @returns The full bundle of artifacts the caller must persist —
 *          private key, certificates, API secrets, request ids, and
 *          the compliance-test report.
 * @throws {ZatcaOnboardingError} when OpenSSL is missing, when
 *         `environment` is `"production"`, when the compliance tests
 *         fail, or when any required field is empty.
 * @throws {ZatcaApiError} when ZATCA returns a non-2xx response.
 *
 * @example
 * ```ts
 * const result = await onboard({
 *   egsInfo, // OnboardingEgsInfo
 *   otp: "123456",
 *   environment: "simulation",
 *   solutionName: "MyBilling SaaS v1.0",
 * });
 * await encryptedSecretsStore.put(scopeKey, {
 *   privateKey: result.privateKey,
 *   complianceApiSecret: result.complianceApiSecret,
 *   productionApiSecret: result.productionApiSecret,
 * });
 * ```
 */
export async function onboard(args: OnboardArgs): Promise<OnboardingResult> {
  if (!args.otp) {
    throw new ZatcaOnboardingError("onboard requires a 6-digit OTP.");
  }
  if (!args.solutionName) {
    throw new ZatcaOnboardingError("onboard requires a solutionName (BSN).");
  }
  // The onboarding flow embeds a six-scenario compliance test pack —
  // ZATCA only accepts those against sandbox / simulation. Fail
  // fast so callers don't burn an OTP issuing a compliance
  // certificate they cannot then exercise.
  if (args.environment === "production") {
    throw new ZatcaOnboardingError(
      "onboard cannot run against environment='production' — compliance tests require sandbox or simulation.",
    );
  }

  // Step 1 — probe OpenSSL (skippable in unit tests).
  if (args.crypto?.skipOpensslProbe !== true) {
    try {
      await ensureOpenssl();
    } catch (cause) {
      throw new ZatcaOnboardingError(
        "OpenSSL CLI is required for onboarding but was not found on PATH.",
        cause,
      );
    }
  }

  // Step 2 — generate the secp256k1 keypair.
  const generateKeyPair = args.crypto?.generateKeyPair ?? defaultGenerateKeyPair;
  let privateKey: string;
  try {
    privateKey = await generateKeyPair();
  } catch (cause) {
    throw new ZatcaOnboardingError("Failed to generate the secp256k1 keypair.", cause);
  }

  // Step 3 — generate the CSR bound to the private key. The CSR
  // template differs between the production gateway and the
  // sandbox/simulation gateways; we already short-circuited
  // production above, so `production` is always false here. The
  // boolean is kept explicit to match the CSR helper's contract.
  const generateCsr = args.crypto?.generateCSR ?? defaultGenerateCSR;
  const production = false;
  let csr: string;
  try {
    csr = await generateCsr({
      egsInfo: toCsrEgsInfo(args.egsInfo, privateKey),
      production,
      solutionName: args.solutionName,
    });
  } catch (cause) {
    throw new ZatcaOnboardingError("Failed to generate the CSR.", cause);
  }

  // Step 4 — exchange the CSR + OTP for the compliance certificate.
  const complianceResult = await issueComplianceCertificate({
    csr,
    otp: args.otp,
    environment: args.environment,
    ...(args.httpClientOptions !== undefined ? { httpOptions: args.httpClientOptions } : {}),
  });

  // Step 5 — run the six compliance scenarios. The environment is
  // guaranteed to be `sandbox | simulation` at this point because we
  // short-circuited production above.
  const transientEgs = withComplianceCertificate(
    args.egsInfo,
    privateKey,
    complianceResult.issuedCertificate,
    complianceResult.apiSecret,
    complianceResult.binarySecurityToken,
  );
  const complianceTestReport = await runComplianceTests({
    egsInfo: transientEgs,
    environment: args.environment,
    signing: {
      certificate: complianceResult.issuedCertificate,
      privateKey,
    },
    apiCredentials: {
      binarySecurityToken: complianceResult.binarySecurityToken,
      apiSecret: complianceResult.apiSecret,
    },
    ...(args.httpClientOptions !== undefined ? { httpClientOptions: args.httpClientOptions } : {}),
    ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
  });

  if (complianceTestReport.overallStatus === "failed") {
    const failures = complianceTestReport.results
      .filter((r) => !r.passed)
      .map((r) => `${r.invoiceKind}: ${r.errors.join("; ")}`)
      .join(" | ");
    throw new ZatcaOnboardingError(
      `Compliance tests failed — production CSID not issued. Failures: ${failures}`,
    );
  }

  // Step 6 — exchange compliance credentials for the production CSID.
  const csidsResult = await issueCSIDS({
    complianceRequestId: complianceResult.requestId,
    binarySecurityToken: complianceResult.binarySecurityToken,
    apiSecret: complianceResult.apiSecret,
    environment: args.environment,
    ...(args.httpClientOptions !== undefined ? { httpOptions: args.httpClientOptions } : {}),
  });

  return {
    privateKey,
    csr,
    complianceCertificate: complianceResult.issuedCertificate,
    complianceBinarySecurityToken: complianceResult.binarySecurityToken,
    complianceApiSecret: complianceResult.apiSecret,
    complianceRequestId: complianceResult.requestId,
    productionCertificate: csidsResult.issuedCertificate,
    productionBinarySecurityToken: csidsResult.binarySecurityToken,
    productionApiSecret: csidsResult.apiSecret,
    productionRequestId: csidsResult.requestId,
    complianceTestReport,
  };
}
