# multi-vat-saas

Fastify server that demonstrates a multi-tenant SaaS topology: many Saudi VAT registrants on one runtime, isolated certificates, isolated counters, isolated hash chains, all sharing one Mongoose connection through `@dokhna-tach/zatca-storage-mongo`.

## Architecture

```
                    Fastify server
                         │
              X-Tenant-ID header
                         │
              ┌──────────┴──────────┐
              │   tenant-router     │  resolves TenantScope + per-tenant credentials
              └──────────┬──────────┘
                         │
            issueSimplifiedTaxInvoice
                         │
             ┌───────────┴───────────┐
             │  MongoStorageAdapter  │  scoped by (vatNumber, egsUuid)
             └───────────┬───────────┘
                         │
                       Mongo
```

- Every request must carry an `X-Tenant-ID` header.
- The tenant router resolves a `TenantScope = { vatNumber, egsUuid }` and the per-tenant signing material (certificate + private key + BST + API secret).
- The storage adapter scopes everything (counter, hash chain, persisted record) by that scope. Tenant A and tenant B cannot interfere with each other's chains by construction.
- The storage adapter takes a Mongoose `Connection` that you own — it does not manage connection lifecycle.

## Run it

```bash
# from the repo root
pnpm install
docker compose --file examples/multi-vat-saas/docker-compose.yml up -d
cp examples/multi-vat-saas/.env.example examples/multi-vat-saas/.env
# fill in per-tenant signing material

pnpm --filter @dokhna-tach-examples/multi-vat-saas start
```

The server listens on `http://localhost:3000`.

## Routes

| Route | Headers | Purpose |
|-------|---------|---------|
| `GET /health` | — | Liveness + tenant count. |
| `POST /invoices` | `X-Tenant-ID: acme \| globex` | Issues a simplified tax invoice for the tenant. |
| `GET /invoices/:id` | `X-Tenant-ID: ...` | Loads an issued invoice scoped to the tenant. |

## Example request

```bash
curl -X POST http://localhost:3000/invoices \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: acme" \
  -d '{
    "issueDate": "2026-05-13",
    "issueTime": "12:00:00",
    "buyerName": "Walk-in customer",
    "lineItems": [
      { "id": "1", "name": "Latte 250ml", "quantity": 1, "taxExclusivePrice": 12, "vatPercent": 15 }
    ]
  }'
```

## Adding a tenant

1. Run the onboarding flow for the tenant out-of-band (see [`../single-vat-express/`](../single-vat-express/) `/onboard` route, or call `onboard()` from a script).
2. Encrypt the resulting private key + API secrets at rest.
3. Add an entry to the `DEMO_TENANTS` array in `src/server.ts` (in production, this is a tenants collection in your database).
4. On the request path, resolve and decrypt the credentials. Pass them into `issueSimplifiedTaxInvoice` via `signing: { certificate, privateKey }`.

## Files

- `src/server.ts` — Fastify routes + tenants registry (demo only).
- `src/tenant-router.ts` — tenant resolver, returns scope + EGS info + credentials.
- `src/zatca-mongo.ts` — Mongoose connection + adapter wiring.
- `docker-compose.yml` — MongoDB for local dev.

## What it does NOT do

- It does NOT manage secret rotation. That's your scheduler's job.
- It does NOT enforce a state machine on invoice status. Use a workflow engine if you need one.
- It does NOT submit the invoices to ZATCA. Wire `singleInvoiceReportingOrClearanceStatus` after `issueSimplifiedTaxInvoice` to do that — see [`../../docs/single-vat.md`](../../docs/single-vat.md#submitting-to-zatca).

For the architectural rationale and certificate-handling guidance, see [`../../docs/multi-vat-saas.md`](../../docs/multi-vat-saas.md).
