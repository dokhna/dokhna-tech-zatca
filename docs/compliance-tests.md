# Compliance tests

ZATCA requires every newly onboarded EGS to round-trip **six compliance test invoices** through the compliance gateway before a production CSID is issued. The library ships the test pack and a runner.

## When this runs

- `onboard()` runs the six scenarios automatically as step 4. If any fail, the production CSID is not issued and `ZatcaOnboardingError` is thrown.
- `runComplianceTests()` can be invoked directly for rehearsal, regression testing, or to re-run after fixing an EGS misconfiguration that caused an initial failure.

## Direct invocation

```ts
import { runComplianceTests, type EGSUnitInfo } from "@dokhna-tech/zatca";

const report = await runComplianceTests({
  egsInfo: egsInfoWithComplianceCertificate, // egsInfo.certificate must be populated
  environment: "simulation", // sandbox | simulation
  signing: {
    certificate: complianceCertificate,
    privateKey,
  },
  apiCredentials: {
    binarySecurityToken: complianceBinarySecurityToken,
    apiSecret: complianceApiSecret,
  },
});

if (report.overallStatus === "failed") {
  for (const r of report.results) {
    if (!r.passed) console.error(r.scenarioName, r.errors);
  }
}
```

## The six scenarios

| # | Scenario | Function |
|---|----------|----------|
| 1 | Simplified tax invoice (B2C) | `makeSimplifiedInvoiceScenario` |
| 2 | Standard tax invoice (B2B) | `makeStandardInvoiceScenario` |
| 3 | Simplified credit note | `makeSimplifiedCreditNoteScenario` |
| 4 | Standard credit note | `makeStandardCreditNoteScenario` |
| 5 | Simplified debit note | `makeSimplifiedDebitNoteScenario` |
| 6 | Standard debit note | `makeStandardDebitNoteScenario` |

Each `make*Scenario(overrides?)` function returns a fully populated `InvoiceInput` minus the `egsInfo`, counter, serial, and previous-hash fields (which the issuer injects). You may override `issueDate` / `issueTime` via the optional argument; the rest is fixed and matches ZATCA's published compliance test data.

## The scenarios are hardcoded

The bodies of the six test invoices live in `packages/core/src/compliance/test-invoices.ts` and are bundled with the package. If ZATCA updates the compliance specification, the test invoices update with a new package release — it is **not** a configuration knob. Pin the package version in your CI and treat compliance-spec changes as a planned package upgrade.

If you have an emergency need to override a scenario (e.g. ZATCA quietly changed the rules and you need to issue invoices before the next release), call the lower-level issuer + `checkInvoiceCompliance` directly and pass your own input. The `runComplianceTests` function is the convenience wrapper, not the floor.

## Interpreting the report

```ts
interface ComplianceTestReport {
  overallStatus: "passed" | "failed";
  results: ReadonlyArray<{
    invoiceKind: InvoiceKind;
    scenarioName: string;
    invoiceNumber: string;
    invoiceHash: InvoiceHash;
    submittedAt: Date;
    response: ZatcaComplianceResult | null;
    passed: boolean;
    errors: ReadonlyArray<string>;
  }>;
  finalInvoiceHash: InvoiceHash;
}
```

- `overallStatus === "passed"` iff every scenario's ZATCA response carries no `errorMessages`.
- Warnings are surfaced in `response.validationResults.warningMessages` but do not flip the pass flag.
- Network errors (a `ZatcaApiError` from the underlying HTTP client) are recorded as `passed: false` with `response: null` — the runner does not throw.

## What "passed" actually means

A scenario passes iff ZATCA's compliance gateway returns no `errorMessages`. That is identical to the pass criterion in the production helper we extracted this library from, and matches the ZATCA published spec.

A `WARNING` ZATCA returns (e.g. a future deprecation notice) does NOT fail the scenario. Inspect `report.results[i].response.validationResults.warningMessages` if you want to surface them to humans.

## Storage during the run

By default, the compliance runner uses an internal sequential in-memory storage so it does not write to your production storage adapter. To exercise an end-to-end rehearsal against your real adapter — e.g. to catch hash-chain or counter races — pass `storage`:

```ts
await runComplianceTests({
  /* ... */
  storage: realProductionAdapter,
  scope: { vatNumber: testVat, egsUuid: testEgs },
});
```

When you do this, the six compliance invoices land in your real database. Use a throwaway tenant / scope for the run.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `BR-KSA-02` on scenarios 1, 3, 5 | Buyer name missing on simplified — the scenarios already populate this, so this means a custom override is wrong. |
| `BR-KSA-09` | VAT amount on line does not match `quantity × price × rate`. The scenarios are pre-rounded; check your overrides. |
| All six fail with `ZatcaApiError (status 401)` | `apiCredentials` is wrong — usually the BST was decoded into a PEM by accident. Pass the raw base64 string. |
| All six fail with `ZatcaApiError (status 404)` | Wrong `environment` or sandbox URL drift (see [troubleshooting.md](./troubleshooting.md#urls-and-auth-scheme-drift-caveat)). |
