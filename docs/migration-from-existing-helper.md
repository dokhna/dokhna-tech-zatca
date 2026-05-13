# Migration from an existing in-house helper

If you're moving from a hand-rolled ZATCA helper (the kind every Saudi back office has built at least once) to `@dokhna-tach/zatca`, this is your function-by-function map. The mapping below uses the structure of the source helper this package was extracted from — your in-house helper probably has the same shape because we all read the same ZATCA spec.

## High level

| Concern | In-house helper | `@dokhna-tach/zatca` |
|---------|----------------|-----------------------|
| Build + sign one document | A builder class per document type (`ZATCASimplifiedTaxInvoice`, ...) | An issuer function per document type (`issueSimplifiedTaxInvoice`, ...) |
| QR generation | `generateQR(...)` / `generatePhaseOneQR(...)` | Built into the issuer; you get `IssuedInvoice.qrCode` |
| Hash | `getInvoiceHash(invoiceXml)` | Built into the issuer; you get `IssuedInvoice.invoiceHash` |
| Submit to ZATCA | `submitInvoiceClearance(...)` / `reportSimplifiedInvoice(...)` | `singleInvoiceReportingOrClearanceStatus(...)` — auto-routes |
| Cancel / status | `cancelInvoice(...)` / `getInvoiceStatus(...)` | `cancelInvoice(...)` / `checkInvoiceStatus(...)` |
| Compliance check | `checkInvoiceCompliance(...)` | `checkInvoiceCompliance(...)` |
| Onboarding (CSR + CSID) | usually a script + manual steps | `onboard(...)` — one call |
| Storage / counters / hash chain | a Mongoose model with custom code | `StorageAdapter` interface + 3 reference adapters |

## Function-by-function

### Builders (UBL XML generation)

| In-house | `@dokhna-tach/zatca` | Notes |
|----------|----------------------|-------|
| `new ZATCASimplifiedTaxInvoice(props).getXML()` | `issueSimplifiedTaxInvoice({ input, egsInfo, storage, scope, signing })` | Issuer signs + records + returns the bundle. To get the raw class, import `SimplifiedTaxInvoiceBuilder` (advanced). |
| `new ZATCAStandardTaxInvoice(props).getXML()` | `issueStandardTaxInvoice(...)` | Same shape. |
| `new ZATCASimplifiedCreditNote(props).getXML()` | `issueSimplifiedCreditNote(...)` | `input.cancelation` required (matches in-house). |
| `new ZATCAStandardCreditNote(props).getXML()` | `issueStandardCreditNote(...)` | |
| `new ZATCASimplifiedDebitNote(props).getXML()` | `issueSimplifiedDebitNote(...)` | |
| `new ZATCAStandardDebitNote(props).getXML()` | `issueStandardDebitNote(...)` | |
| `populateSimplifiedInvoiceTemplate(...)` | (internal) | Not re-exported; the issuer wraps it. |
| `populateStandardInvoiceTemplate(...)` | (internal) | Not re-exported. |
| `populateSimplifiedCreditNoteTemplate(...)` | (internal) | Not re-exported. |
| `populateStandardCreditNoteTemplate(...)` | (internal) | Not re-exported. |
| `populateSimplifiedDebitNoteTemplate(...)` | (internal) | Not re-exported. |
| `populateStandardDebitNoteTemplate(...)` | (internal) | Not re-exported. |
| `generateInvoiceBillingReference(...)` | (internal) | Used by debit / credit note builders. |
| `populateUBLExtension(...)` | (internal) | |
| `populateSignedProperties(...)` | (internal) | |

### Signing / hashing primitives

| In-house | `@dokhna-tach/zatca` | Notes |
|----------|----------------------|-------|
| `generateSignedXMLString(...)` | (handled by issuer) | Lower-level signing lives in `packages/core/src/crypto/` but is not re-exported by name. |
| `getPureInvoiceString(...)` | (internal) | Canonical XML stripping logic. |
| `getInvoiceHash(invoiceXml)` | (handled by issuer) | The bundle exposes `invoiceHash` as a branded `InvoiceHash`. |
| `getCertificateHash(cert)` | (handled by issuer) | |
| `createInvoiceDigitalSignature(...)` | (handled by issuer) | |
| `getCertificateInfo(cert)` | `verifyCertificate(pem, options)` | Returns a structured `CertificateVerification`. |
| `cleanUpCertificateString(pem)` | (internal) | The issuer no longer requires hand-cleaning the cert. |
| `cleanUpPrivateKeyString(pem)` | (internal) | Same. |

### QR codes

| In-house | `@dokhna-tach/zatca` | Notes |
|----------|----------------------|-------|
| `generateQR({...phase2...})` | `IssuedInvoice.qrCode` from any Phase 2 issuer | The QR is computed during issue and returned base64. |
| `generatePhaseOneQR({...})` | `issuePhase1Invoice(...).qrCode` | Phase 1 issuers also return `qrCode`. |

### ZATCA API client (the part that talks to `*.zatca.gov.sa`)

| In-house | `@dokhna-tach/zatca` | Signature change |
|----------|----------------------|------------------|
| `Zatca.submitInvoiceClearance({ xmlContent, invoiceHash, uuid, previousInvoiceHash })` | `singleInvoiceReportingOrClearanceStatus({ signedInvoiceXml, invoiceHash, egsUuid, binarySecurityToken, apiSecret, environment })` | Routing is automatic from the XML; you no longer pick clearance vs reporting yourself. Credentials are explicit, not pulled from globals. |
| `Zatca.reportSimplifiedInvoice({ xmlContent, invoiceHash, uuid })` | `singleInvoiceReportingOrClearanceStatus(...)` | Same — one entry point for both. |
| `Zatca.cancelInvoice({ invoiceId, clearanceNumber, reason })` | `cancelInvoice({ environment, clearanceNumber, reason, binarySecurityToken, apiSecret })` | The argument names align with the ZATCA wire format. |
| `Zatca.getInvoiceStatus({ invoiceId, clearanceNumber })` | `checkInvoiceStatus({ environment, clearanceNumber, binarySecurityToken, apiSecret })` | |
| `checkInvoiceCompliance({ signedInvoiceXml, invoiceHash, egsUuid, binarySecurityToken, apiSecret, environment })` | `checkInvoiceCompliance(same)` | Identical surface. |
| `issueComplianceCertificate({ csr, otp, environment })` | `issueComplianceCertificate(same)` | |
| `issueCSIDS({ complianceRequestId, binarySecurityToken, apiSecret, environment })` | `issueCSIDS(same)` | |

### Cancellation / status

| In-house behaviour | `@dokhna-tach/zatca` |
|--------------------|-----------------------|
| Throws untyped `Error` with concatenated message | Throws `ZatcaApiError` with `statusCode` + `validationResults` |
| Inherits credentials from process env | Credentials explicit per call |
| Logs to `console.error` on failure | No logging — package is silent |

### Storage and persistence

| In-house | `@dokhna-tach/zatca` |
|----------|-----------------------|
| Mongoose `ZatcaInvoice` model with counter + chain logic mixed in | `StorageAdapter` interface; counter + chain operations are explicit methods |
| Manual `findOneAndUpdate({$inc:{sequence:1}})` per call site | `storage.incrementCounter(scope)` |
| Manual `find().sort({createdAt:-1}).limit(1)` for previous hash | `storage.getPreviousHash(scope)` |
| Manual `model.create(...)` to persist | `storage.recordInvoice(scope, record)` (idempotent on `invoiceId`) |
| Status updates via direct model mutation | `storage.updateInvoiceStatus(scope, invoiceId, status)` |

If you already have Mongoose in your codebase, [`@dokhna-tach/zatca-storage-mongo`](../packages/storage-mongo/) takes a `Connection` you already own. Migration is a couple of imports plus deleting your custom counter logic.

### Onboarding

| In-house | `@dokhna-tach/zatca` |
|----------|-----------------------|
| A shell script that runs `openssl ecparam` / `openssl req` and then calls compliance endpoints manually | `onboard({ egsInfo, otp, environment, solutionName })` |
| Manual six-scenario compliance test invocation | `runComplianceTests(...)` — or just call `onboard()` |
| Manual production CSID exchange | Built into `onboard()` |

## Mapping your tenant model

The in-house model used a single Mongoose collection per VAT registration. To map to the new world:

- Each `(vatNumber, egsUuid)` pair → one `TenantScope`.
- Each row in your tenants table → one `EGSUnitInfo` + one secret bundle resolved on the request path.
- The counter you stored on the tenant row → owned by the storage adapter; delete the column when you fully cut over.
- The previous-hash field you stored on the tenant row → owned by the adapter (derived from the most recent `InvoiceRecord`); delete the column when you cut over.

## Cutover playbook

1. Install the package alongside the existing helper. Keep both running.
2. Pick a low-volume EGS (or a brand new one). Run `onboard()` against simulation.
3. Wire `issueSimplifiedTaxInvoice` for that EGS only, behind a feature flag.
4. Compare the byte-identical signed XML and QR against the in-house output for a representative sample of inputs. (The library was extracted with golden-vector tests against the same in-house helper.)
5. Cut traffic over per-EGS; remove the old helper code once the migration completes.

## Type imports

If your codebase had ambient or generated types for invoices, the equivalents are:

```ts
import type {
  // primitives
  VATNumber, CommercialRegistrationNumber, EGSUuid, InvoiceUUID, InvoiceHash, Base64,
  // EGS / parties
  EGSUnitInfo, EGSUnitLocation, BuyerInfo,
  // documents
  InvoiceInput, InvoiceKind,
  SimplifiedTaxInvoiceInput, StandardTaxInvoiceInput,
  SimplifiedCreditNoteInput, StandardCreditNoteInput,
  SimplifiedDebitNoteInput, StandardDebitNoteInput,
  Phase1InvoiceInput, Phase1CreditNoteInput,
  ZATCAInvoiceLineItem, ZATCAInvoiceCancelation, ZATCAInvoiceLineItemDiscount,
  // storage
  StorageAdapter, TenantScope, InvoiceRecord, CounterRecord, InvoiceStatus,
  // api
  ZatcaEnvironment, ZatcaClearanceResult, ZatcaComplianceResult,
  // errors
  ZatcaApiError, ZatcaValidationError, ZatcaStorageError, ZatcaOnboardingError,
} from "@dokhna-tach/zatca";
```

All exported types are the canonical names used in the generated API reference (`docs/typedoc/`).
