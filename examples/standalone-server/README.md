# standalone-server

End-to-end walkthrough of `@dokhna-tech/zatca-server` — the standalone, multi-tenant ZATCA service shipping as a Docker image. Brings up the server + your choice of MongoDB or PostgreSQL, then walks through onboarding a tenant and issuing an invoice via curl.

## Quick start

```bash
cp .env.example .env
# Edit .env: fill in ZATCA_SERVER_ADMIN_KEYS + ZATCA_SERVER_MASTER_KEYS.

# Generate the secrets quickly:
echo "ZATCA_SERVER_ADMIN_KEYS=ops:$(openssl rand -base64 48 | tr -d '=' | head -c 48)" >> .env
echo "ZATCA_SERVER_MASTER_KEYS=v1:$(openssl rand -base64 32)" >> .env
echo "ZATCA_SERVER_ACTIVE_KID=v1" >> .env

# Boot — pick mongo or postgres:
docker compose -f docker-compose.mongo.yml up --build
# OR
docker compose -f docker-compose.postgres.yml up --build
```

The server listens on `http://localhost:3000` once boot completes. `/healthz` returns 200; `/metrics` exposes Prometheus output.

## Walkthrough

Export the admin key once so the curl examples stay readable:

```bash
ADMIN_KEY=$(grep '^ZATCA_SERVER_ADMIN_KEYS=' .env | cut -d= -f2- | cut -d: -f2)
```

### 1. Register a tenant

```bash
curl -X POST http://localhost:3000/v1/tenants \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantRef": "acme",
    "vatNumber": "301234567890003",
    "egsUuid": "00000000-0000-4000-8000-000000000001",
    "vatName": "Acme Trading Co.",
    "crn": "1010010101",
    "branchName": "Riyadh HQ",
    "branchIndustry": "Retail",
    "location": {
      "cityName": "Riyadh",
      "citySubdivision": "Olaya",
      "street": "King Fahd Rd",
      "plotIdentification": "1234",
      "building": "5678",
      "postalZone": "12345"
    },
    "environment": "simulation"
  }'
```

Returns the new `TenantRecord` at state `created`.

### 2. Onboard against the Fatoora simulation portal

Get an OTP from the Fatoora portal, then:

```bash
curl -X POST http://localhost:3000/v1/tenants/acme/onboard \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "otp": "123456",
    "solutionName": "My Solution v1.0",
    "environment": "simulation"
  }'
```

The request blocks for ~30–90s while the six-scenario compliance pack runs against ZATCA. Watch progress via:

```bash
curl http://localhost:3000/v1/tenants/acme/status \
  -H "Authorization: Bearer $ADMIN_KEY"
```

Successful response transitions the tenant to `production-ready` and surfaces `productionCertificateExpiresAt`. The secret material is now encrypted in the credential vault — never returned over the API.

> **Important**: the onboarding route has a 180-second read timeout by default. If you're behind a proxy with a shorter timeout, the route may appear to fail while the backend completes successfully — poll `/status` after a disconnect.

### 3. Issue an API key for the tenant

```bash
curl -X POST http://localhost:3000/v1/tenants/acme/api-keys \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "label": "pos-1" }'
```

Returns:

```json
{
  "token": "zts_live_acme_<32 base32 chars>",
  "tokenId": "<opaque id>",
  "warning": "This token is shown only once. Store it securely."
}
```

The token is your tenant's bearer for invoice routes — store it in your back-office secret manager. The server never re-emits it.

### 4. Issue an invoice

```bash
TENANT_KEY="zts_live_acme_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

curl -X POST http://localhost:3000/v1/tenants/acme/invoices \
  -H "Authorization: Bearer $TENANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "kind": "simplified-tax-invoice",
      "issueDate": "2026-05-17",
      "issueTime": "12:00:00",
      "buyerName": "Walk-in",
      "lineItems": [
        { "id": "1", "name": "Latte 250ml", "quantity": 1, "taxExclusivePrice": 12, "vatPercent": 15 }
      ]
    },
    "submit": true
  }'
```

Response includes the signed XML, the QR code, the local sequence + invoice number, and ZATCA's clearance / reporting response. `X-Zatca-Request-Id` is in the response headers for support-ticket reference.

### 5. Audit + observability

The audit log records every mutation. To inspect it directly via MongoDB shell (or `psql`):

```bash
# Mongo
docker exec -it zatca-server-mongo mongosh zatca \
  --eval 'db.zatca_server_audit_log.find({tenantRef: "acme"}).sort({at: -1}).pretty()'

# Postgres
docker exec -it zatca-server-postgres psql -U zatca zatca \
  -c "SELECT at, action, result FROM zatca_server_audit_log WHERE tenant_ref = 'acme' ORDER BY at DESC;"
```

Prometheus metrics at `http://localhost:3000/metrics`:

```
zatca_invoices_issued_total{tenant="acme",kind="simplified-tax-invoice",status="accepted"}
zatca_onboarding_total{outcome="succeeded"}
zatca_http_request_duration_seconds_bucket{...}
```

## Layout

```
.
├── docker-compose.mongo.yml      # Mongo + 1-node replica set + server
├── docker-compose.postgres.yml   # Postgres + migrations runner + server
├── .env.example                  # Required env vars
├── onboard-and-issue.http        # VS Code REST Client request collection
└── README.md
```

## Caveats

- **Mongo replica set**: the audit log writes use multi-document transactions. The Mongo compose file boots a 1-node replica set (`rs0`) for that reason — a standalone `mongod` would refuse session creation.
- **OpenSSL CLI**: the server's onboarding path shells out to `openssl` for keygen + CSR. The Docker image (`node:20-slim`) ships it; if you run the CLI directly outside Docker, `openssl` must be on `PATH`.
- **Asia/Riyadh by default**: every container env is pinned to `Asia/Riyadh` (`ZATCA_SERVER_TZ`); override if your audit retention policy requires UTC.
- **Production checklist**: bind `/healthz`, `/readyz`, and `/metrics` to an internal-only network; terminate TLS at your ingress; load `ZATCA_SERVER_ADMIN_KEYS` + `ZATCA_SERVER_MASTER_KEYS` from your secret manager, not from `.env`.
