# Standalone server — operations

For operators running `@dokhna-tech/zatca-server` in production. Covers configuration, storage, the credential vault, the audit log, observability, rate limiting, multi-replica gotchas, and a launch checklist.

For the HTTP surface this server exposes, see [`standalone-server-api.md`](./standalone-server-api.md). For when to choose it at all, see [`standalone-server.md`](./standalone-server.md).

## Configuration (env vars)

All config is loaded from `process.env` at boot. There is no `.env` file loader — supply env vars via Docker `--env-file`, Kubernetes `Secret`, systemd `EnvironmentFile`, or your secret manager's mount. Misconfiguration fails fast at boot with a precise reason.

| Variable | Type | Default | Required | Meaning |
|----------|------|---------|----------|---------|
| `ZATCA_SERVER_ADMIN_KEYS` | string | — | **yes** | `label:key[,label:key,...]`. Min 32-char keys. Duplicate labels rejected. |
| `ZATCA_SERVER_MASTER_KEYS` | string | — | **yes** | `kid:base64-32-bytes[,kid:base64-32-bytes,...]`. Vault encryption key ring. |
| `ZATCA_SERVER_ACTIVE_KID` | string | last `kid` in the ring | no | Which kid encrypts new writes. Must be present in the ring. |
| `ZATCA_SERVER_HOST` | string | `0.0.0.0` | no | Bind host. |
| `ZATCA_SERVER_PORT` | integer 1-65535 | `3000` | no | Bind port. |
| `ZATCA_SERVER_TZ` | string | `Asia/Riyadh` | no | Time zone for log timestamps and audit rows. Sets `process.env.TZ` at boot. |
| `ZATCA_SERVER_TENANT_BEARER_ENV` | `live` \| `test` | `live` | no | Environment prefix encoded in issued tenant bearers. |
| `ZATCA_SERVER_ONBOARDING_TIMEOUT_MS` | integer ms > 0 | `180000` (3 min) | no | Per-request socket timeout for `/onboard` + `/credentials/rotate`. Also the per-tenant lock TTL. |
| `ZATCA_SERVER_IDEMPOTENCY_WINDOW_MS` | integer ms > 0 | `86400000` (24 h) | no | Idempotency-key replay window. |
| `ZATCA_SERVER_ONBOARDING_MAX_CONCURRENT` | integer > 0 | `4` | no | Max in-flight `/onboard` + `/credentials/rotate` requests per process. Excess → 503 + `Retry-After: 30`. |
| `ZATCA_SERVER_INSTANCE_ID` | string | `$HOSTNAME` or `instance-0` | no | Identity recorded on per-tenant onboarding locks. Make unique per replica. |
| `ZATCA_SERVER_METRICS_ENABLED` | `true` \| `false` | `true` | no | Whether `/metrics` is registered. |
| `ZATCA_SERVER_LOG_LEVEL` | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent` | `info` | no | Pino log level. `silent` disables logging entirely. |
| `ZATCA_SERVER_TRUST_PROXY` | `true` \| `false` | `false` | no | Trust `X-Forwarded-*` from upstream. Set `true` ONLY behind a trusted reverse proxy. |
| `ZATCA_SERVER_RATE_LIMIT_PER_MINUTE` | integer > 0 | `200` | no | Global per-IP cap. `/healthz`+`/readyz`+`/metrics` are exempt. |
| `STORAGE_DRIVER` | `memory` \| `mongo` \| `postgres` | `memory` | no | Storage backend. |
| `MONGO_URI` | string | — | when `STORAGE_DRIVER=mongo` | MongoDB connection string. Must point at a replica set. |
| `DATABASE_URL` | string | — | when `STORAGE_DRIVER=postgres` | PostgreSQL connection string. |

`masterKeys`, `activeKid`, and `adminKeysRaw` are stripped from the route-handler-facing config after boot so a stray `log.info({ config })` from a route cannot leak them.

## Storage drivers

| Driver | Peer dependency | Transactions | Notes |
|--------|----------------|--------------|-------|
| `memory` | `@dokhna-tech/zatca-storage-memory` (bundled) | n/a | Dev / tests only. No persistence; data is lost on restart. |
| `mongo` | `@dokhna-tech/zatca-storage-mongo`, `mongoose>=9` | pass-through (no real UoW) | Requires a replica set — even single-node — because the audit log writes use multi-document transactions. |
| `postgres` | `@dokhna-tech/zatca-storage-postgres`, `pg>=8` | real transactions (`withPgTransaction`) | Recommended for production. |

**Migrations are not auto-applied**. The CLI does not run them. For Postgres, apply `packages/server/migrations/postgres/001_initial.sql` out-of-band before booting (e.g. via a one-shot `psql` job in your compose / k8s manifest). The Mongo backend uses Mongoose models so the collections are created lazily on first write — but you still need a replica set for transactions.

## Admin key management

Format: `ZATCA_SERVER_ADMIN_KEYS=ops:<key>,deploy:<key>,...`

- Each `key` is min 32 chars. Anything shorter is rejected at boot.
- Each `label` must be unique within the ring. Duplicate labels are a boot error.
- The matched label is recorded on every audit row produced by that request, so `ops` vs `deploy` vs `incident-2026-04` is queryable forever.
- Verification uses a constant-time compare across **all** entries — no early exit — so the response time does not leak which key matched.

**Rotation** (zero downtime):

1. Generate a new key and add it to the ring under a new label: `ZATCA_SERVER_ADMIN_KEYS=current:<old>,next:<new>` and restart the replicas.
2. Migrate every caller to the new key.
3. Drop the old entry: `ZATCA_SERVER_ADMIN_KEYS=next:<new>` and restart.

## Credential vault + KID rotation

Source: `packages/server/src/crypto/`.

- Algorithm: **AES-256-GCM**. 12-byte random IV per encrypt, 16-byte auth tag.
- Each ciphertext stored as an envelope: `{kid, alg:"aes-256-gcm", iv, ct, tag}` (base64 fields).
- Encryption always uses the key referenced by `ZATCA_SERVER_ACTIVE_KID`. Decryption picks the key by the envelope's `kid` — so old rows still decrypt after the active kid changes.
- Birthday bound: ~2^32 messages per key under random IVs. For ZATCA workloads (one tenant onboarding = a handful of writes; tens of millions of invoice writes are unencrypted operational data), rotation is driven by policy, not by counter.

**Rotation procedure** (zero downtime):

1. Add a new entry to the ring: `ZATCA_SERVER_MASTER_KEYS=v1:<old>,v2:<new>`. Keep `ZATCA_SERVER_ACTIVE_KID=v1`. Restart. Now every replica can decrypt under either kid.
2. Flip `ZATCA_SERVER_ACTIVE_KID=v2` and restart. New writes encrypt under `v2`; existing `v1` rows still decrypt.
3. Re-encrypt old rows in a background pass (read row → vault.put under `v2` → audit). Out of scope for this server — operator-owned.
4. Once nothing references `v1`, drop it from the ring: `ZATCA_SERVER_MASTER_KEYS=v2:<new>`. Restart.

### What's encrypted

Every field in `EncryptedSignerMaterial` (`packages/server/src/crypto/credential-vault.ts`):

- `privateKey`
- `productionCertificate`, `productionBinarySecurityToken`, `productionApiSecret`
- `complianceCertificate?`, `complianceBinarySecurityToken?`, `complianceApiSecret?` (kept around for re-validation flows)

Each field is one JSONB column per envelope on Postgres, one BSON document per envelope on Mongo. Plaintext is held only in memory during onboarding and signing.

## Audit log

- Table / collection: `zatca_server_audit_log`.
- Append-only contract: no row is ever updated or deleted by the application.
- Mutation + audit-write share a single transaction (Postgres) or session (Mongo replica set), so a failure on either side rolls back the other.

**Schema** (`packages/server/src/audit/log.ts`):

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUID | Assigned per write. |
| `at` | timestamp | Server clock. |
| `actor` | JSON | `{type:"admin",label}` \| `{type:"tenant",tenantRef,tokenId}` \| `{type:"system"}` |
| `actor_type` | text | Denormalized for index filtering (CHECK in `admin`, `tenant`, `system`). |
| `tenantRef` | text? | Nullable — system entries have none. |
| `action` | enum (below) | Closed set. |
| `targetId` | text? | e.g. token ID, tenant ref. |
| `result` | `ok` \| `error` | Errors are written too, so failed mutations are auditable. |
| `zatcaRequestId` | text? | ZATCA gateway request ID, when present. |
| `requestId` | text? | Server request ID. |
| `payload` | JSON? | Pre-redacted by `redactSecrets`, then size-capped. |

**Recorded actions** (`packages/server/src/audit/log.ts:38-51`):

`tenant.created`, `tenant.patched`, `tenant.softDeleted`, `tenant.onboarded`, `tenant.credentialsRotated`, `tenant.unlocked`, `tenant.stateTransitioned`, `invoice.issued`, `invoice.cancelled`, `invoice.statusChecked`, `invoice.complianceChecked`, `apiKey.issued`, `apiKey.revoked`.

**Payload safety**:

- Callers must hand `payload` to `redactSecrets` before `write` — the log doesn't introspect the blob.
- The redacted payload is then size-capped by `capAuditPayload` so a malicious admin can't DoS the audit table with a multi-MB body.

**Retention**: none enforced by this package. There is no FK from `audit_log` to `tenants` — audit rows outlive soft-deleted tenants by design. Retention (purge / archive) is operator-owned; the Saudi tax record period is the floor.

### Querying the audit log directly

```bash
# Mongo
docker exec -it zatca-server-mongo mongosh zatca --eval \
  'db.zatca_server_audit_log.find({tenantRef: "acme"}).sort({at: -1}).limit(20).pretty()'

# Postgres
docker exec -it zatca-server-postgres psql -U zatca zatca -c \
  "SELECT at, actor_type, action, result FROM zatca_server_audit_log
   WHERE tenant_ref = 'acme' ORDER BY at DESC LIMIT 20;"
```

## Observability

### Prometheus metrics (`packages/server/src/observability/metrics.ts`)

All names prefixed `zatca_`. Served at `GET /metrics` when `ZATCA_SERVER_METRICS_ENABLED=true` (default).

| Metric | Type | Labels |
|--------|------|--------|
| `zatca_invoices_issued_total` | counter | `kind`, `status` |
| `zatca_invoices_cancelled_total` | counter | `result` (`ok` or `error`) |
| `zatca_onboarding_total` | counter | `outcome` (`succeeded`, `failed`, `locked`) |
| `zatca_active_tenants` | gauge | — |
| `zatca_production_cert_expiry_seconds` | gauge | `tenant` |
| `zatca_http_requests_total` | counter | `method`, `route`, `status` |
| `zatca_http_request_duration_seconds` | histogram | `method`, `route` (buckets 5 ms – 10 s) |

Plus the standard Node.js process metrics from `collectDefaultMetrics`, all prefixed `zatca_`.

`zatca_active_tenants` and the `zatca_production_cert_expiry_seconds` gauges are refreshed at boot and then hourly. The interval timer is `unref`ed so it doesn't keep the process alive at shutdown.

Note: `zatca_invoices_issued_total` deliberately has no `tenant` label — high-cardinality labels would explode the metric store for SaaS use cases.

### Health vs readiness

- `GET /healthz` — always 200. Use for "is the process alive" probes. Does not touch storage.
- `GET /readyz` — pings the tenant registry. 200 when healthy, 503 with `{"reason":"backing-store-unavailable"}` when not. Use this as the load-balancer readiness probe.

### Structured logging

- Pino, JSON in `NODE_ENV=production`, pino-pretty in development.
- 4xx auth errors logged at `warn`; 5xx at `error`. 2xx at `info`.
- **Redact list** (`packages/server/src/observability/logger.ts`): `authorization` header, `otp`, `privateKey`, `apiSecret`, `binarySecurityToken`, `masterKeys`, `adminKeysRaw`, `password`, `secret`, `token`, `bearer`, plus wildcards (e.g. `*.privateKey`). If you add a field that holds secret material, extend the redact list in the same change.

## Rate limiting

- `@fastify/rate-limit` registered globally.
- Default cap: 200 req/min/IP (`ZATCA_SERVER_RATE_LIMIT_PER_MINUTE`).
- Keyed on `req.ip`. With `ZATCA_SERVER_TRUST_PROXY=false` (the default) that's the socket peer — fine for direct exposure. With `trustProxy=true` it's the leftmost `X-Forwarded-For` entry, which is spoofable unless your ingress strips the header.
- Exempt: `/healthz`, `/readyz`, `/metrics`.
- Over-cap responses: 429 via the standard error envelope (`{"error":{"name":"InternalServerError","message":...}}`).
- Intent: a coarse wire-layer cap. Run a real WAF / ingress limiter (nginx, Cloudflare) in front for production traffic shaping.

## Multi-replica caveats

The server is horizontally scalable, but three pieces of state are per-process:

1. **Onboarding semaphore** (`ZATCA_SERVER_ONBOARDING_MAX_CONCURRENT`, default 4). Effective concurrency = replicas × this value. Don't set per-replica too high — every in-flight onboarding pins a DB connection and a ZATCA outbound socket for up to 3 minutes.

2. **Idempotency store** is in-memory by default. Replay protection is *per replica*. To get cross-replica idempotency, pass a shared `IdempotencyStore` (e.g. Redis-backed) to `buildApp` as `options.idempotencyStore` when running in library mode. The standalone CLI does not currently let you wire one in via env vars — that's a known gap for true multi-replica deployments.

3. **`ZATCA_SERVER_INSTANCE_ID`** defaults to `$HOSTNAME`. In Kubernetes (`Deployment` with pod-template hashes) that's already unique. In bare-Docker-compose-with-replicas setups, set it explicitly per replica so the per-tenant onboarding lock's `claimedBy` field — and the audit trail — names the replica that holds the lock.

The per-tenant onboarding lock itself **is** distributed-correct: it's a CAS on the tenant row's state, with a TTL (`onboardingTimeoutMs`) and an explicit `claimedBy`. Two replicas racing on the same tenant: one wins, the other gets a 409.

## Production checklist

Before flipping production traffic:

- [ ] **Storage**: pointed at a real `postgres` or `mongo` cluster (not `memory`). Migrations applied. For Mongo, a replica set (even single-node) is set up for transactions.
- [ ] **Secrets**: `ZATCA_SERVER_ADMIN_KEYS` and `ZATCA_SERVER_MASTER_KEYS` loaded from a secret manager — not committed to a `.env` file in the deployment manifest.
- [ ] **Active kid**: `ZATCA_SERVER_ACTIVE_KID` set explicitly, not relying on the implicit last-entry default (so a future config diff that reorders the ring doesn't silently change which key encrypts new writes).
- [ ] **Network**: `/healthz`, `/readyz`, `/metrics` bound to an internal/operator network only. TLS terminated at the ingress.
- [ ] **Proxy**: `ZATCA_SERVER_TRUST_PROXY=true` ONLY if you have a trusted proxy stripping incoming `X-Forwarded-*` headers. Otherwise leave it `false` to keep rate-limiting honest.
- [ ] **Security headers**: this server registers no CORS, Helmet, or CSRF middleware. Add them at your ingress.
- [ ] **Body size**: Fastify default 1 MiB applies. Most invoice payloads are << 100 KB. If your `lineItems` ever cross 1 MiB you'll need to override.
- [ ] **Observability**: `/metrics` scraped by Prometheus, alerts on `zatca_onboarding_total{outcome="failed"}` and on `zatca_production_cert_expiry_seconds < 30 * 86400` per tenant.
- [ ] **Audit retention**: a documented purge / archive policy that meets the Saudi tax record period.
- [ ] **Time**: container TZ matches `ZATCA_SERVER_TZ` (default `Asia/Riyadh`). Drift between the two will skew audit row timestamps relative to log timestamps.
- [ ] **OpenSSL CLI**: present on `PATH` inside the image (the default `node:20-slim` base ships it). Required for the onboarding key + CSR generation. See [`security.md`](./security.md#openssl-cli-dependency).
