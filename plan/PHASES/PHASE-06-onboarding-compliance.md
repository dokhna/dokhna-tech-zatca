# Phase 6 — Onboarding, Compliance Tests, Cert Management

**Status:** pending
**Agent:** backend-developer
**Estimated effort:** 2 sessions

## Goal

Wire together the work of Phases 2 (crypto), 3 (builders), 4 (API), and 5 (storage) into the three end-to-end flows users need:

1. **Onboarding** a new EGS unit (generate key + CSR → request compliance cert → run compliance tests → request production CSID).
2. **Compliance test runner** — generates and submits all six invoice types against ZATCA sandbox.
3. **Certificate management** — verify, check validity, get expiration date.

## Source files to read first

- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.generate.csr.simplified.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.run.compliance.tests.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.verify.certificate.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.is.certificate.valid.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.get.certificate.expiration.date.function.ts`

## Files to create

```
packages/core/src/onboarding/
├── index.ts
├── onboard.ts                  # Top-level onboarding orchestrator
├── *.test.ts

packages/core/src/compliance/
├── index.ts
├── run-tests.ts                # Compliance test runner
├── test-invoices.ts            # Hardcoded ZATCA-spec test invoice inputs (the 6 required scenarios)
├── *.test.ts

packages/core/src/certificates/
├── index.ts
├── verify.ts
├── validity.ts
├── expiration.ts
└── *.test.ts
```

## Onboarding orchestrator shape

```ts
export async function onboard(args: {
  egsInfo: Omit<EGSUnitInfo, "compliance_certificate" | "compliance_api_secret" | "production_certificate" | "production_api_secret">;
  otp: string;               // 6-digit OTP from ZATCA portal
  environment: "sandbox" | "simulation" | "production";
  solutionName: string;
}): Promise<OnboardingResult> {
  // 1. probeOpenssl() — fail fast if missing
  // 2. generateSecp256k1KeyPair() → privateKey PEM
  // 3. generateCSR({ egsInfo, privateKey, environment, solutionName }) → csr PEM
  // 4. issueComplianceCertificate({ csr, otp, environment }) → { compliance_certificate, compliance_api_secret, requestId, binarySecurityToken }
  // 5. runComplianceTests({ egsInfo: <egs + complianceCert>, environment }) → must pass all 6
  // 6. issueCSIDS({ complianceRequestId: requestId, environment }) → { production_certificate, production_api_secret, productionRequestId }
  // 7. return { privateKey, csr, complianceCertificate, complianceApiSecret, productionCertificate, productionApiSecret, requestIds }
}

export type OnboardingResult = {
  privateKey: string;          // PEM, secp256k1
  csr: string;                 // PEM
  complianceCertificate: string; // PEM
  complianceApiSecret: string;
  complianceRequestId: string;
  productionCertificate: string;
  productionApiSecret: string;
  productionRequestId: string;
};
```

Users persist the result themselves — the package does NOT write secrets to disk.

## Compliance test runner shape

```ts
export async function runComplianceTests(args: {
  egsInfo: EGSUnitInfo;            // includes compliance_certificate + secret
  environment: "sandbox" | "simulation";
  storage?: StorageAdapter;        // optional — uses storage-memory if absent
}): Promise<ComplianceTestReport> {
  // For each of the 6 required test invoices:
  //   1. Build via the appropriate Phase 3 issuer
  //   2. Submit via checkInvoiceCompliance (Phase 4)
  //   3. Collect result: pass / fail / warnings
  // Return aggregated report
}

export type ComplianceTestReport = {
  overallStatus: "passed" | "failed";
  results: Array<{
    invoiceKind: InvoiceKind;
    invoiceNumber: string;
    invoiceHash: InvoiceHash;
    submittedAt: Date;
    response: ZatcaComplianceResult;
    passed: boolean;
  }>;
  finalInvoiceHash: InvoiceHash;
};
```

Use the storage-memory adapter by default so users can run compliance tests without setting up a real DB. Document the option to use a real adapter for end-to-end rehearsal.

## Certificate management

```ts
export function verifyCertificate(params: { certificate: string; privateKey?: string }): { isValid: boolean; serialNumber: string; subject: string; issuer: string; validFrom: Date; validTo: Date; publicKeyMatchesPrivateKey: boolean | null };
export function isCertificateValid(certificate: string): boolean; // checks notBefore <= now <= notAfter
export function getCertificateExpirationDate(certificate: string): Date;
```

All three: pure, synchronous, no I/O.

## Exit tests

1. `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test` pass.
2. Unit tests for each certificate helper using a fixture PEM.
3. Mocked-API integration test for `onboard`: msw mocks the compliance + CSID endpoints; assert orchestration order.
4. Mocked-API integration test for `runComplianceTests`: msw returns 6 staged responses; assert correct invoice types submitted in order.
5. Optional: live sandbox test gated by `ZATCA_LIVE_TEST=1` env var.

## What this phase does NOT do

- No docs — Phase 7.
- No PDF generation — out of scope.
- No examples — Phase 7.
- No release prep — Phase 8.
