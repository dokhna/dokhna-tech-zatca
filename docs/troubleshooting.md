# Troubleshooting

ZATCA error codes you'll actually see, plus the operational gotchas the maintainers ran into.

## ZATCA validation error codes

Codes are returned in `validationResults.errorMessages[].code` on a `ZatcaApiError`. The list below is the subset that came up repeatedly during the production helper's first six months. The ZATCA published spec is the authoritative source for the full set.

| Code | What it means | Common cause |
|------|---------------|--------------|
| `BR-KSA-02` | Required field missing or empty | Buyer name on a simplified summary invoice (>= 1,000 SAR) is required. Set `input.buyerName`. |
| `BR-KSA-09` | Line VAT amount mismatch | `quantity × taxExclusivePrice × (vatPercent/100)` rounded to 2dp does not match the computed line VAT. Usually a floating-point rounding issue upstream — pass already-rounded numbers in. |
| `BR-KSA-12` | Invoice counter is not monotonic | `incrementCounter` returned an unexpected value, or a counter was hand-set in the DB. Check for parallel writes outside the adapter. |
| `BR-KSA-13` | Previous invoice hash does not match | The chain is broken. Compare `getPreviousHash` output against the hash stored on the most recent `InvoiceRecord`. |
| `BR-KSA-15` | Invoice UUID is not a valid v4 UUID | Generate with `crypto.randomUUID()` or pass through `asInvoiceUUID(...)`. |
| `BR-KSA-22` | Issue datetime is in the future | Clock skew between your host and the ZATCA gateway. Sync with NTP. |
| `BR-KSA-39` | Buyer VAT format invalid | The buyer VAT is not 15 digits starting/ending with `3`. Use `asVATNumber(...)` to validate before calling the issuer. |
| `BR-KSA-49` | Buyer postal code missing | Required for standard invoices. |
| `BR-KSA-50` | Buyer street missing | Required for standard invoices. |
| `BR-KSA-71` | Buyer name missing on simplified summary | Same as BR-KSA-02 but specifically for the 1,000-SAR threshold rule. |
| `BR-KSA-79` | Credit/debit note missing `cancelation` reference | Set `input.cancelation.canceledInvoiceNumber`, `paymentMethod`, `cancelationType`, `reason`. |
| `INVALID-SIGNATURE` (ZATCA literal) | Signature verification failed | The signing certificate doesn't match the private key, or the wrong cert was passed. Run `verifyCertificate(pem, { privateKey })` to confirm. |

When in doubt, the gateway response carries a `category` and `message` for each error — log those (without the request body) for support.

## Operational issues

### OpenSSL not found

`onboard()` throws:

> `ZatcaOnboardingError: OpenSSL CLI is required for onboarding but was not found on PATH.`

Causes and fixes:

- **AWS Lambda with the default Node 20 runtime** — the runtime has OpenSSL 3 at `/usr/bin/openssl` but only on the AL2023 image. If you're on the legacy AL2 image, ship a Lambda layer:
  ```bash
  mkdir -p layer/bin && cp /usr/bin/openssl layer/bin/
  cd layer && zip -r ../openssl-layer.zip . && cd ..
  aws lambda publish-layer-version \
    --layer-name openssl \
    --zip-file fileb://openssl-layer.zip \
    --compatible-runtimes nodejs20.x
  ```
  Then attach the layer to the function. The layer's `bin/` is on `PATH` by default.
- **`node:alpine` Docker base image** — install via `RUN apk add --no-cache openssl`.
- **Vercel / Netlify functions** — most modern function platforms have OpenSSL preinstalled. If yours does not, you need a different platform for the onboarding step. You can keep the rest of the integration (issuing + submitting invoices) anywhere; onboarding is one-shot per EGS.

### Tests/local dev: skipping the OpenSSL probe

The probe can be skipped with `args.crypto.skipOpensslProbe: true` (test-only). Do not use this in production — if OpenSSL is missing, key + CSR generation will fail with a less helpful error.

### `Cannot find module '@dokhna-tech/zatca'`

You're using a non-pnpm package manager that doesn't link the workspace. From the example app's directory:

```bash
pnpm install
pnpm --filter @dokhna-tech-examples/single-vat-express build
```

Or, if you've published the package, `pnpm add @dokhna-tech/zatca` should pick up the registry version.

### URLs and auth-scheme drift caveat

The sandbox and simulation hostnames, and the `Authorization` header scheme used for the cancel / status calls, were inferred from a known-working production helper. They have **not** been verified against a freshly provisioned ZATCA gateway in this branch. If you hit:

- **`ZatcaApiError (status 404)`** on cancel / status — the endpoint path may have shifted. Inspect `ZATCA_ENDPOINTS` in `packages/core/src/api/endpoints.ts` and compare against the current ZATCA Developer Portal.
- **`ZatcaApiError (status 401)`** on cancel / status with valid credentials — the auth header may need to be `Bearer <token>` instead of `Basic <b64(token:secret)>` (or vice versa). The current implementation matches what the source helper sent. Override via `httpClientOptions.headers` if needed.

This is a known caveat for the v0.9.0-beta release. Once the first user runs an example against a live sandbox, we'll harden this in a patch release.

### `ZatcaStorageError: recordInvoice failed with conflicting payload`

You called `recordInvoice` with the same `invoiceId` but different field values. The adapter is idempotent: same id, same payload → no-op. Different payload is a programmer error (or a partial write retry). Pass a fresh `invoiceId` (default is `crypto.randomUUID()`) for each new invoice.

### Counter races / duplicated sequences

If you see two invoices with the same `counterNumber` on the same `(vatNumber, egsUuid)`:

- You are bypassing the adapter on one call site. The atomic increment is the adapter's job; do not call `model.create({ counterNumber: ... })` directly.
- Your adapter is wrong. Run the conformance suite (`runStorageAdapterConformance` from `@dokhna-tech/zatca/test-helpers`) against your adapter.

### Hash chain breaks

`BR-KSA-13` says the previous-hash field on the invoice does not match what ZATCA expects. Causes:

- A manual `delete` or `update` against the storage in the past. The chain is content-addressed; you can't delete a link without breaking the chain.
- A race condition where `recordInvoice` for invoice N happens *after* `incrementCounter` for invoice N+1. The reference adapters serialize within a scope; if you wrote a custom one, ensure `recordInvoice` and `incrementCounter` are mutually consistent.
- The very first invoice's `previousInvoiceHash` is not the ZATCA base hash. Confirm `getPreviousHash` returns `"NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ=="` when no prior invoice exists.

### Sandbox returns 200 but `validationResults.status === "WARNING"`

That's fine. The submission was recorded; ZATCA is informing you of a non-fatal finding. Inspect `validationResults.warningMessages` and decide whether to surface to your operators.

### Why does my hash differ from another helper?

Two common causes:

- Whitespace handling in the canonicalization step. The signing pipeline strips whitespace from the `UBLExtensions` element only; everything else is byte-preserved. If you canonicalize the whole document differently, your hash will differ.
- Date/time formatting. ZATCA accepts `YYYY-MM-DD` and `HH:mm:ss`; if you pass ISO-with-Z or a non-zero-padded time, the hash changes.

The Phase 2 golden-vector tests in `packages/core/src/crypto/` confirm byte-identical hashes against three captured invoices from the source helper.

### TypeScript build errors after upgrading

The package targets `module: NodeNext`. Make sure your `tsconfig.json` has:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

If you must stay on `CommonJS`, use the `require` entry: `const { issueSimplifiedTaxInvoice } = require("@dokhna-tech/zatca");`. The package ships both ESM and CJS bundles.

### "I get no logs from the package"

By design. The package writes nothing to the console. To see what's happening, enable the `debug` namespaces in your host:

```bash
DEBUG='zatca:*' node dist/server.js
```

Available namespaces:

- `zatca:storage:memory`
- `zatca:storage:mongo`
- `zatca:storage:postgres`

(The core package and the API client do not emit debug messages — they only throw typed errors.)
