# Phase 1 — Type System Foundation

**Status:** pending
**Agent:** typescript-pro
**Estimated effort:** 1 session (mostly mechanical port + branding)

## Goal

Port and modernize all ZATCA-related interfaces from the rwiqha helper into a clean, framework-neutral type system in `packages/core/src/types/`. Add branded types, discriminated unions, and an error-class hierarchy. Add `zod` runtime validators for inputs. After this phase, no real logic is implemented — only types and validators — but the surface area of every later phase's function signature is locked in.

## Source files to read first

- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.package/interface.ts` — primary input
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.invoice.model.interface.ts` — informs `InvoiceRecord` shape for storage
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.credit.notes/zatca.credit.note.model.interface.ts` — informs credit-note record shape
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.counter.model.interface.ts` — informs `CounterRecord`
- `/Users/ameensaeed/.claude/plans/we-ve-been-trying-to-twinkly-pascal.md` — master plan

## Files to create

All paths under `packages/core/src/`:

```
types/
├── index.ts              # barrel re-export
├── branded.ts            # VATNumber, CommercialRegistrationNumber, InvoiceUUID, InvoiceHash, EGSUuid, Base64 brands
├── egs.ts                # EGSUnitInfo, EGSUnitLocation, EGSCertificate triplet
├── invoice.ts            # InvoiceInput discriminated union, line items, tax/discount, payment methods, invoice-type literals
├── credit-note.ts        # CreditNoteInput variants (re-uses invoice line item types)
├── debit-note.ts         # DebitNoteInput variants
├── api.ts                # ZatcaApiResponse<T>, ZatcaComplianceResult, ZatcaClearanceResult, validation envelopes
├── crypto.ts             # SignedXml, InvoiceHash result, QrBytes, X509CertificateInfo
├── storage.ts            # StorageAdapter, TenantScope, InvoiceRecord, CounterRecord, InvoiceStatus enum
├── errors.ts             # ZatcaError base + ZatcaValidationError, ZatcaApiError, ZatcaSigningError, ZatcaCertificateError, ZatcaOnboardingError, ZatcaStorageError
├── validators.ts         # zod schemas mirroring every input type; export inferred TS types alongside

validation/
├── index.ts
├── vat-number.ts         # 15-digit, starts/ends with 3, runtime check + branded factory
├── crn.ts                # commercial registration number runtime check
├── uuid.ts               # ZATCA UUID format check
```

`packages/core/src/index.ts` then re-exports everything from `./types`.

## Specific type design notes

### Branded types

```ts
declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type VATNumber = Brand<string, "VATNumber">;
export type CommercialRegistrationNumber = Brand<string, "CRN">;
export type InvoiceUUID = Brand<string, "InvoiceUUID">;
export type InvoiceHash = Brand<string, "InvoiceHash">;
export type EGSUuid = Brand<string, "EGSUuid">;
export type Base64 = Brand<string, "Base64">;
```

Each brand has a runtime factory in `validation/`:

```ts
export function asVATNumber(s: string): VATNumber {
  if (!/^3\d{13}3$/.test(s)) throw new ZatcaValidationError(`Invalid VAT number: ${s}`);
  return s as VATNumber;
}
```

### Discriminated union for invoice input

```ts
export type InvoiceInput =
  | SimplifiedTaxInvoiceInput
  | StandardTaxInvoiceInput
  | SimplifiedCreditNoteInput
  | StandardCreditNoteInput
  | SimplifiedDebitNoteInput
  | StandardDebitNoteInput;

export type InvoiceKind = InvoiceInput["kind"];
```

Each variant has `kind: "simplified-tax-invoice"` etc. as a literal.

### StorageAdapter

```ts
export interface StorageAdapter {
  incrementCounter(scope: TenantScope): Promise<{ sequence: number; invoiceNumber: string }>;
  getPreviousHash(scope: TenantScope, invoiceKind?: InvoiceKind): Promise<InvoiceHash>;
  recordInvoice(scope: TenantScope, record: InvoiceRecord): Promise<void>;
  loadInvoice(scope: TenantScope, invoiceId: string): Promise<InvoiceRecord | null>;
  updateInvoiceStatus(scope: TenantScope, invoiceId: string, status: InvoiceStatus): Promise<void>;
}

export type TenantScope = { vatNumber: VATNumber; egsUuid: EGSUuid };
```

### Error hierarchy

```ts
export class ZatcaError extends Error { constructor(msg: string, public readonly cause?: unknown) { super(msg); this.name = this.constructor.name; } }
export class ZatcaValidationError extends ZatcaError {}
export class ZatcaApiError extends ZatcaError { constructor(msg: string, public readonly statusCode: number, public readonly validationResults?: unknown, public readonly requestId?: string, public readonly rawResponse?: unknown) { super(msg); } }
export class ZatcaSigningError extends ZatcaError {}
export class ZatcaCertificateError extends ZatcaError {}
export class ZatcaOnboardingError extends ZatcaError {}
export class ZatcaStorageError extends ZatcaError {}
```

## Dependencies to add

In `packages/core/package.json` add:
- `zod` (^3.23 or latest) — runtime validation

That is the ONLY runtime dep added this phase. No crypto, no XML, no HTTP libs yet.

## Exit tests

Run from repo root:
1. `pnpm install` (after adding zod) succeeds.
2. `pnpm -r typecheck` passes with zero errors.
3. `pnpm -r build` produces dist files for `@dokhna-tach/zatca` containing all type exports.
4. `pnpm --filter @dokhna-tach/zatca test` runs and passes branded-type runtime guard tests:
   - `asVATNumber("310987654321003")` returns branded
   - `asVATNumber("invalid")` throws `ZatcaValidationError`
   - Similar tests for CRN and InvoiceUUID
5. `grep -R "\\bany\\b" packages/core/src` returns nothing (no implicit-`any`, no explicit-`any`).

## What this phase does NOT do

- No XML parsing.
- No signing.
- No HTTP.
- No storage implementations — only the interface.
- No tests beyond branded-type guards.
