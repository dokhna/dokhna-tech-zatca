# single-vat-express

Minimal Express server that exposes onboarding and invoice issuance for a single Saudi VAT registration. Uses the in-memory storage adapter so it runs without a database.

## Run it

```bash
pnpm install                     # from the repo root
cp examples/single-vat-express/.env.example examples/single-vat-express/.env
# fill in VAT_NUMBER, EGS_UUID, etc.

pnpm --filter @dokhna-tech-examples/single-vat-express start
```

The server listens on `http://localhost:3000` (override via `PORT`).

## Routes

| Route | Purpose |
|-------|---------|
| `GET /health` | Liveness + reports whether issuance is ready (i.e. env vars are set). |
| `POST /onboard` | Runs `onboard()` against the ZATCA simulation gateway and writes the result to `data/onboarding.json`. |
| `POST /invoices` | Issues a simplified tax invoice via `issueSimplifiedTaxInvoice` and persists to in-memory storage. |
| `GET /invoices/:id` | Loads a previously issued invoice from storage. |

## Onboarding flow

1. Get a 6-digit OTP from the Fatoora portal.
2. `POST /onboard` with `{ otp, vatName, vatNumber, crn }`.
3. The server runs the full `onboard()` flow (key + CSR + compliance cert + 6 compliance tests + production CSID) and writes the result to `data/onboarding.json`.
4. Copy `productionCertificate` and `privateKey` from that file into your `.env` (encrypted at rest in production!).
5. Restart the server. `/invoices` is now ready.

> WARNING: `data/onboarding.json` contains the private key and two API secrets in plaintext. This is for demo purposes only. In production, encrypt with KMS / Secrets Manager and never commit the file. The example's `.gitignore` should exclude `data/`.

## Issuing an invoice

```bash
curl -X POST http://localhost:3000/invoices \
  -H "Content-Type: application/json" \
  -d '{
    "issueDate": "2026-05-13",
    "issueTime": "12:00:00",
    "buyerName": "Walk-in customer",
    "lineItems": [
      { "id": "1", "name": "Coffee 250ml", "quantity": 2, "taxExclusivePrice": 10, "vatPercent": 15 }
    ]
  }'
```

Response:

```json
{
  "invoiceNumber": "202605000001",
  "sequence": 1,
  "invoiceHash": "...",
  "qrCode": "..."
}
```

## Reading the code

- `src/zatca-client.ts` — builds the shared context (storage adapter, EGS info, signing credentials).
- `src/server.ts` — Express routes.
- `scripts/start.ts` — alias entry point.

The full library API is documented in [`../../docs/`](../../docs/). For multi-tenant SaaS, see [`../multi-vat-saas/`](../multi-vat-saas/).
