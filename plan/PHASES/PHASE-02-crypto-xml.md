# Phase 2 — Crypto, XML, QR Core

**Status:** pending
**Agent:** backend-developer
**Estimated effort:** 1–2 sessions (porting + dependency replacement + golden-vector tests)

## Goal

Port the pure cryptographic pipeline from the rwiqha helper into `packages/core/src/{xml,crypto,qr,utils}/`. Replace problematic dependencies (`xmldom` → `@xmldom/xmldom`, drop `moment`, drop `lodash`). Keep `xmldsigjs` and `@fidm/x509` for now (documented). Add an OpenSSL probe. Lock byte-identical output against the source helper via golden-vector tests captured from rwiqha first.

## Source files to read first

- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.package/classes/zatca.xml.parser.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.package/classes/zatca.xml.signing.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.package/classes/zatca.qr.generator.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.date.time.helper.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.generate.secp256k1.keys.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.generate.csr.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.csr.template.function.ts`

## Files to create

```
packages/core/src/
├── xml/
│   ├── index.ts
│   ├── document.ts          # XMLDocument class — port from zatca.xml.parser.ts, drop lodash
│   └── document.test.ts
├── crypto/
│   ├── index.ts
│   ├── hash.ts              # getInvoiceHash — SHA-256 over canonicalized invoice block
│   ├── sign.ts              # createInvoiceDigitalSignature, generateSignedXMLString
│   ├── cert-info.ts         # extractCertificateInfo using @fidm/x509
│   ├── openssl-probe.ts     # probeOpenssl(): Promise<{ available: boolean; version: string }>
│   ├── generate-keys.ts     # generateSecp256k1KeyPair() — shells out to openssl ecparam
│   ├── generate-csr.ts      # generateCSR — shells out to openssl req
│   ├── csr-template.ts      # OpenSSL .cnf string builder
│   ├── *.test.ts            # one per module
├── qr/
│   ├── index.ts
│   ├── tlv.ts               # TLV encoder — base primitive
│   ├── phase2.ts            # Phase 2 QR (8 TLV tags including cert hash + signature)
│   ├── phase1.ts            # Phase 1 QR (5 TLV tags, no cert)
│   └── *.test.ts
├── utils/
│   ├── datetime.ts          # formatZatcaDate, formatZatcaTime, formatZatcaDateTime — pure Date, no moment
│   └── datetime.test.ts
└── fixtures/                # golden-vector test data (captured from rwiqha helper)
    ├── simple-simplified-input.json
    ├── simple-simplified-expected-xml.xml
    ├── simple-simplified-expected-hash.txt
    ├── simple-simplified-expected-qr.b64
    └── ...
```

## Dependency changes (in `packages/core/package.json`)

Add:
- `@xmldom/xmldom` (^0.8.x — maintained namespace)
- `xmldsigjs` (^2.x — same version rwiqha uses)
- `@fidm/x509` (^1.x — temporary; documented for v2 replacement)
- `fast-xml-parser` (^4.x)

Do NOT add:
- `xmldom` (deprecated)
- `moment` (replace with native Date)
- `lodash` (replace with small native walker)

Dev-only:
- `@types/node` (already implicit via TypeScript stdlib)

## Dependency replacement strategy

### `lodash` → native walker

In `zatca.xml.parser.ts`, lodash is used for `filter(matches({...}))` inside `XMLDocument.get(path, predicates)`. Replace with a tiny `arrayFilterByMatchSubset(arr, partial)` helper that does shallow predicate matching against object properties. Total replacement: ~20 LOC.

### `moment` → native Date

`zatca.date.time.helper.ts` formats dates as `YYYY-MM-DDTHH:mm:ss` (ZATCA format). Use `toISOString().slice(0, 19)` plus a small helper for the sign timestamp variants. Keep the helper API surface stable: `formatZatcaDate(d): string`, `formatZatcaTime(d): string`, `formatZatcaDateTime(d): string`.

### `xmldom` → `@xmldom/xmldom`

Pure import-path rename. The API is identical. Bump version range to `^0.8.x`.

## OpenSSL probe

```ts
// crypto/openssl-probe.ts
export async function probeOpenssl(): Promise<{ available: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn("openssl", ["version"]);
    let out = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.on("error", () => resolve({ available: false, version: null }));
    proc.on("close", (code) => {
      resolve({ available: code === 0, version: out.trim() || null });
    });
  });
}
```

Call sites that shell out to OpenSSL (CSR + key gen) should call this probe first and throw `ZatcaOnboardingError` if unavailable, with a clear message: "OpenSSL CLI is required for ZATCA onboarding but was not found on PATH. Install OpenSSL or use a Docker image with OpenSSL pre-installed."

## Golden-vector test capture (do FIRST in this phase)

Before writing any new code, write a small one-off script that runs the rwiqha helper on a curated set of inputs and dumps:

- Input invoice JSON
- Expected canonicalised XML
- Expected SHA-256 hash (`InvoiceHash`)
- Expected signed XML
- Expected QR bytes (base64)

Commit these under `packages/core/src/fixtures/` as the oracle. Every Phase 2 unit test asserts byte-equality (or canonical equality, for whitespace-sensitive XML) against the fixture. **This is the ground truth that prevents regression as we modernize dependencies.**

Capture at least: one simplified tax invoice, one standard tax invoice, one simplified credit note. Phase 3 will add the other three plus debit notes.

## Exit tests

Run from repo root:
1. `pnpm install` succeeds.
2. `pnpm -r typecheck` passes.
3. `pnpm -r build` succeeds.
4. `pnpm --filter @dokhna-tech/zatca test` passes, including:
   - XMLDocument round-trip on canonical UBL XML
   - SHA-256 hash byte-identical to fixture (≥3 fixtures)
   - Signed XML byte-identical (whitespace-stripped) to fixture
   - QR bytes base64-identical to fixture
   - OpenSSL probe returns `{available: true}` on the dev machine
   - secp256k1 key generation produces a valid PEM
   - CSR generation produces a valid PEM with the expected DN fields
5. `grep -R "\\blodash\\b\\|\\bmoment\\b\\|\\bxmldom\\b[^/]" packages/core/src` returns nothing (no banned imports outside `@xmldom/xmldom`).

## What this phase does NOT do

- No invoice builder classes — that is Phase 3.
- No HTTP / ZATCA API calls — that is Phase 4.
- No `@fidm/x509` replacement — deferred to v2.
- No documentation of the security model — that is Phase 7.
