# API reference

The full API reference is generated from TypeScript's source via [TypeDoc](https://typedoc.org). It lives at:

- **HTML**: [`./typedoc/index.html`](./typedoc/index.html) (open in your browser after running `pnpm docs:api`).
- **Source of truth**: [`packages/core/src/index.ts`](../packages/core/src/index.ts).

## Regenerating

From the repo root:

```bash
pnpm docs:api
```

The output goes into `docs/typedoc/`. The CI publishes it to GitHub Pages on each release.

## What's documented

Every public export of `@dokhna-tach/zatca` has:

- A one-line summary.
- `@param` for each parameter.
- `@returns` description.
- `@throws` for documented error classes.
- `@example` for non-trivial APIs.

The storage adapter packages (`@dokhna-tach/zatca-storage-{memory,mongo,postgres}`) are not (yet) part of the TypeDoc generation — their public surface is small and covered in [storage-adapters.md](./storage-adapters.md). To include them, add their `src/index.ts` to `typedoc.json`'s `entryPoints` array.

## Quick index of major exports

- **Onboarding**: `onboard`, `OnboardingResult`, `OnboardingEgsInfo`, `OnboardArgs`.
- **Issuers (Phase 2)**: `issueSimplifiedTaxInvoice`, `issueStandardTaxInvoice`, `issueSimplifiedCreditNote`, `issueStandardCreditNote`, `issueSimplifiedDebitNote`, `issueStandardDebitNote`, `issueInvoice`.
- **Issuers (Phase 1)**: `issuePhase1Invoice`, `issuePhase1CreditNote`.
- **API client**: `singleInvoiceReportingOrClearanceStatus`, `checkInvoiceCompliance`, `cancelInvoice`, `checkInvoiceStatus`, `issueComplianceCertificate`, `issueCSIDS`.
- **Compliance**: `runComplianceTests`, `makeSimplifiedInvoiceScenario` (+ 5 peers).
- **Certificates**: `verifyCertificate`, `isCertificateValid`, `getCertificateExpirationDate`.
- **Brand factories**: `asVATNumber`, `asCommercialRegistrationNumber`, `asInvoiceUUID`, `asEGSUuid`, `asBase64`, `asInvoiceHash`.
- **Errors**: `ZatcaApiError`, `ZatcaValidationError`, `ZatcaStorageError`, `ZatcaOnboardingError`.
- **Types**: `InvoiceInput`, `InvoiceKind`, `EGSUnitInfo`, `TenantScope`, `StorageAdapter`, `InvoiceRecord`, `CounterRecord`, `InvoiceStatus`, `ZatcaEnvironment`, ...

For the full and current list, run `pnpm docs:api` and open `docs/typedoc/index.html`.
