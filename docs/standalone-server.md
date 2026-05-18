# Standalone server deployment

You want a turnkey HTTP service that handles ZATCA onboarding, credential storage, and invoice issuance for one or many tenants — not a library you embed in your own backend. `@dokhna-tech/zatca-server` ships as a Docker image you point at MongoDB or PostgreSQL and call over HTTP. Tenant onboarding, an encrypted credential vault, an append-only audit log, and Prometheus `/metrics` are wired up out of the box.

## When to choose this

Pick the standalone server when any of the following hold:

- Your back-office is not Node, or you don't want a Node dependency on the issuance path.
- You want a single HTTP surface in front of multi-tenant ZATCA traffic, not the SDK embedded in every service that needs to issue.
- You want hard isolation between POS / back-office and the code holding production private keys.
- You want Docker-native ops: one image, env-var config, `/healthz` + `/readyz` + `/metrics`, no app to maintain.

If instead you want the SDK embedded directly in your Node service, see [`single-vat.md`](./single-vat.md) (one VAT registration) or [`multi-vat-saas.md`](./multi-vat-saas.md) (SaaS with many tenants on one runtime).

## What you get

- **HTTP API** — admin routes (tenant CRUD, API-key issuance, onboarding, status, unlock) plus tenant-scoped routes for invoice issue / cancel / status / compliance-check. Full reference: [`standalone-server-api.md`](./standalone-server-api.md).
- **Encrypted credential vault** — AES-256-GCM, per-envelope key ID for zero-downtime rotation. Private keys, production binary security tokens, production API secrets, and the compliance-* variants are never returned over the API after onboarding.
- **Append-only audit log** — every mutation (`tenant.created`, `invoice.issued`, `apiKey.revoked`, etc.) is written in the same transaction as the mutation it describes.
- **Prometheus metrics** — invoice counts by kind/status, onboarding outcomes, active-tenant gauge, production-cert expiry per tenant, HTTP request duration histogram.
- **Storage**: MongoDB (1-node replica set required for transactions) or PostgreSQL.
- **Rate limiting**, **idempotency**, **health/readiness probes**, **structured Pino logging** with a secret-redaction list.

Full operations details, including env-var reference and multi-replica caveats: [`standalone-server-operations.md`](./standalone-server-operations.md).

## Quick start

The three required env vars are the admin key ring, the master-key ring (for the vault), and the storage driver. Everything else is optional with sensible defaults.

```bash
# 1. Generate the secrets
ADMIN_KEY="ops:$(openssl rand -base64 48 | tr -d '=' | head -c 48)"
MASTER_KEY="v1:$(openssl rand -base64 32)"

# 2. Boot the server against an in-memory store (dev only — data is lost on restart)
docker run --rm -p 3000:3000 \
  -e ZATCA_SERVER_ADMIN_KEYS="$ADMIN_KEY" \
  -e ZATCA_SERVER_MASTER_KEYS="$MASTER_KEY" \
  -e ZATCA_SERVER_ACTIVE_KID="v1" \
  -e STORAGE_DRIVER="memory" \
  ghcr.io/dokhna/zatca-server:latest
```

For a runnable docker-compose stack with Mongo or Postgres, see [`examples/standalone-server/`](../examples/standalone-server/) — it has end-to-end curl examples for register → onboard → issue → audit.

## Generating the admin + master keys

Two different formats, both comma-separated rings:

| Variable | Format | Notes |
|----------|--------|-------|
| `ZATCA_SERVER_ADMIN_KEYS` | `label:key[,label:key,...]` | Min 32 chars per key. `label` is recorded in audit rows so you can attribute admin actions. Duplicate labels rejected at boot. |
| `ZATCA_SERVER_MASTER_KEYS` | `kid:<base64-32-bytes>[,kid:<base64-32-bytes>,...]` | 32 raw bytes (44 base64 chars). The `kid` identifies the key in stored ciphertext envelopes. |
| `ZATCA_SERVER_ACTIVE_KID` | a `kid` from the ring | Which key encrypts *new* writes. Defaults to the last entry. Decryption picks the key by the envelope's `kid`. |

One-liners:

```bash
echo "ZATCA_SERVER_ADMIN_KEYS=ops:$(openssl rand -base64 48 | tr -d '=' | head -c 48)" >> .env
echo "ZATCA_SERVER_MASTER_KEYS=v1:$(openssl rand -base64 32)" >> .env
echo "ZATCA_SERVER_ACTIVE_KID=v1" >> .env
```

Rotation procedure (add → flip → re-encrypt → drop) is in [`standalone-server-operations.md`](./standalone-server-operations.md#credential-vault--kid-rotation).

## First request

Probe the process is up:

```bash
curl -i http://localhost:3000/healthz  # → 200 {"status":"ok"}
curl -i http://localhost:3000/readyz   # → 200 {"status":"ready"} (or 503 if storage is down)
```

Register a tenant (admin bearer required):

```bash
ADMIN_BEARER="$(echo "$ADMIN_KEY" | cut -d: -f2)"

curl -X POST http://localhost:3000/v1/tenants \
  -H "Authorization: Bearer $ADMIN_BEARER" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantRef": "acme",
    "vatNumber": "301234567890003",
    "egsUuid": "00000000-0000-4000-8000-000000000001",
    "vatName": "Acme Trading Co.",
    "crn": "1010010101",
    "branchName": "Riyadh HQ",
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

Returns a 201 with the new `TenantRecord` at `state: "created"`. The next step is to call `POST /v1/tenants/acme/onboard` with an OTP from the Fatoora portal — that runs the six-scenario compliance pack and transitions the tenant to `production-ready`. The full walkthrough is in the example folder; the route-level reference is in [`standalone-server-api.md`](./standalone-server-api.md#post-v1tenantsrefonboard).

## Library mode (advanced)

The package isn't only a Docker artifact. `@dokhna-tech/zatca-server` re-exports `buildApp` and every internal factory (auth verifiers, audit log, cipher, route registrars). You can mount the routes inside an existing Fastify app instead of running the image:

```ts
import { buildApp, loadConfig, registerAllRoutes } from "@dokhna-tech/zatca-server";

const config = loadConfig(process.env);
const app = await buildApp({ config, /* registry, auditLog, cipher, ... */ });
await app.listen({ port: 3000 });
```

This is for teams that have an existing Fastify ingress and want to add the ZATCA routes without a second process. Storage adapters, the audit log impl, and the cipher are all injected — you can swap any of them. The `cli.ts` entrypoint is a thin wrapper that wires `buildApp` to env-driven defaults.

## Where next

- [HTTP API reference](./standalone-server-api.md) — every route, body schema, error envelope, idempotency semantics.
- [Operations](./standalone-server-operations.md) — full env-var table, storage driver matrix, vault rotation, audit retention, metric catalogue, multi-replica caveats, production checklist.
- [`examples/standalone-server/`](../examples/standalone-server/) — runnable docker-compose stacks (Mongo + Postgres) with an end-to-end curl walkthrough.
- [`troubleshooting.md`](./troubleshooting.md) — OpenSSL CLI dependency, ZATCA error codes, onboarding timeouts.
- [`security.md`](./security.md) — secret handling, certificate rotation, what the library logs.
