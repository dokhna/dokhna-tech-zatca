# Multi-VAT SaaS deployment

You operate a SaaS that issues invoices on behalf of many Saudi VAT registrants. Each tenant has its own VAT number, EGS UUID, certificate, private key, hash chain, and invoice counter. This page covers the topology.

## Topology

- One `StorageAdapter` instance per process — the adapter scopes everything by `TenantScope`.
- Per-tenant secret bundle: `{ privateKey, productionCertificate, productionBinarySecurityToken, productionApiSecret }` resolved from your secret store on the request path.
- Per-tenant `EGSUnitInfo` resolved from your tenants collection.
- Per-tenant `TenantScope = { vatNumber, egsUuid }` derived from request context.

## The TenantScope pattern

Every storage call accepts a `TenantScope`. The adapter uses it to:

- Increment the counter atomically for that tenant only.
- Read the previous hash for that tenant's chain only.
- Persist the issued record namespaced by that tenant.

```ts
import type { TenantScope } from "@dokhna-tach/zatca";

function tenantScopeFromRequest(req: { headers: Record<string, string> }): TenantScope {
  const tenantId = req.headers["x-tenant-id"];
  if (!tenantId) throw new Error("missing X-Tenant-ID header");
  const tenant = lookupTenantFromDb(tenantId);
  return { vatNumber: tenant.vatNumber, egsUuid: tenant.egsUuid };
}
```

The full Fastify wire-up is in [`examples/multi-vat-saas/`](../examples/multi-vat-saas/).

## Certificate and key isolation

The library never holds onto a private key. It accepts `signing: { certificate, privateKey }` as a function argument to every `issue*` call, so leakage across tenants is structurally prevented as long as your resolver is correct.

Per-tenant secret resolution looks like:

```ts
async function resolveTenantSecrets(scope: TenantScope): Promise<{
  certificate: string;
  privateKey: string;
  binarySecurityToken: string;
  apiSecret: string;
}> {
  // pull from KMS / Secrets Manager / Vault, keyed by `${vatNumber}:${egsUuid}`
  return await secretStore.get(`zatca:${scope.vatNumber}:${scope.egsUuid}`);
}
```

A short-lived in-memory cache (`Map<scopeKey, { value, expiresAt }>`) keeps the hot path fast without leaving plaintext on disk.

## Per-tenant counter and hash chain isolation

The reference Mongo / Postgres / in-memory adapters key both counters and invoices on `(vatNumber, egsUuid)`. Two tenants racing on `incrementCounter` get independent sequences. Two tenants racing on `recordInvoice` write to disjoint hash chains.

Stress-tested in CI: 3 tenants × 100 concurrent issuances each on the in-memory adapter, 3 × 25 on Mongo and Postgres. See the conformance test suite in `packages/core/src/test-helpers/`.

## Encryption at rest

`OnboardingResult` contains three secret fields:

- `privateKey` — PEM ECDSA private key.
- `complianceApiSecret`.
- `productionApiSecret`.

Persist them encrypted:

- Use your platform's KMS to wrap the values (envelope encryption).
- Keep the wrapped ciphertext + the data key id in your tenant row.
- On the request path, fetch the wrapped value and unwrap in-process.

The two `binarySecurityToken` fields and the two certificate PEMs are not secret in the cryptographic sense (the certificate is public; the BST is the base64-stripped PEM body that ZATCA's gateway accepts as authentication material), but they identify the tenant — keep them in your normal database with the same access controls as any tenant identifier. See [security.md](./security.md#secret-classification).

## Onboarding new tenants

`onboard()` orchestrates the full flow: key generation, CSR, compliance certificate, six-scenario compliance test pack, production CSID. It returns the full bundle in one call.

The recommended SaaS pattern is to run `onboard()` from a tenant-admin worker (out-of-band of the request path) and store the result. The hot path on `POST /invoices` then only:

1. Resolves the tenant.
2. Fetches the cached, decrypted bundle.
3. Calls `issueSimplifiedTaxInvoice` (or peer).

`onboard()` itself fails fast against `environment: "production"` — only simulation / sandbox is supported, because the six embedded compliance test invoices must round-trip a non-prod gateway. See [onboarding.md](./onboarding.md).

## Headers, observability, and trust

- The package does no logging on its own. The `debug` module is wired through `zatca:storage:mongo` / `zatca:storage:postgres` / `zatca:storage:memory` namespaces; nothing in core writes to the console.
- The HTTP client retries idempotent ZATCA calls with backoff. You can override via `httpClientOptions.retries` per call.
- Errors are typed: `ZatcaApiError`, `ZatcaValidationError`, `ZatcaStorageError`, `ZatcaOnboardingError`. Catch by class, never by string.

## What about EGS-per-branch?

In ZATCA's model one VAT can have many EGSes (one per cash register / POS / billing endpoint). The TenantScope is `(vatNumber, egsUuid)` — not just `vatNumber` — so the multi-EGS case is the same code path as multi-VAT. Map each branch / register to its own EGS UUID and pass the right scope on the request.
