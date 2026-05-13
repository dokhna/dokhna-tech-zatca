# Golden-vector fixtures

Each subdirectory captures one ZATCA invoice scenario produced by the
**rwiqha-backend reference helper**. The fixtures are the oracle the
Phase 2 port must reproduce.

## Scope

| Scenario | Type | Notes |
|---|---|---|
| `simple-simplified-invoice/` | Simplified tax invoice (388) | 1 line item, single VAT category. |
| `simple-standard-invoice/` | Standard tax invoice (388) | 1 line item, single VAT category. |
| `simple-simplified-credit-note/` | Simplified credit note (381) | 1 line item, references invoice 1. |

Each directory contains:

| File | Contents | Deterministic? |
|---|---|---|
| `input.json` | The props passed to the rwiqha invoice class. | Yes — fixed by the capture script. |
| `expected-presign-xml.xml` | The template-filled invoice XML *before* signing. | Yes. |
| `expected-hash.txt` | SHA-256 invoice hash, base64. | **Yes — byte-equal across runs.** |
| `expected-signed.xml` | The full signed XML. | **No** — ECDSA signature value varies (see below). |
| `expected-qr.b64` | The Phase 2 QR, base64 TLV. | **Partial** — tags 1-6, 8, 9 deterministic; tag 7 (signature) varies. |

## What the fixture tests assert

In `fixtures.test.ts`:

1. **Hash byte-equality** — Loading `expected-presign-xml.xml` and
   running our ported `getInvoiceHash` must produce *the same exact
   bytes* as `expected-hash.txt`. This is the primary parity check —
   any drift in canonicalisation, whitespace fixups, or SHA-256
   handling fails this test.
2. **Signed XML structural integrity** — the captured signed XML
   contains all the expected XAdES / UBL elements. We do not byte-
   compare because ECDSA is non-deterministic by default.
3. **QR TLV shape** — the captured QR base64 decodes into exactly 9
   TLV tags.

## ECDSA non-determinism

OpenSSL's default ECDSA signing emits a random `k` (per the algorithm
spec) — so signing the same hash with the same key twice produces
different signature bytes. RFC 6979 (deterministic ECDSA) would fix
this but neither rwiqha nor this port enables it.

Consequences:

- `expected-signed.xml` and `expected-qr.b64` were captured **once**
  from the rwiqha helper and committed verbatim. They are useful for
  shape inspection, structural assertions, and human review but
  cannot be byte-compared run-to-run.
- The byte-identical parity assertion is therefore restricted to the
  `invoice_hash`, which is taken over the unsigned canonicalised XML
  and *is* deterministic.

This is documented as the Phase 2 design decision in
`plan/PHASES/PHASE-02-crypto-xml.md`. Phase 6 (compliance test
runner) covers the live signing path end-to-end against the ZATCA
sandbox; that is where actual signature correctness is exercised.

## Capture procedure

```bash
NODE_PATH=/path/to/rwiqha-backend/node_modules \
  pnpm tsx scripts/capture-golden-vectors.mjs
```

The script:

1. Generates a fresh secp256k1 EC key + self-signed cert under
   `fixtures/_keys/` *if not already present*. The keys are
   committed so re-runs produce the same hash. Cert is valid 10
   years from generation date.
2. Imports the rwiqha helper TypeScript source directly via `tsx`
   (no rebuild of rwiqha required; we read `.ts` files).
3. For each scenario, constructs the invoice, dumps the pre-sign
   XML, signs, and writes all artefacts.

To regenerate from scratch:

```bash
rm -rf packages/core/src/fixtures/_keys packages/core/src/fixtures/simple-*
NODE_PATH=/path/to/rwiqha-backend/node_modules \
  pnpm tsx scripts/capture-golden-vectors.mjs
```

The test keys under `_keys/` are **test-only** material — they are
self-signed and have no relationship to any real ZATCA-issued
certificate. They exist solely to bind a deterministic signing
identity for fixture capture.

## Adding a new scenario

1. Append a new entry to the `SCENARIOS` array in
   `scripts/capture-golden-vectors.mjs` with a unique `name` and a
   `props` object that matches the rwiqha invoice class' input
   contract.
2. Re-run the capture script.
3. Re-run `pnpm --filter @dokhna-tach/zatca test` — the
   `fixtures.test.ts` autodiscovers any new directory.

## Fallback (if rwiqha capture is unavailable)

If `/Users/ameensaeed/Documents/Node/rwiqha-backend/` is missing or
its dependencies cannot be loaded by tsx, the capture script will
fail with a non-zero exit and no fixtures will be written. In that
case the `fixtures.test.ts` `it.todo(...)` placeholder fires
documenting the gap rather than failing the suite.

This was **not** required for Phase 2 — the full rwiqha capture
succeeded on the dev machine and all three scenarios produced
byte-identical hashes.
