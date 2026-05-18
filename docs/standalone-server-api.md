# Standalone server — HTTP API reference

Every route exposed by `@dokhna-tech/zatca-server`. Grouped by route file (see `packages/server/src/routes/`). All responses are `application/json` unless noted; all bodies are validated with Zod before they reach the handler.

- **Base URL**: `http://<host>:<port>` (defaults: `0.0.0.0:3000`).
- **Auth**: `admin` (server-side admin bearer), `tenant` (per-tenant issued bearer), or `public` (none). See [Authentication](#authentication) below.
- **Error envelope**: every non-2xx response uses the shape documented in [Error envelope](#error-envelope).
- **Idempotency**: mutating routes accept `Idempotency-Key`; see [Idempotency](#idempotency).

## Ops routes (public, rate-limit exempt)

Source: `routes/ops.ts`.

### GET /healthz

Liveness probe. Always returns 200; does not touch storage.

- **Response 200**: `{"status":"ok"}`

### GET /readyz

Readiness probe. Calls the tenant registry's `ping()`.

- **Response 200**: `{"status":"ready"}`
- **Response 503**: `{"status":"not-ready","reason":"backing-store-unavailable"}` — the underlying error is logged, never returned to the client.

### GET /metrics

Prometheus exposition (text format). Only registered when `ZATCA_SERVER_METRICS_ENABLED=true` (the default). Metric catalogue: see [`standalone-server-operations.md`](./standalone-server-operations.md#observability).

---

## Tenant management (admin bearer)

Source: `routes/admin-tenants.ts`. All routes require `Authorization: Bearer <admin-key>`.

### POST /v1/tenants

Register a new tenant. State after success: `created`. Mutation + audit-write share a transaction.

**Request body**:

```json
{
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
  "environment": "simulation",
  "label": "primary",
  "callbackUrl": "https://example.com/zatca-events"
}
```

- `tenantRef` (optional) — must match `/^[a-z0-9][a-z0-9-]{0,63}$/`. The server generates one if omitted.
- `branchIndustry`, `label`, `callbackUrl` are optional. `callbackUrl` is reserved for future webhook delivery — present today, unused.
- `environment` is one of `sandbox` | `simulation` | `production`.

**Response 201**: full `TenantRecord` JSON (state `created`, no secret material).

**Errors**: 400 (validation), 401 (admin auth), 409 (`ZatcaRegistryError` code `conflict` — duplicate `tenantRef`).

### GET /v1/tenants

List tenants. Filtering via query string.

**Query params** (all optional):

- `state` — `created` | `onboarding` | `production-ready` | `failed` | `revoked`
- `environment` — `sandbox` | `simulation` | `production`
- `expiringWithinDays` — positive integer; matches tenants whose production CSID expires within that window.
- `includeDeleted` — `true` | `false`. Default: false. Soft-deleted tenants are hidden by default.

**Response 200**: `{"tenants":[ TenantRecord, ... ]}`

### GET /v1/tenants/:ref

Fetch a single tenant.

- **Response 200**: `TenantRecord`
- **Response 404**: `{"error":{"name":"ZatcaRegistryError","message":"Unknown tenant 'acme'."}}`

### PATCH /v1/tenants/:ref

Update mutable metadata. The body must contain at least one of the listed fields.

**Request body** (all fields optional, but at least one required):

```json
{
  "vatName": "Acme Holdings Ltd.",
  "branchName": "Olaya Branch",
  "branchIndustry": "Retail",
  "location": { ... },
  "label": "primary",
  "callbackUrl": "https://example.com/zatca-events"
}
```

Immutable fields not accepted here: `tenantRef`, `vatNumber`, `egsUuid`, `environment`, `state`.

- **Response 200**: updated `TenantRecord`.
- **Errors**: 400 (validation, empty patch), 404 (unknown tenant).

### DELETE /v1/tenants/:ref

Soft delete. Sets `deletedAt` and revokes all API keys for the tenant in the same transaction.

- **Response 204**: no body.
- **Errors**: 404 (unknown tenant).

---

## API key management (admin bearer)

Source: `routes/admin-api-keys.ts`. All routes require admin bearer.

### POST /v1/tenants/:ref/api-keys

Issue a tenant bearer token. The plaintext is shown **once**.

**Request body**:

```json
{ "label": "pos-1" }
```

- `label` — string, 1–64 chars. Recorded for operator reference; not part of the token's auth.

**Response 201**:

```json
{
  "token": "zts_live_acme_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "tokenId": "k_2026...",
  "warning": "This token is shown only once. Store it securely."
}
```

The `zts_<env>_<tenantRef>_<32-base32url-chars>` token format encodes the tenant binding; the server scrypt-hashes the token after issuance and never re-emits the plaintext.

**Errors**: 400 (validation), 404 (unknown / soft-deleted tenant).

### GET /v1/tenants/:ref/api-keys

List key metadata (no plaintext). Defaults to active keys only.

**Query params**:

- `includeRevoked` — `true` to include revoked keys; default `false`.

**Response 200**: `{"keys":[{ tokenId, label, env, last4, createdAt, revokedAt? }, ...],"includeRevoked":false}`

**Errors**: 404 (unknown tenant).

### DELETE /v1/tenants/:ref/api-keys/:tokenId

Revoke one key. The `:tokenId` must belong to `:ref`.

- **Response 204**: no body.
- **Response 404**: `tokenId` not found, or doesn't belong to this tenant.

---

## Onboarding (admin bearer)

Source: `routes/admin-onboard.ts`. All routes require admin bearer. The onboarding routes (`/onboard`, `/credentials/rotate`) honor `Idempotency-Key`.

The two long-running routes extend the per-request socket timeout to `max(30s, ZATCA_SERVER_ONBOARDING_TIMEOUT_MS + 10s)`. They also share a global in-process semaphore (`ZATCA_SERVER_ONBOARDING_MAX_CONCURRENT`, default 4). Excess concurrent requests get 503 + `Retry-After: 30` with `{"error":{"name":"OnboardingThrottled", ...}}`.

### POST /v1/tenants/:ref/onboard

Run the full ZATCA onboarding handshake: keygen, CSR, OTP exchange, compliance scenarios, production CSID. On success the tenant transitions to `production-ready` and the credential vault is populated. Blocks for ~30–90s.

**Request body**:

```json
{
  "otp": "123456",
  "solutionName": "My Solution v1.0",
  "environment": "simulation"
}
```

- `otp` — 1–20 chars; a fresh OTP from the Fatoora portal.
- `solutionName` — 1–120 chars.
- `environment` — `sandbox` | `simulation`. Defaults to `simulation`. Production is not accepted here — the compliance pack only runs against the simulation gateway.

**Optional header**: `Idempotency-Key` (≤200 chars).

**Response 200**:

```json
{
  "tenantRef": "acme",
  "state": "production-ready",
  "complianceTestStatus": "passed",
  "productionCertificateExpiresAt": "2027-05-17T12:00:00Z",
  "productionRequestId": "..."
}
```

**Errors**:

| Status | Name | Cause |
|--------|------|-------|
| 400 | `ZatcaValidationError` | bad body |
| 401 | `ZatcaAuthError` | admin auth |
| 404 | `ZatcaRegistryError` | unknown tenant |
| 409 | `ZatcaServerError` | another onboarding for this tenant is in flight (lock held) |
| 409 | `IdempotencyConflict` | concurrent request with the same `Idempotency-Key` |
| 422 | `ZatcaOnboardingError` | compliance pack failed |
| 502 | `ZatcaApiError` | ZATCA upstream rejected (401/403 re-mapped to 502) |
| 503 | `OnboardingThrottled` | concurrency cap reached; `Retry-After: 30` |
| 503 | `ZatcaApiError` | ZATCA upstream 429; `Retry-After: 30` |

### POST /v1/tenants/:ref/credentials/rotate

Re-run the handshake for an already-onboarded tenant. Same body, timeout, idempotency, and error envelope as `/onboard`. The audit action is `tenant.credentialsRotated` (not `tenant.onboarded`).

**Response 200**:

```json
{
  "tenantRef": "acme",
  "state": "production-ready",
  "productionCertificateExpiresAt": "2027-05-17T12:00:00Z"
}
```

(No `complianceTestStatus` in the response.)

### GET /v1/tenants/:ref/status

Read the lifecycle state without unlocking or touching ZATCA.

**Response 200**:

```json
{
  "tenantRef": "acme",
  "state": "onboarding",
  "onboardingProgress": { "scenarios": { "scenario1": "passed", "scenario2": "pending" } },
  "claimedBy": "pod-7a3c",
  "claimExpiresAt": "2026-05-17T12:03:00Z",
  "productionCertificateExpiresAt": "2027-05-17T12:00:00Z"
}
```

**Errors**: 404 (unknown tenant).

### POST /v1/tenants/:ref/unlock

Release a stale onboarding claim — used when a previous `/onboard` died mid-flight and left the tenant pinned in `state="onboarding"`. The route is a no-op for any other state.

**Request body** (optional):

```json
{ "force": false }
```

- Without `force` (or with `force: false`) — only releases when the claim has already expired (or is absent). Returns 409 otherwise.
- With `force: true` — releases any active claim, regardless of expiry. The forced flag is audited.

Either way, the tenant transitions to `state: "failed"` so the operator's next step is an explicit `/onboard` retry.

**Response 200**: `{"tenantRef":"acme","state":"failed"}`

**Errors**: 404 (unknown tenant), 409 (active claim, no `force`).

---

## Invoices (tenant bearer)

Source: `routes/tenant-invoices.ts`. All routes require `Authorization: Bearer zts_<env>_<tenantRef>_<32chars>`.

The bearer's encoded `tenantRef` must match the path `:ref` — a mismatch yields **401** (not 403) so the response leaks no tenant-existence information. The tenant must be in `state: "production-ready"` and have signing material in the vault, else 400.

Mutating routes honor `Idempotency-Key` (≤200 chars).

### POST /v1/tenants/:ref/invoices

Issue (and optionally submit) an invoice. The persistence + signing + ZATCA submit happen in one call.

**Request body**:

```json
{
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
}
```

- `input` — a discriminated `InvoiceInput` validated by core's runtime guards. Shape varies by `kind` (`simplified-tax-invoice`, `standard-tax-invoice`, `simplified-credit-note`, etc.).
- `submit` — default `true`. Set to `false` to sign + persist locally without submitting to ZATCA.
- Phase-1 kinds (`phase1-invoice`, `phase1-credit-note`) with `submit: true` → 400.

**Response 200**:

```json
{
  "invoiceNumber": "202605000001",
  "sequence": 1,
  "invoiceHash": "base64...",
  "signedXml": "<?xml ...>",
  "qrCode": "base64-tlv-qr",
  "status": "accepted",
  "zatcaResponse": { ... }
}
```

`status` is `accepted` | `rejected` | `pending`. The `X-Zatca-Request-Id` response header is set when ZATCA returned one.

**Errors**: 400 (validation, phase-1 + submit, wrong state), 401 (tenant auth or tenant/path mismatch), 409 (`IdempotencyConflict`), 502/503 (ZATCA upstream).

### GET /v1/tenants/:ref/invoices/:invoiceId

Load a persisted invoice record from local storage. Does not call ZATCA.

- **Response 200**: the raw invoice record (signed XML, hash, sequence, ZATCA response, etc.).
- **Response 404**: invoice not found for this tenant.

### POST /v1/tenants/:ref/invoices/:invoiceId/cancel

Cancel a previously cleared standard invoice with ZATCA.

**Request body**:

```json
{
  "reason": "Customer return — full refund",
  "zatcaInvoiceId": "optional-override",
  "clearanceNumber": "optional-override"
}
```

- `reason` — 1–500 chars; surfaces in the ZATCA cancel call.
- `zatcaInvoiceId`, `clearanceNumber` — optional overrides. If omitted, the server falls back to the values stored on the local invoice record.

**Response 200**: `{"status":"cancelled","zatcaResponse": { ... }}`

**Errors**: 400 (no clearance number available, validation), 404 (unknown invoice), 502/503 (ZATCA upstream).

### GET /v1/tenants/:ref/invoices/:invoiceId/status

Check the ZATCA-side status of a previously submitted invoice.

**Query params** (optional, fall back to stored record):

- `zatcaInvoiceId`
- `clearanceNumber`

**Response 200**:

```json
{
  "localStatus": "accepted",
  "zatcaResponse": { ... }
}
```

**Errors**: 400 (no clearance number available), 404 (unknown invoice), 502/503 (ZATCA upstream).

### POST /v1/tenants/:ref/invoices/:invoiceId/check-compliance

Run a ZATCA compliance check against the stored signed XML.

- No body.
- **Response 200**: raw ZATCA compliance result.
- **Errors**: 404 (unknown invoice), 502/503 (ZATCA upstream).

---

## Authentication

Two token kinds. Both go in `Authorization: Bearer <token>` (scheme is case-insensitive).

### Admin keys

- Configured via `ZATCA_SERVER_ADMIN_KEYS` as a comma-separated `label:key` ring. Min 32 chars per key.
- Verification compares the candidate against every entry in constant time (`timingSafeEqual` over SHA-256 digests) — no early exit, no length leak.
- The matched `label` is written to every audit row produced by that request, for attribution.

### Tenant bearer tokens

- Issued via `POST /v1/tenants/:ref/api-keys`. Format: `zts_<env>_<tenantRef>_<32 base32url chars>` — 160-bit entropy.
- Stored as scrypt(hash, salt). The plaintext is shown **only once** at issue time and never recoverable.
- Verification: scrypt hash-check, then the encoded `tenantRef` must equal the URL `:ref` — mismatch returns 401, not 403.

### Rate limiting

`@fastify/rate-limit` is registered globally with a default cap of 200 req/min/IP (`ZATCA_SERVER_RATE_LIMIT_PER_MINUTE`). Keyed on `req.ip` — so set `ZATCA_SERVER_TRUST_PROXY=true` only when behind a trusted proxy. Cap responses are 429 via the standard error envelope. `/healthz`, `/readyz`, and `/metrics` are exempt.

---

## Error envelope

Every non-2xx response shares this shape:

```json
{
  "error": {
    "name": "ZatcaValidationError",
    "message": "Invalid request body: location.cityName must be at least 1 chars"
  }
}
```

Three optional fields appear only on upstream-ZATCA errors (`ZatcaApiError`):

```json
{
  "error": {
    "name": "ZatcaApiError",
    "message": "...",
    "upstreamStatus": 400,
    "zatcaRequestId": "req-...",
    "validationResults": { ... }
  }
}
```

Status mapping (`packages/server/src/middleware/errors.ts:68`):

| Error class | HTTP status |
|-------------|-------------|
| `ZatcaAuthError` | 401 or 403 (from the throw site's `statusHint`) |
| `ZatcaValidationError` | 400 |
| `ZatcaRegistryError` code `not_found` | 404 |
| `ZatcaRegistryError` code `conflict` | 409 |
| `ZatcaRegistryError` code `invalid` | 400 |
| `ZatcaOnboardingError` | 422 |
| `ZatcaApiError` upstream 401/403 | **502** (re-mapped) |
| `ZatcaApiError` upstream 429 | **503** + `Retry-After: 30` |
| `ZatcaApiError` other 4xx/5xx | upstream code passed through |
| `ZatcaServerError` with `statusHint` | `statusHint` value |
| `ZatcaCipherError`, `ZatcaAuditError`, `ZatcaSigningError`, `ZatcaCertificateError`, `ZatcaStorageError` | 500 |
| Plain `Error` with `.statusCode` 4xx/5xx | that code (e.g. 429 from `@fastify/rate-limit`) |
| Everything else | 500 |

Why the re-mapping of ZATCA's 401/403/429: ZATCA's 401/403 means the *server's* stored credentials are revoked or expired — not the client's bearer; passing it through would mislead callers. ZATCA's 429 is downstream backpressure, not a per-caller rate limit. The upstream code survives inside `error.upstreamStatus` for debugging.

Two special envelopes:

- **`IdempotencyConflict`** — 409 + `Retry-After: 30`. An in-flight request with the same `Idempotency-Key` is still running.
- **`OnboardingThrottled`** — 503 + `Retry-After: 30`. The in-process onboarding semaphore is at capacity.

---

## Idempotency

Mutating routes accept an `Idempotency-Key` request header (≤200 chars). Semantics:

- **First call** with a given key — the work runs. The response is cached for `ZATCA_SERVER_IDEMPOTENCY_WINDOW_MS` (default 24 h).
- **Replay** of the same key after the first call committed — the cached response is replayed verbatim, with `x-idempotent-replay: true` set on the response headers.
- **Concurrent call** with a key that's still in-flight — 409 + `Retry-After: 30` and `{"error":{"name":"IdempotencyConflict", ...}}`.
- **Multi-replica caveat** — the default `IdempotencyStore` is in-memory and per-process. Cross-replica replay protection requires a shared store (e.g. Redis-backed) passed to `buildApp` as `options.idempotencyStore`. See [`standalone-server-operations.md`](./standalone-server-operations.md#multi-replica-caveats).

The `Idempotency-Key` is your responsibility to choose — typically a UUID per logical operation. Reusing a key across semantically-different requests yields a stale response on the second call.

---

## Response headers worth knowing

- `X-Zatca-Request-Id` — set on invoice issuance when ZATCA returned a request ID, and on every `ZatcaApiError` response. Cite it in any ZATCA support ticket.
- `x-idempotent-replay: true` — set when the response was served from the idempotency cache.
- `Retry-After: 30` — set on 503 (`OnboardingThrottled`, ZATCA 429) and 409 (`IdempotencyConflict`).
