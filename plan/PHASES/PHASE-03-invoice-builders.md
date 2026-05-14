# Phase 3 — Invoice / Credit / Debit Builders

**Status:** pending
**Agent:** backend-developer
**Estimated effort:** 1–2 sessions (six near-identical builders + refactor)

## Goal

Port the six UBL builder classes (Simplified/Standard × Tax invoice/Credit note/Debit note) plus the Phase 1 QR-only invoice builder from the rwiqha helper into `packages/core/src/invoices/`. Port all 9 UBL XML string templates verbatim into `packages/core/src/templates/`. Refactor the 95% shared logic across the six classes into an internal `BaseInvoiceBuilder` abstract class while keeping public function signatures unchanged.

## Source files to read first

- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.package/classes/zatca.simplified.tax.invoice.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.package/classes/zatca.standard.tax.invoice.ts`
- `.../classes/zatca.simplified.credit.note.ts`
- `.../classes/zatca.standard.credit.note.ts`
- `.../classes/zatca.simplified.debit.note.ts`
- `.../classes/zatca.standard.debit.note.ts`
- `.../templates/simplified.tax.invoice.template.ts`
- `.../templates/standard.tax.invoice.template.ts`
- `.../templates/simplified.credit.note.template.ts`
- `.../templates/standard.credit.note.template.ts`
- `.../templates/simplified.debit.note.template.ts`
- `.../templates/standard.debit.note.template.ts`
- `.../templates/zatca.ubl.extension.ts`
- `.../templates/zatca.ubl.extension.signed.properties.template.ts`
- `.../templates/invoice.billing.reference.template.ts`
- `.../functions/zatca.generate.phase1.invoice.function.ts`
- `.../functions/zatca.generate.phase1.credit.note.function.ts`

## Files to create

```
packages/core/src/
├── templates/
│   ├── index.ts
│   ├── simplified-tax-invoice.ts
│   ├── standard-tax-invoice.ts
│   ├── simplified-credit-note.ts
│   ├── standard-credit-note.ts
│   ├── simplified-debit-note.ts
│   ├── standard-debit-note.ts
│   ├── ubl-extension.ts
│   ├── ubl-signed-properties.ts
│   └── billing-reference.ts
├── invoices/
│   ├── index.ts
│   ├── base.ts                       # BaseInvoiceBuilder abstract class
│   ├── simplified-tax-invoice.ts     # extends Base
│   ├── standard-tax-invoice.ts
│   ├── simplified-credit-note.ts
│   ├── standard-credit-note.ts
│   ├── simplified-debit-note.ts
│   ├── standard-debit-note.ts
│   ├── phase1-invoice.ts             # QR-only, no signing
│   ├── phase1-credit-note.ts
│   └── *.test.ts
├── issue/
│   ├── index.ts
│   ├── build-parties.ts              # buildSellerInfo, buildBuyerInfo (framework-neutral)
│   ├── dispatch.ts                   # discriminated-union dispatcher: InvoiceInput → correct builder
│   ├── issue-simplified-invoice.ts   # public function — orchestrates: validate → build → sign → QR → return
│   ├── issue-standard-invoice.ts
│   ├── issue-simplified-credit-note.ts
│   ├── issue-standard-credit-note.ts
│   ├── issue-simplified-debit-note.ts
│   ├── issue-standard-debit-note.ts
│   ├── issue-phase1-invoice.ts
│   └── issue-phase1-credit-note.ts
```

## BaseInvoiceBuilder design

```ts
abstract class BaseInvoiceBuilder<TInput extends InvoiceInput> {
  protected abstract templateFn(input: TInput, params: BuilderParams): string;
  protected abstract invoiceTypeCode(): "388" | "381" | "383";
  protected abstract isSimplified(): boolean;
  protected abstract isCreditOrDebit(): boolean;

  build(input: TInput, params: BuilderParams): BuiltInvoice {
    // 1. zod-validate input
    // 2. fill template
    // 3. parse with XMLDocument
    // 4. inject UBL extension placeholders
    // 5. compute invoice hash
    // 6. (if not Phase 1) sign + inject signed XML
    // 7. generate QR
    // 8. return { xml, signedXml, invoiceHash, qrCode }
  }
}
```

The six concrete builders override `templateFn`, `invoiceTypeCode`, `isSimplified`, `isCreditOrDebit`. Their bodies are ~30 LOC each.

## Public function shape

```ts
// issue/issue-simplified-invoice.ts
export async function issueSimplifiedTaxInvoice(args: {
  input: SimplifiedTaxInvoiceInput;
  egsInfo: EGSUnitInfo;
  storage: StorageAdapter;
  scope: TenantScope;
}): Promise<IssuedInvoice> {
  // 1. storage.incrementCounter(scope) → { sequence, invoiceNumber }
  // 2. storage.getPreviousHash(scope, "simplified-tax-invoice")
  // 3. new SimplifiedTaxInvoiceBuilder().build({ ... })
  // 4. return { invoiceXml, signedXml, invoiceHash, qrCode, sequence, invoiceNumber }
}

export type IssuedInvoice = {
  invoiceXml: string;
  signedXml: string;
  invoiceHash: InvoiceHash;
  qrCode: Base64;
  sequence: number;
  invoiceNumber: string;
};
```

Phase 1 variants return `{ invoiceXml, qrCode, sequence, invoiceNumber }` (no `signedXml`, no `invoiceHash`).

## Refactor discipline

- Templates are **verbatim XML strings** from rwiqha — do NOT format, reflow, or "improve" them. ZATCA spec is whitespace-sensitive in the canonicalisation step.
- Variable substitution syntax used in rwiqha must be preserved (template literal interpolation).
- The six builder classes had ~95% identical bodies in rwiqha. The refactor must NOT change observable output. Extract via the `BaseInvoiceBuilder` Template Method pattern.

## Exit tests

1. `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test` all pass.
2. For each of the 6 invoice types (+ 2 Phase 1 variants), unit tests assert byte-equal XML against captured fixtures from rwiqha.
3. Round-trip parse test: build → parse with `XMLDocument` → assert key ZATCA fields present (`cbc:ID`, `cbc:UUID`, `cac:AccountingSupplierParty`, etc.).
4. `BaseInvoiceBuilder` has at least one direct unit test covering the template-method dispatch.
5. `pnpm --filter @dokhna-tech/zatca exec sh -c 'wc -l src/invoices/*.ts'` shows each concrete builder file < 80 LOC (refactor proves itself).

## What this phase does NOT do

- No HTTP / API calls — Phase 4.
- No real storage adapter — Phase 5 (but uses `StorageAdapter` interface from Phase 1).
- No onboarding / CSR generation — Phase 6.
