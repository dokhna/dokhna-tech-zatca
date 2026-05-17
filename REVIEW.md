---
phase: pr-29-feat-zatca-server
reviewed: 2026-05-17T00:00:00Z
depth: deep
files_reviewed: 27
files_reviewed_list:
  - packages/server/src/cli.ts
  - packages/server/src/app.ts
  - packages/server/src/config.ts
  - packages/server/src/errors.ts
  - packages/server/src/index.ts
  - packages/server/src/crypto/aes-gcm-cipher.ts
  - packages/server/src/crypto/noop-cipher.ts
  - packages/server/src/crypto/cipher.ts
  - packages/server/src/auth/admin-keys.ts
  - packages/server/src/auth/tenant-bearer.ts
  - packages/server/src/tenants/types.ts
  - packages/server/src/tenants/store.ts
  - packages/server/src/tenants/api-key-store.ts
  - packages/server/src/tenants/credential-vault.ts
  - packages/server/src/tenants/registry-memory.ts
  - packages/server/src/tenants/registry-postgres.ts
  - packages/server/src/tenants/registry-mongo.ts
  - packages/server/src/audit/log.ts
  - packages/server/src/audit/log-postgres.ts
  - packages/server/src/audit/log-mongo.ts
  - packages/server/src/audit/redact.ts
  - packages/server/src/middleware/idempotency.ts
  - packages/server/src/middleware/errors.ts
  - packages/server/src/observability/logger.ts
  - packages/server/src/observability/metrics.ts
  - packages/server/src/onboarding/run.ts
  - packages/server/src/routes/deps.ts
  - packages/server/src/routes/ops.ts
  - packages/server/src/routes/admin-tenants.ts
  - packages/server/src/routes/admin-api-keys.ts
  - packages/server/src/routes/admin-onboard.ts
  - packages/server/src/routes/tenant-invoices.ts
  - packages/server/migrations/postgres/001_initial.sql
  - packages/server/Dockerfile
  - packages/core/src/onboarding/onboard.ts
  - packages/core/src/compliance/run-tests.ts
findings:
  critical: 4
  warning: 27
  info: 13
  total: 44
status: issues_found
---

# PR #29 (`feat/zatca-server`) — Local Code Review

**Reviewed:** 2026-05-17 (local pre-`/ultrareview` pass)
**Reviewer:** Adversarial / FORCE stance
**Scope:** New `@dokhna-tech/zatca-server` package + minor additive core changes (`onProgress` callback)

## Summary

The PR is large (≈10 kLoC, 27 source files), well-factored, and visibly cared-for — the
three-interface split (TenantStore / CredentialVault / ApiKeyStore), the kid-versioned
cipher envelope, and the lock + CAS design are all sound on paper. The implementation,
however, has **a small set of high-impact correctness defects** that the architecture
narrative claims to handle but the code does not actually implement:

1. The "mutation + audit-write share a single transaction" story is **documented all
   over** (`registry-postgres.ts:12-16`, `registry-mongo.ts:6-13`, `audit/log.ts:6-9`,
   `errors.ts:58-62`) — but **no route handler ever calls `withPgTransaction`** and the
   Mongo session-handling is also explicitly TODO. Mutation + audit are two
   independent awaits. Operators expecting transactional audit will not get it.
2. The onboarding lock has a clean recovery path on paper, but **two specific stale-lock
   states (state=`onboarding`, claim_expires_at IS NULL, and the same with a non-null
   but un-passable expiry) wedge the tenant** with no API recovery route — neither
   `runOnboarding`'s `expectedFrom` loop nor `/unlock` will dislodge it.
3. The idempotency store is defined, instantiated, plumbed through `RouteDeps`, and
   then **never consulted by any handler**. The Idempotency-Key header is in the
   `/onboard` route's type signature and is simply ignored. A client retry burns
   another OTP.
4. **Cross-tenant API-key revocation is possible**: `DELETE /v1/tenants/:ref/api-keys/:tokenId`
   passes `tokenId` to the store with no `tenantRef` predicate, so an admin can
   revoke tenant A's tokens by hitting tenant B's URL — and the audit row records
   tenant B as the target.

The crypto core (`aes-gcm-cipher.ts`) is solid; the auth helpers are mostly OK with a
subtle constant-time-comparison claim-vs-reality mismatch. The biggest risk surfaces
are the operational paths (onboarding recovery, transactional integrity, idempotency),
not the cryptography.

---

## CRITICAL

### CR-01: Transactional mutation+audit is documented but never implemented
**File:** `packages/server/src/tenants/registry-postgres.ts:12-16`, `packages/server/src/tenants/registry-mongo.ts:8-12`, all of `packages/server/src/routes/*.ts`, `packages/server/src/onboarding/run.ts`

**Issue:** Multiple source files document, in dense prose, that "the HTTP layer will wrap a mutation + audit-write into a single transaction via `withPgTransaction`" (`registry-postgres.ts:14-16`) and that "audit-write failure MUST roll the mutation back" (`errors.ts:58-62`). `withPgTransaction` is exported. `ZatcaAuditError` is declared. But:
  - `withPgTransaction` is referenced exactly twice — in its own JSDoc and once in an `audit/log-postgres.ts` comment. **Zero route handlers call it.**
  - `ZatcaAuditError` is declared and imported by the error mapper but **never thrown** anywhere.
  - Every route handler (e.g. `admin-tenants.ts:124-138`, `admin-onboard.ts:117-130`, `tenant-invoices.ts:160-217`, `run.ts:213-253`) does mutation `await` then audit `await` against two **independent** pools.

**Why it matters:** A network blip or DB hiccup between the two awaits creates a tenant that was created/deleted/onboarded with **no audit row**. For a ZATCA package whose entire reason for an audit log is the Saudi tax-authority retention period, this is a compliance hole. The PR description claims this is a feature; the code does not deliver it.

**Suggested fix:** Either (a) implement it — wrap each mutating handler body in `withPgTransaction(pool, async (tx) => { ... })`, passing `tx` as the `pool` field to both `createPostgresTenantStore` and `createPostgresAuditLog` for the duration of the call; do the analogous thing with a Mongoose `session.withTransaction()` in the Mongo handler path — or (b) update every comment and the README to say "audit best-effort, not transactional." Option (a) is what the PR description promises and what the test suite implicitly expects.

---

### CR-02: Onboarding lock permanently wedges when state=onboarding with NULL claim_expires_at
**File:** `packages/server/src/onboarding/run.ts:142-183`, `packages/server/src/tenants/registry-postgres.ts:340-355`, `packages/server/src/tenants/registry-mongo.ts:402-419`, `packages/server/src/routes/admin-onboard.ts:160-168`

**Issue:** Three independent guards each require `claim_expires_at` to be **not null** to permit a re-claim:
  - `run.ts:142-146` short-circuits as "already onboarding" only when `claimExpiresAt > now`. If `claimExpiresAt` is `undefined`, it passes through.
  - `run.ts:162-175` iterates `expectedFrom` ∈ {`created`, `failed`, `production-ready`} — **never `onboarding`**.
  - The Postgres CAS at `registry-postgres.ts:350-354` does `state = expectedFrom OR (state='onboarding' AND claim_expires_at IS NOT NULL AND claim_expires_at <= $3)`. The Mongo CAS at `registry-mongo.ts:411-414` mirrors this with `claimExpiresAt: { $lte: now, $ne: null }`. Neither matches a row with `claim_expires_at = NULL`.
  - The `/unlock` route at `admin-onboard.ts:160-168` refuses when `record.claimExpiresAt === undefined`.

So a tenant in state=`onboarding` with NULL claim_expires_at — reachable in real life if a process crashes after `setState('onboarding', { claimedBy, claimExpiresAt })` is rolled back at the DB level but leaves the row mutated by an in-flight statement, or by direct DBA intervention, or by a future refactor that ever does `setState('onboarding', {})` — is **un-recoverable via the API**. The operator must edit the row by hand.

**Why it matters:** Production permawedge. The whole point of the lock-with-TTL design is that nothing should require manual SQL.

**Suggested fix:**
  1. In the Postgres / Mongo CAS, treat `claim_expires_at IS NULL` as "lock not held" — change the OR branch to `state='onboarding' AND (claim_expires_at IS NULL OR claim_expires_at <= $3)`.
  2. In `/unlock`, also accept the NULL-expiry case.
  3. In `run.ts`'s `expectedFrom` loop, add `"onboarding"` so a fresh re-claim CAS can fire even from the wedged state.

---

### CR-03: Idempotency store is wired in but never consulted
**File:** `packages/server/src/middleware/idempotency.ts`, `packages/server/src/routes/deps.ts:39`, `packages/server/src/app.ts:71,96`, `packages/server/src/routes/admin-onboard.ts:47`

**Issue:**
  - `IdempotencyStore` is declared with Redis-compatible semantics, `createMemoryIdempotencyStore` is instantiated in `app.ts:71`, threaded into `RouteDeps`, and reachable in every handler.
  - The `/onboard` route's `Headers` type includes `"idempotency-key"?: string` (`admin-onboard.ts:47`) — but `req.headers["idempotency-key"]` is **never read**.
  - `buildIdempotencyCacheKey` is exported and never imported by any route file.

**Why it matters:** The `POST /v1/tenants/:ref/onboard` flow makes an OTP-burning network call to ZATCA. Without idempotency, a client TCP retry (or a load-balancer retry) burns a second OTP. The operator now needs a fresh OTP from Fatoora to recover. This is also true of `/credentials/rotate` and the invoice POST.

**Suggested fix:** For every mutating route that hits ZATCA, before issuing the call:
```ts
const idemHeader = req.headers["idempotency-key"];
if (typeof idemHeader === "string" && idemHeader.length > 0) {
  const key = buildIdempotencyCacheKey({ tenantRef: req.params.ref, route: req.routeOptions.url, presentedKey: idemHeader });
  const cached = await deps.idempotencyStore.get(key);
  if (cached !== null) {
    for (const [k, v] of Object.entries(cached.headers)) reply.header(k, v);
    return reply.code(cached.statusCode).send(JSON.parse(cached.body));
  }
  // ... after the operation succeeds, stash the response.
}
```
At minimum, require `Idempotency-Key` on `/onboard` and `/credentials/rotate` — refuse without it. Don't fall through to "burn OTP twice."

---

### CR-04: Cross-tenant API-key revocation
**File:** `packages/server/src/routes/admin-api-keys.ts:76-90`, all three `revoke` implementations (`registry-memory.ts:429`, `registry-postgres.ts:694`, `registry-mongo.ts:639`)

**Issue:** `DELETE /v1/tenants/:ref/api-keys/:tokenId` extracts `tokenId` from the URL and calls `deps.registry.apiKeys.revoke(req.params.tokenId)`. The store implementations key on `tokenId` only — there is no `WHERE tenant_ref = $X` filter on the UPDATE. So an admin who knows or guesses a tokenId belonging to tenant B can revoke it by hitting `/v1/tenants/A/api-keys/<B's tokenId>`, and the audit row records `tenantRef: A`, `targetId: <B's tokenId>`, with no indication that the actual revocation was cross-tenant.

In a single-admin deployment this is just an inconsistency; with multiple `ZATCA_SERVER_ADMIN_KEYS` issued to different teams who are scoped to different tenants (the rotation+attribution use case described in `admin-keys.ts:5-14`), it's a privilege-boundary escape.

**Why it matters:** Token IDs are 16 base32 lowercase characters (~80 bits). Practically unguessable, but they appear in `GET /api-keys` list responses — any admin who can list tenant B's keys can use the IDs from that listing to revoke them via tenant A's path. Combined with the fact that the listing endpoint also doesn't check `state !== 'revoked'` (audit visible to soft-deleted tenants), this is a real escape.

**Suggested fix:** Push tenant scoping into the store contract:
```ts
revoke(tenantRef: string, tokenId: string): Promise<void>
```
Implementations add `AND tenant_ref = $tenantRef` to the UPDATE. Route handler passes `req.params.ref` alongside `req.params.tokenId`. The store returns whether the revoke matched (so the route can 404 instead of returning 204 for a non-matching revoke).

---

## HIGH

### HI-01: `redactSecrets` does not protect Buffer / TypedArray secret values
**File:** `packages/server/src/audit/redact.ts:73-86`

**Issue:** `walk` short-circuits `Date | Map | Set` (line 73) but NOT `Buffer` / `Uint8Array`. A Buffer-typed secret value reaches `Object.entries(value)` and is serialized as `{ "0": 137, "1": 42, ... }` — bytes intact, all numeric. The bytes are recoverable from the JSON. Worse, if the parent object key was *not* in `SENSITIVE_KEYS`, the redactor doesn't replace the value, only walks into it. Net: a Buffer containing a private-key byte sequence stored under e.g. `keyMaterial: Buffer<...>` (not on the list) survives unredacted as a numerically-indexed object.

**Why it matters:** This is a defense-in-depth helper specifically for the audit log, which is supposed to be safe to read by tax-authority compliance staff. A Buffer leaking through is exactly the failure mode the helper exists to prevent.

**Suggested fix:** Before the `Object.entries(value)` branch, add:
```ts
if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
  // Treat any binary blob as opaque; never serialize its bytes.
  return REDACTED;
}
```

### HI-02: `redactSecrets`'s SENSITIVE_KEYS list is too narrow
**File:** `packages/server/src/audit/redact.ts:14-39`

**Issue:** The list catches the explicit ZATCA field names (`privateKey`, `complianceApiSecret`, etc.) but misses many things plausibly passed through audit payloads:
  - **Case variants:** `apikey`, `APIKey`, `APIkey`, `ApiKey`, `apiKEY` — none redacted (only `apiSecret` is, and case-sensitively).
  - **Other ZATCA-ish fields:** `csr`, `csid`, `complianceCsidValue`, `productionCsidValue`, `pem`, `pemCertificate`, `productionCertificate`, `complianceCertificate` (certs themselves aren't strictly secret but in many compliance regimes are treated as PII-adjacent).
  - **Generic high-risk:** `signature`, `signatureValue`, `signedXml`, `body`, `payload`, `headers`.
  - **The route at `tenant-invoices.ts:212-216` audits `(body.input as { kind?: string }).kind` — fine — but `body.input` for InvoiceInput could carry buyer PII (national ID, address) that's not redacted.**

**Why it matters:** The audit log is long-retention storage. Anything that lands in it must be treated as adversary-readable. Expanding the list now is cheap; expanding it after a leak is not.

**Suggested fix:** (a) lowercase the key before the `.has()` check, and lowercase the SENSITIVE_KEYS list; (b) add at minimum: `apikey`, `csr`, `signature`, `signaturevalue`, `signedxml`, `pem`, `pemcertificate`; (c) consider a regex-based fallback for `*secret*`, `*token*`, `*password*`.

### HI-03: `constantTimeEquals` is not actually constant-time
**File:** `packages/server/src/auth/admin-keys.ts:84-94`

**Issue:** The JSDoc claims "the comparison is still bound by the longer of the two so timing differs only at the length-difference boundary, not the content" — but the code returns early on length mismatch:
```ts
if (ab.length !== bb.length) return false;
return timingSafeEqual(ab, bb);
```
So an attacker who can measure response time can detect the configured key's length by trying admin keys of different lengths. With `MIN_KEY_LENGTH = 32` and admins free to set any length, this leaks 1-2 bits of useful information per probe.

Additionally, the `verify` function (`admin-keys.ts:122-134`) only calls `constantTimeEquals` for entries; on length mismatch it never enters `timingSafeEqual`, so the per-list-entry timing depends on which entries match the presented length.

**Why it matters:** Genuine timing leak. The mitigation is straightforward and the comment already promises it.

**Suggested fix:**
```ts
function constantTimeEquals(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  const ab = Buffer.alloc(max); ab.write(a, 0, "utf8");
  const bb = Buffer.alloc(max); bb.write(b, 0, "utf8");
  // timingSafeEqual requires same length, which we've ensured.
  return timingSafeEqual(ab, bb) && a.length === b.length;
}
```
The trailing `&& a.length === b.length` returns the correct boolean while the time-dominant `timingSafeEqual` runs over a fixed-length buffer. Alternatively, hash both sides (SHA-256) and `timingSafeEqual` the digests — fixed length by construction.

### HI-04: `softDelete` + `revokeAllForTenant` is not atomic; audit also outside
**File:** `packages/server/src/routes/admin-tenants.ts:192-204`

**Issue:**
```ts
await deps.registry.tenants.softDelete(req.params.ref);
await deps.registry.apiKeys.revokeAllForTenant(req.params.ref);
await deps.auditLog.write({ ... });
```
Three sequential awaits, no transaction. Failure modes:
  - softDelete succeeds, `revokeAllForTenant` fails (network) → **tenant is soft-deleted but its bearer tokens still resolve and authorize invoice issuance**. The tenant verifier at `tenant-bearer.ts:53-61` checks only `resolved.tenantRef === expectedTenantRef`; the tenant's `deletedAt` is checked by `tenants.get(...)` later in `authTenant` at `tenant-invoices.ts:85-88`, but `get` returns `null` for soft-deleted (per `store.ts:42-43`), so this **does** fail at the second check. So in practice the soft-deleted tenant cannot issue invoices.
  - But: `revokeAllForTenant` not running means the bearer rows still exist in the api_keys table. If the tenant is ever un-soft-deleted (no API for that, but a DBA might), the bearers come back valid. **This is a stale-credential resurrection risk.**
  - softDelete + revokeAllForTenant succeed, audit fails → destructive op is unrecorded.

**Why it matters:** Stale-credential resurrection violates the principle that revocation is final. Plus the store interface contract at `store.ts:87-91` explicitly says "Implementations SHOULD revoke any outstanding API keys for the tenant in the same transaction" — and this implementation does not.

**Suggested fix:** Wrap in `withPgTransaction` (Postgres) / Mongo session (Mongo). Or push the bulk-revoke down into the store's softDelete so it's a single DB statement (Postgres: `WITH del AS (UPDATE tenants ... RETURNING tenant_ref) UPDATE api_keys SET revoked_at=$1 FROM del WHERE api_keys.tenant_ref=del.tenant_ref` — one query, atomic).

### HI-05: Onboarding writes vault material before state transition; partial success burns OTPs
**File:** `packages/server/src/onboarding/run.ts:213-253`

**Issue:** Sequence in `runOnboarding`'s success path:
  1. `vault.put(...)` (line 213) — encrypts and persists signer material.
  2. `setProductionExpiry(...)` (line 232).
  3. `setState(..., "production-ready", {})` (line 234).
  4. `auditLog.write(...)` (line 240).

If step 3 throws (CAS conflict because another process took the lock — yes, the lock should prevent that, but TTL exhaustion + a slow `getExpiry` parse + a network blip is enough to expose this), the catch block at line 262 runs `setState(..., "failed", { lastError })`. **But the vault still holds the valid material from step 1**, and the operator does not know it's valid. The next onboarding attempt will:
  - Acquire the lock from state=`failed`.
  - Burn a fresh OTP (the previous one is already burnt; can't reuse).
  - On success, overwrite the (already-valid) vault material.

If step 4 (audit) fails, state is `production-ready`, vault has material, but **no audit row for the successful onboarding** — compliance gap.

**Why it matters:** OTPs are operationally expensive in Saudi (issued by Fatoora; require a human action). Burning them on recoverable internal errors is a real operational cost. The audit gap is a compliance cost.

**Suggested fix:**
  1. Reorder: persist expiry + state first (cheap DB updates), vault.put last. If state transition fails, no vault material has been written and a retry is clean.
  2. Alternatively, before acquiring the lock check `vault.get(tenantRef)` and the existing record's `productionCertificateExpiresAt` — if a valid (un-expired) material exists, fast-path to `production-ready` without burning a fresh OTP.
  3. Audit write must be inside the same transaction as the state transition (see CR-01).

### HI-06: `/unlock` is the only post-stale recovery path but won't unlock all stale states
**File:** `packages/server/src/routes/admin-onboard.ts:154-180`

**Issue:** Related to CR-02 but distinct: `/unlock` refuses unless **all three** of (state=`onboarding`, claimExpiresAt defined, claimExpiresAt ≤ now) are met. If `claimExpiresAt` is undefined (the wedged case from CR-02), the route returns `ZatcaValidationError`. So the operator has no API affordance to recover.

**Why it matters:** Operators will hit this case at least once — any race/crash mid-`setState('onboarding', ...)` can leave the row in a state where claimExpiresAt didn't get set. They will have to drop to direct DB UPDATE, which is exactly what the route was designed to avoid.

**Suggested fix:** Relax the condition to `(claimExpiresAt === undefined || claimExpiresAt <= now)`. Document that this is the operator's escape hatch and that calling it during an active onboarding will cause the in-flight run to fail at its final CAS — which is fine, since the operator is explicitly intervening.

### HI-07: `ZatcaServerError` always maps to 500; `runOnboarding` throws it for legitimate user errors
**File:** `packages/server/src/middleware/errors.ts:114-116`, `packages/server/src/onboarding/run.ts:147-152, 180-182, 210, 227-230`

**Issue:** `runOnboarding` throws `ZatcaServerError` for cases that are very much **user-recoverable**:
  - "Tenant 'X' is already onboarding (...)" — should be 409 Conflict.
  - "Tenant 'X' cannot be onboarded from state 'Y'" — 409 Conflict.
  - "Compliance tests failed" — 422 Unprocessable Entity (the user-supplied OTP was good but compliance failed).
  - "Onboarding succeeded but production certificate expiry could not be parsed" — 500 is OK here (internal parse bug).

The mapper at `errors.ts:114-116` maps every `ZatcaServerError` to 500. All four cases above produce 500 responses, which:
  - Mislead the client (looks like an internal bug when it's actually a state conflict).
  - Will set off operator monitoring alerts on every legitimate "already onboarding" attempt.

**Why it matters:** Wrong status codes break client retry logic and operational dashboards.

**Suggested fix:** Add a `statusHint` field to `ZatcaServerError` (mirroring `ZatcaAuthError`), default 500, and set it explicitly in each throw site in `run.ts`. Or introduce subclasses (`ZatcaOnboardingConflictError → 409`, `ZatcaComplianceFailedError → 422`).

### HI-08: Error-mapper status routing depends on regex over error.message
**File:** `packages/server/src/middleware/errors.ts:67-71`

**Issue:**
```ts
if (err instanceof ZatcaRegistryError) {
  const status = /^Unknown\b/.test(err.message) ? 404 : 409;
  ...
}
```
Status code derived from message-text matching. Any future caller who writes `throw new ZatcaRegistryError("Tenant not found.")` (the natural English phrasing) gets a 409 instead of a 404. Any caller who writes `throw new ZatcaRegistryError("Unknown column 'foo'")` gets a spurious 404. Refactor-hostile.

**Why it matters:** Quiet behavioral coupling to English wording. The first time someone localizes error messages or rephrases for clarity, the HTTP contract changes.

**Suggested fix:** Add a `code: "not_found" | "conflict" | "invalid"` field on `ZatcaRegistryError` and map on that. Or split into `ZatcaTenantNotFoundError extends ZatcaRegistryError`.

### HI-09: Master-key material lives on `ServerConfig` and could leak via any config log line
**File:** `packages/server/src/config.ts:38, 167`, `packages/server/src/routes/deps.ts:27`, `packages/server/src/observability/logger.ts:22-53`

**Issue:** `ServerConfig.masterKeys: ReadonlyArray<MasterKey>` carries raw 32-byte `Buffer` keys. `ServerConfig.adminKeysRaw: string` carries the entire comma-separated admin-key string. Both are reachable from every route handler via `deps.config`. The pino redact list at `logger.ts:22-53` includes `masterKey` / `master_key` (singular) but NOT `masterKeys` (the actual field name on ServerConfig), and not `adminKeysRaw`. A `logger.info({ config }, "...")` call anywhere (including a future debug line) would dump all master keys and the raw admin string.

**Why it matters:** The pino `redact` list is the last line of defense for "what if someone logs the config object." Right now that defense has the wrong path — it'd protect a value at `req.body.masterKey` but not `config.masterKeys[0].key`.

**Suggested fix:**
  1. Add `masterKeys`, `masterKeys[*].key`, `*.key` (wildcarded paths in pino's redact syntax), and `adminKeysRaw` to the redact list.
  2. Better: don't keep raw keys on `ServerConfig` after `buildApp` has consumed them. Parse → derive verifier/cipher → drop the raw bytes from `RouteDeps`. The handlers don't need them.

### HI-10: Vault `put` doesn't clear stale optional compliance fields on re-onboard
**File:** `packages/server/src/tenants/registry-mongo.ts:507-528`, `packages/server/src/tenants/registry-postgres.ts:495-535`, `packages/server/src/tenants/credential-vault.ts:62`

**Issue:** Both `put` implementations use `$set` / `INSERT ... ON CONFLICT DO UPDATE SET ...` for the four required fields plus the three optional compliance fields. If a re-onboard produces signing material **without** `complianceCertificate` (because the new onboarding cycle didn't retain it — a plausible future path), the Mongo impl only `$set`s the fields it has, so old compliance fields linger. Postgres is similar — the optional fields go in as `NULL` only when explicitly nulled; the route sends `null` when the encrypted form is `null`, OK in Postgres, but in Mongo only the truthy ones are `$set`.

**Why it matters:** Stale compliance material persists past a rotation. Decryption would still succeed (kid is in the ring). Could lead to mismatched compliance vs production signing certs being available in-process simultaneously — minor confused-deputy risk.

**Suggested fix:** In the Mongo impl, build a parallel `$unset` for any optional field that's undefined in the input, and pass both as `{ $set, $unset }`. In Postgres, the current `ON CONFLICT` path does already set NULL since `complianceCertificate === null ? null : ...` is passed for the field — verify by re-reading the SQL; if any branch leaves a stale value, fix it.

### HI-11: Idempotency `putIfAbsent` contract is ambiguous between in-flight and committed
**File:** `packages/server/src/middleware/idempotency.ts:31-49, 56-84`

**Issue:** The interface says "Returns `true` if the entry was inserted ... `false` if a prior entry exists under the same key (caller may treat as in-flight or simply proceed to read)." But the memory implementation stores a real `CachedResponse` in `putIfAbsent`, so a `get` after a losing `putIfAbsent` returns the **placeholder** the winner wrote — there's no separate "I'm in flight, no response yet" state. Caller B who lost the race reads a placeholder that may not yet reflect the actual outcome of caller A's still-in-flight request.

**Why it matters:** Once CR-03 is fixed and idempotency is actually wired up, this race becomes a real protocol bug — caller B reads stale state, caller A's update may overwrite it.

**Suggested fix:** Either (a) introduce explicit states: `inFlight | committed` with `start(key) → token` / `commit(key, token, response)` / `getCommitted(key)`. Or (b) document that the first writer must `set` the final response value within ≤ N ms and the cache TTL on the placeholder is exactly N ms, so a slow responder loses the slot to a retry. (a) is cleaner.

---

## MEDIUM

### ME-01: User-supplied tenantRef has no character restriction
**File:** `packages/server/src/routes/admin-tenants.ts:41`, `packages/server/src/tenants/registry-postgres.ts:597` (TOKEN_RE), `packages/server/src/tenants/registry-memory.ts:353`, `packages/server/src/tenants/registry-mongo.ts:541`

**Issue:** `CreateTenantBody.tenantRef: z.string().min(1).max(64).optional()` accepts ANY characters: `_`, `/`, `:`, spaces, unicode, anything. But the bearer-token regex `TOKEN_RE = /^zts_(live|test)_([a-z0-9]+)_([A-Z2-7]{32})$/` only accepts `[a-z0-9]+` for the tenantRef segment. So an admin who creates a tenant with `tenantRef: "tenant_1"` will issue tokens like `zts_live_tenant_1_AAAA...AAAA`. The `_1` in the middle confuses `parseToken` (it'll match `tenant` as the ref and treat `1_AAAA...` as the tail, which fails the `[A-Z2-7]{32}` check). The bearer becomes unusable.

Also: URL routes like `/v1/tenants/:ref/invoices` with a tenantRef containing `/` would shadow the next segment.

**Why it matters:** Footgun. The system silently accepts a tenantRef that breaks bearer auth for the rest of the tenant's life.

**Suggested fix:** Tighten the schema: `z.string().regex(/^[a-z0-9-]{1,64}$/)`. Allow hyphen for the convention. Update the generator to match.

### ME-02: All ZatcaApiError responses forward upstream status — including 401/403 from ZATCA
**File:** `packages/server/src/middleware/errors.ts:79-101`

**Issue:** When ZATCA returns 401 (server's compliance/production API secret revoked), the mapper forwards 401 to the *client*. The client now thinks **their** auth is wrong, but it's the server's stored credentials. Same for 403, 429 (ZATCA rate limit becomes client rate limit, which they can't fix).

**Why it matters:** Operator support load. Every 401-from-ZATCA becomes a "why won't my bearer work?" ticket.

**Suggested fix:** Map upstream 401/403 → 502 (Bad Gateway, server cred problem), upstream 429 → 503 with `Retry-After` if available. Surface the upstream status in the body, not the wire status.

### ME-03: Pino redact paths miss most nested + admin-side fields
**File:** `packages/server/src/observability/logger.ts:22-53`

**Issue:** The redact list is path-anchored. It catches `req.headers.authorization` but not `req.headers.Authorization` (cases differ; pino does match exactly), it catches `req.body.otp` and `req.body.privateKey` but no nested paths (`req.body.input.signing.privateKey`). It does NOT redact:
  - `req.body.complianceApiSecret`, `req.body.productionApiSecret` at the body level.
  - Nested `*.privateKey` (pino supports `*.privateKey` wildcard — currently unused).
  - `res.body.token` (the issued API-key plaintext returned by `POST /api-keys`). Fastify doesn't log response bodies by default, but if the operator turns on debug logging this leaks.

**Why it matters:** Defense in depth fails — secret material can land in logs through paths the redact list doesn't cover.

**Suggested fix:** Use pino's wildcard syntax:
```
"*.privateKey", "*.apiSecret", "*.binarySecurityToken",
"req.body.*.privateKey", "req.body.*.signing.privateKey",
"req.headers['x-api-key']", "req.headers['x-zatca-otp']"
```

### ME-04: Resolve-on-every-request writes `last_used_at` on the hot path
**File:** `packages/server/src/tenants/registry-postgres.ts:685-688`, `packages/server/src/tenants/registry-mongo.ts:633`

**Issue:** Every successful `apiKeys.resolve` issues an UPDATE on `last_used_at`. On a busy tenant doing 100 req/s, that's 100 writes/s on the api_keys table for what amounts to telemetry. The index on `(tenant_ref)` doesn't include `last_used_at`, so the UPDATE is cheap, but write amplification adds up and contends with the `revoke` path.

**Why it matters:** Operational footgun for high-throughput tenants. Also: under burst load, the UPDATE could lag behind the actual request, making `last_used_at` lossy anyway.

**Suggested fix:** Either (a) debounce — only write `last_used_at` if it's been > N seconds since the last write (track in-memory per token); (b) write asynchronously via a background queue; (c) drop it entirely if no operator UI uses it.

### ME-05: `softDelete` doesn't filter `deleted_at IS NULL` — second softDelete clobbers
**File:** `packages/server/src/tenants/registry-postgres.ts:444-455`, `packages/server/src/tenants/registry-mongo.ts:474-483`

**Issue:** Postgres: `UPDATE ... WHERE tenant_ref = $1`. No `AND deleted_at IS NULL`. Mongo: `updateOne({ _id: tenantRef }, ...)`. Both happily update an already-soft-deleted row, overwriting `deleted_at` with the new timestamp. The original deletion timestamp is lost.

**Why it matters:** Audit-forensics: "when was the tenant first deleted?" becomes unanswerable. Plus the second call succeeds without error, so the route at `admin-tenants.ts:194` would proceed to `revokeAllForTenant` and write a second audit row labeled `tenant.softDeleted` for an already-deleted tenant.

**Suggested fix:** Both impls: `WHERE tenant_ref = $1 AND deleted_at IS NULL` (Postgres) / `{ _id: tenantRef, deletedAt: { $exists: false } }` (Mongo). If `rowCount === 0`, throw `ZatcaRegistryError("Tenant already deleted")` — distinct from `Unknown tenant`.

### ME-06: TenantBearer mismatch status-code leak (deliberate but worth surfacing)
**File:** `packages/server/src/auth/tenant-bearer.ts:53-61`

**Issue:** When a bearer is valid (resolves) but `tenantRef !== expectedTenantRef`, returns 403. When the bearer is invalid (resolve returns null), returns 401. An attacker with any valid bearer can probe other tenants' URLs and distinguish "valid token, wrong scope" (403) from "invalid token" (401) — confirming their token still exists. The prompt notes this is intentional, but it's worth flagging that this **also confirms tenant existence**: hitting `/v1/tenants/foo/invoices` with a valid bearer-for-bar returns 403 (= bar is a real tenant). An attacker with a leaked bearer can enumerate the tenant directory.

**Why it matters:** Information leak even after a single-token compromise.

**Suggested fix:** Return 401 for both "invalid token" and "valid token, wrong tenant." Log the distinction server-side via a `reason: "wrong_tenant"` field. Operators get the diagnostic detail; attackers do not.

### ME-07: Unused `_egsInfo` in invoice POST
**File:** `packages/server/src/routes/tenant-invoices.ts:143`

**Issue:** `const _egsInfo = buildEgsInfo(tenant, signing);` — built and never read. `buildEgsInfo` (line 107-134) constructs a complete `EGSUnitInfo` including the embedded private key, decrypted in-process. It's then discarded. This is wasted CPU but also a needless surface for accidental logging.

**Why it matters:** If a future logging change captures local variables, the `_egsInfo` object would dump the private key. Dead code = future foot-gun.

**Suggested fix:** Remove the line. The `issueInvoice` helper takes `signing` directly and doesn't consume `egsInfo` per the call site.

### ME-08: Phase 1 invoice + submit=true silently no-ops
**File:** `packages/server/src/routes/tenant-invoices.ts:160-194`

**Issue:** `if (body.submit && isPhase2) { ... }`. If the input is a Phase 1 invoice (no `signedXml`) and `submit:true`, the branch doesn't execute, `status` stays `"pending"`, and the audit row records `submitted: true, status: "pending"` with no submission actually happening. The client gets a 200 response and may believe their invoice is submitted.

**Why it matters:** Silent partial behavior. The client cannot tell whether submission was skipped because their invoice was Phase 1 or because of a server-side flag.

**Suggested fix:** If `body.submit && !isPhase2`, either: (a) throw `ZatcaValidationError("submit=true requires a Phase 2 invoice kind")`, or (b) explicitly emit `status: "skipped"` and a body field explaining why.

### ME-09: Audit log message says "tenant.onboarded" for `/credentials/rotate` calls
**File:** `packages/server/src/onboarding/run.ts:243`, `packages/server/src/routes/admin-onboard.ts:118-124`

**Issue:** `runOnboarding` hardcodes `action: "tenant.onboarded"` in its success audit write. The `/credentials/rotate` route calls `runOnboarding` and then writes a *second* audit row with `action: "tenant.credentialsRotated"`. So a rotation produces two rows: `tenant.onboarded` (misleading — this is not the first onboarding) and `tenant.credentialsRotated`.

**Why it matters:** Audit log filtered by `action = "tenant.onboarded"` will include rotations, inflating the count. The audit log is the compliance record; this corrupts it.

**Suggested fix:** Pass an `auditAction: AuditAction` field into `RunOnboardingArgs` so the caller selects the right action. Default to `"tenant.onboarded"` for first-time onboarding; pass `"tenant.credentialsRotated"` from the rotate route. Drop the secondary audit write in the rotate handler.

### ME-10: Vault read returns SignerMaterial through the HTTP layer indirectly (no leak, but documented promise weak)
**File:** `packages/server/src/routes/tenant-invoices.ts:84-104`, `packages/server/src/tenants/credential-vault.ts:30`

**Issue:** The vault interface comment at `credential-vault.ts:28-30` says "Treat each as **secret** — never log, never write to a non-encrypted store, never include in an HTTP response body." The code does NOT include it in a response body (good), but the response objects it returns (`signedXml`, `qrCode`, etc., at `tenant-invoices.ts:226-228`) are derived from the signing material via core. A future refactor that accidentally inlines `signing` into the response would not be caught by any compile-time guard.

**Why it matters:** No bug today; latent risk on refactor.

**Suggested fix:** Brand `SignerMaterial` with a phantom type — `SignerMaterial & { readonly __secret: never }` — so it can't be JSON.stringified or assigned to a `Response` body without an explicit unwrap. Or wrap reads in a `withSigningMaterial(tenantRef, async (m) => { ... })` scope that takes the material out of scope when the callback returns.

### ME-11: `/readyz` pulls every tenant on every probe
**File:** `packages/server/src/routes/ops.ts:24`

**Issue:** `await deps.registry.tenants.list({ includeDeleted: false })` — no limit. Kubernetes liveness/readiness probes run every 5-30 seconds. With 10k tenants, that's 10k rows pulled per probe, hashed into TenantRecord objects, garbage-collected. Latency creeps.

**Why it matters:** Cluster operators will see `/readyz` p99 latency grow with tenant count and assume it's a DB problem when it's really a probe-design problem.

**Suggested fix:** Either (a) a dedicated `tenants.ping()` that does `SELECT 1` / `db.runCommand({ping:1})`, or (b) `tenants.list({ limit: 1 })` (which requires adding limit to TenantListFilter).

### ME-12: `/readyz` 503 body includes raw error.message
**File:** `packages/server/src/routes/ops.ts:27-30`

**Issue:** `reason: err instanceof Error ? err.message : "unknown"`. A pg connection failure throws `Error("connection to server at "pg-host" (10.0.0.5), port 5432 failed: ...")`. That message has the internal hostname, IP, and port. `/readyz` is publicly hittable (no auth, by design). Anyone on the internet (if the port is open) can fingerprint the backend.

**Why it matters:** Internal infra disclosure.

**Suggested fix:** Log `err` to the server log; return only `reason: "backing-store-unavailable"` to the client.

### ME-13: Metrics never updated (`activeTenants`, `productionCertExpirySeconds`, `zatcaApiLatencySeconds`)
**File:** `packages/server/src/observability/metrics.ts:75-86, 65-73`

**Issue:** Three metrics are declared, registered, and exposed via `/metrics`, but **never `.set()` / `.observe()` / `.inc()` anywhere**:
  - `zatca_active_tenants` — promised "refreshed periodically" — no refresh code.
  - `zatca_production_cert_expiry_seconds` — labeled by tenant — no setter.
  - `zatca_api_latency_seconds` — no instrumentation around the core ZATCA HTTP client calls.

**Why it matters:** Dashboards built on these labels will show zero forever; operators will assume traffic is zero and silently miss real outages.

**Suggested fix:** Either (a) instrument them — periodic gauge refresh via a `setInterval` in `buildApp`, a wrap around `singleInvoiceReportingOrClearanceStatus` to observe latency — or (b) remove them until the instrumentation lands. Shipping declared-but-unfed metrics is worse than not exposing them.

### ME-14: `tenant` label on `invoices*` counters is high-cardinality
**File:** `packages/server/src/observability/metrics.ts:44-56, 88-101`

**Issue:** `invoicesIssuedTotal: Counter<"tenant" | "kind" | "status">`. Prometheus stores one time-series per unique label combination. With 1000 tenants × 4 kinds × 3 statuses = 12k series for one counter. With 10k tenants = 120k. Prometheus memory blows up; cardinality alerts fire.

**Why it matters:** Cardinality explosion is the #1 cause of Prometheus outages.

**Suggested fix:** Drop the `tenant` label or hash-bucket it (`tenant_bucket: hash(tenantRef) % 64`). Tenants who need per-tenant invoice counts can query the audit log instead.

### ME-15: `trustProxy: true` is unconditional
**File:** `packages/server/src/app.ts:77`

**Issue:** Set to `true` always. If the server is bound to `0.0.0.0:3000` and reachable directly (not behind a trusted proxy), an attacker on the same network can send `X-Forwarded-For: <victim>` and the server believes them. Today this only affects `req.ip` (used in logs); when rate limiting / IP-based blocking lands, this becomes a bypass vector.

**Why it matters:** Pre-emptive footgun for the next feature.

**Suggested fix:** Make it configurable: `ZATCA_SERVER_TRUST_PROXY` env var, default `false`. Document the operator-facing decision in the README.

### ME-16: `connectionTimeout` / `requestTimeout` set to onboardingTimeoutMs + 10s for ALL routes
**File:** `packages/server/src/app.ts:80-81`

**Issue:** `connectionTimeout: Math.max(30_000, config.onboardingTimeoutMs + 10_000)` — applies to every connection, not just `/onboard`. So a `/healthz` probe with a hung TCP stack waits 190s before the server forcibly closes. Memory + FD pressure builds under attack.

**Why it matters:** Easier DoS amplifier than necessary.

**Suggested fix:** Set Fastify's per-route timeout for `/onboard` and `/credentials/rotate` explicitly; leave the server-level timeout at 30s. Fastify supports per-route timeouts via the `connectionTimeout` option on `server.route({ ... })`.

### ME-17: List of API keys exposed for soft-deleted tenants
**File:** `packages/server/src/routes/admin-api-keys.ts:70-74`, `packages/server/src/tenants/registry-postgres.ts:702-727`

**Issue:** `GET /v1/tenants/:ref/api-keys` calls `apiKeys.list(req.params.ref)`. There's no check that the tenant exists / is not deleted. The store returns all rows for that tenant_ref regardless of the tenant's lifecycle state — including for soft-deleted tenants.

**Why it matters:** Minor information leak: an admin who knows a previously-deleted tenant's ref can see its issued tokens' labels and `last_used_at` timestamps even after the tenant is "revoked."

**Suggested fix:** Add a `tenants.get(ref)` precheck in the GET handler; 404 if `null`. Or filter rows in the store query: `LEFT JOIN tenants ON ... WHERE tenants.deleted_at IS NULL`.

### ME-18: Cancel route requires zatcaInvoiceId + clearanceNumber in body, but they're in the local record
**File:** `packages/server/src/routes/tenant-invoices.ts:51-62, 248-296`

**Issue:** `CancelBody` requires the client to supply `zatcaInvoiceId` and `clearanceNumber`. The server already has the invoice record loaded (line 255) — which per the comment "lives inside `validationResults`." The server forces the client to re-track these. Two bugs in one:
  1. Clients without good infrastructure will store these wrong / lose them, breaking cancels.
  2. Easy to spoof: send a fake `zatcaInvoiceId` of someone else's invoice (for cancel) — ZATCA will reject by signature, but at minimum the cancel call is performed against the wrong target.

**Why it matters:** UX-hostile and a subtle attack surface.

**Suggested fix:** Read `zatcaInvoiceId` and `clearanceNumber` from the stored `record.validationResults` (or surface them as first-class columns on `InvoiceRecord`). Client just supplies `reason`.

### ME-19: `apiKeys.list` doesn't show whether the listing reflects all keys or only active
**File:** `packages/server/src/routes/admin-api-keys.ts:70-74`

**Issue:** Returns both active and revoked keys (Postgres `WHERE tenant_ref = $1`, no revoked filter; Mongo same). No filter param to limit to active. The list always carries `revokedAt` so the client can filter, but for a tenant with many rotations the list grows unboundedly.

**Why it matters:** Unbounded response size.

**Suggested fix:** Default to active (`revokedAt IS NULL`) with `?includeRevoked=true` query to show full history. Cap with `?limit=`.

### ME-20: `tokenId` revocation is silently idempotent — no signal whether the token existed
**File:** `packages/server/src/tenants/registry-postgres.ts:694-700`, `packages/server/src/tenants/registry-mongo.ts:639-644`

**Issue:** `revoke` does an UPDATE with no rowCount check; returns `void`. The route returns 204 whether the tokenId existed or not. Operators can't tell whether their revoke actually did anything.

**Why it matters:** Operational confusion. Combined with CR-04 (cross-tenant revoke), an operator may think they revoked a token when they actually targeted a different tenant's token.

**Suggested fix:** Return `revoked: boolean` from `revoke`. Route returns 204 on revoke success, 404 if no row matched.

### ME-21: `connection.close()` in cli.ts:110 not preceded by Mongoose flush
**File:** `packages/server/src/cli.ts:110, 153, 198`

**Issue:** Shutdown path: `await app.close(); await booted.shutdown()`. `app.close()` lets in-flight requests finish. But `booted.shutdown` for mongo just `connection.close()` — does not drain pending writes (last_used_at updates, audit-log writes). For Postgres it's `pool.end()` which waits for active clients, OK. For Mongo, in-flight `updateOne`s may abort.

**Why it matters:** Last-mile data loss on graceful shutdown. Lost audit rows are exactly the kind of issue compliance audits surface.

**Suggested fix:** Call `await connection.close(true)` (force=true after waiting; if Mongo supports `await mongoose.disconnect()` semantics with proper drain). Or order-of-shutdown: wait for `app.close` (which awaits all handlers) — this should suffice if every handler awaits its audit write. Confirm by adding a shutdown integration test.

### ME-22: Token regex too-permissive on tenantRef segment
**File:** `packages/server/src/tenants/registry-memory.ts:353`, `packages/server/src/tenants/registry-postgres.ts:597`, `packages/server/src/tenants/registry-mongo.ts:541`

**Issue:** `TOKEN_RE = /^zts_(live|test)_([a-z0-9]+)_([A-Z2-7]{32})$/`. The tenantRef capture `[a-z0-9]+` accepts digits 0-9, but `generateTenantRef` returns base32-lowercase which only uses chars `a-z` and `2-7`. So `0`, `1`, `8`, `9` will never appear in a generated tenantRef. The regex accepts them anyway, opening a parse-but-no-match window if a user-supplied tenantRef contains them. Not a security issue, but inconsistent.

**Why it matters:** Will be confusing during future debugging if a tenantRef contains `0` or `1` (impossible to occur naturally; possible via custom admin POST per ME-01).

**Suggested fix:** Either tighten the regex to `[a-z2-7]+` to match the generator, OR loosen `generateTenantRef` to use base36 — but the latter changes wire format.

### ME-23: Pool option `pretty` defaults to `NODE_ENV === "development"`; in production with NODE_ENV unset, pino-pretty isn't loaded but pretty would be `false` — OK; the latent issue is missing `silent` mode for tests
**File:** `packages/server/src/observability/logger.ts:80`

**Issue:** Tests calling `buildApp({ config: ..., ... })` get pino at `info` level by default, which spams the test output with request logs. There's no `level: "silent"` short-circuit for tests, and `loadConfig` doesn't accept `"silent"` in its level enum (`LevelSchema` at config.ts:67). The test suite likely silences pino via vitest's stdout capture, but that's brittle.

**Why it matters:** Noisy tests; harder to spot real failures.

**Suggested fix:** Add `"silent"` to `LevelSchema`. Have `buildApp` accept a `logger?: Logger` option so tests can pass a custom one or `pino({ enabled: false })`.

### ME-24: `Buffer.from(b64, "base64")` silently truncates invalid input
**File:** `packages/server/src/config.ts:94-99`

**Issue:** `Buffer.from("not!!!base64!!!", "base64")` returns a short buffer instead of throwing. The length check on line 95 catches obvious cases (length != 32), but a 32-byte buffer derived from invalid base64 + accidental padding could slip through. Not exploitable in practice (the resulting key bytes would be effectively random), but the error message in the wrong case would be misleading ("got 8 bytes" when the operator typed a 44-char base64 string).

**Why it matters:** Bad failure mode on operator misconfiguration.

**Suggested fix:** Validate the base64 input strictly first: `if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw ZatcaServerError("...not valid base64...")`. Then decode and check length.

### ME-25: `audit.payload` size unbounded
**File:** `packages/server/migrations/postgres/001_initial.sql:100`, `packages/server/src/audit/log-mongo.ts:50`

**Issue:** Audit payload is unconstrained JSONB / Mixed. A malicious admin could send a 100MB body, the redactor passes it through, and the audit row holds it forever (no retention policy yet).

**Why it matters:** DoS via slow disk fill; recovery via DELETE on an immutable audit table is awkward.

**Suggested fix:** Cap payload size in `auditLog.write` — refuse > N bytes after JSON.stringify, log a warn, store a truncated payload. Document the cap.

### ME-26: `compliance-tests-passed` state has no actual code path that lands in it
**File:** `packages/server/src/tenants/types.ts:31`, `packages/server/src/onboarding/run.ts:206-238`

**Issue:** State enum includes `compliance-tests-passed` but `runOnboarding` transitions directly from `onboarding` → `production-ready` on success, or → `failed` on error. No code path ever sets state to `compliance-tests-passed`. The check-compliance route at `tenant-invoices.ts:323` requires `state === "production-ready"`, so the intermediate state is meaningless.

**Why it matters:** Dead state — operators may build dashboards filtering by it and see zero rows forever.

**Suggested fix:** Either (a) remove it from the enum and CHECK constraint, or (b) emit it from `runOnboarding` after compliance tests pass but before production CSID is acquired (which would also enable a recovery path: re-issue CSID without re-running compliance).

### ME-27: No backpressure or rate limit on `/onboard`
**File:** `packages/server/src/routes/admin-onboard.ts:47-86`

**Issue:** An admin with a valid key can fire concurrent `/onboard` requests across many tenants. Each one runs for up to 3 minutes, holding a DB connection, doing ZATCA calls. No semaphore / queue / rate limit. A malicious admin (or compromised key) could pin the pool and starve the rest of the service.

**Why it matters:** Single-point-of-pressure on a privileged route.

**Suggested fix:** Add a configurable global onboarding semaphore (e.g. max 4 concurrent). Reject 503 with `Retry-After` when full.

---

## LOW

### LO-01: `extractBearer` regex's `.trim()` is redundant
**File:** `packages/server/src/auth/admin-keys.ts:157-164`

The regex `^Bearer\s+(\S.*)$` guarantees the captured group starts with `\S`, so leading whitespace can't be present. Trailing whitespace is possible (the `.` doesn't match newlines but does match space/tab) — but with `$` and no `m` flag, only end-of-string. Trim is defensive but no longer load-bearing. Cosmetic.

### LO-02: `isMainModule` detection at `cli.ts:209-213` is fragile
The `endsWith` fallback is hacky. Use `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])` (with a guard for `argv[1] !== undefined`).

### LO-03: `process.exit(0)` in shutdown handler even on error
`cli.ts:198` — exits 0 after a logged error in shutdown. Should be `process.exit(err ? 1 : 0)` for orchestrator visibility.

### LO-04: `actor_type` is duplicated on the audit log row + inside the actor JSON
`audit/log-postgres.ts:86-87`, `audit/log-mongo.ts:42, 102`. The `actor.type` field is the canonical source; `actor_type` is denormalized for index/filter. Fine for Postgres (index target), redundant in Mongo (Mongoose can index `"actor.type"`). Cosmetic.

### LO-05: Mongoose `_id: false` on a schema that explicitly declares `_id`
`audit/log-mongo.ts:58`. `_id: false` is for subdocuments. With explicit `_id: { type: String, required: true }` (line 40), Mongoose treats the top-level `_id` as authoritative. The option is misleading. Drop it.

### LO-06: `connection.asPromise()` then no listener for `error`
`cli.ts:86-87`. Once connected, a later mongo connection error (network blip) emits `error` on the Connection object but no handler — Node's default behavior is to crash the process. May or may not be desired; document.

### LO-07: `index.ts:9-29` comment is outdated
Says "Fastify app factory, route handlers, DB-backed registry impls, Dockerfile, and the standalone-server example land in subsequent PRs" but all of those landed in this PR. Update.

### LO-08: `tenants/index.ts` re-exports `withPgTransaction` from `registry-postgres.js`
`tenants/index.ts:48`. Public surface is reasonable. But since CR-01 means no one actually uses it from the server's own code, document its intended consumer (downstream apps embedding the package).

### LO-09: `redactSecrets` cycle handling stores the redacted output back into `seen`
`redact.ts:63, 78`. Correct, but the second call site (`seen.set(value as object, out)` at line 78) sets the partially-constructed `out` while we're still walking children. If a cycle hits a key in SENSITIVE_KEYS during the same walk, the cycle re-entry returns a half-built object. Defensive; probably no real bug because cycles in audit payloads are rare.

### LO-10: Magic numbers without named constants
- `idempotency.ts`: TTL parameter is per-call; no default constant.
- `tenant-invoices.ts:110`: `customId: \`${tenant.tenantRef}-pos-01\`` — hardcoded `pos-01`.
- `run.ts:54`: `DEFAULT_EGS_MODEL = "ZATCA Standalone Server"` (good — named).

### LO-11: `payload` field in `apiKey.issued` audit row carries label only
`admin-api-keys.ts:60`. Inconsistent with other audit writes that use `redactSecrets({...})`. `label` is plain text, so safe — but the pattern variation will confuse maintainers.

### LO-12: `noop-cipher.ts:42` uses `!isDev && options.acknowledgeUnsafe !== true`
The compound boolean is correct but reads better as `if (env !== "development" && !options.acknowledgeUnsafe)`. Style only.

### LO-13: HEALTHCHECK pin to port 3000 in Dockerfile
`Dockerfile:64`. If operator overrides `ZATCA_SERVER_PORT` via env, the healthcheck still pings :3000 and fails. Document, or pass through env: `node -e "fetch('http://127.0.0.1:' + (process.env.ZATCA_SERVER_PORT || 3000) + '/healthz')..."`.

---

## NOTES

### NO-01: scrypt cost parameters use Node defaults
`registry-{memory,postgres,mongo}.ts` — `scrypt(token, salt, 32)` uses Node defaults (N=16384, r=8, p=1). Below OWASP 2024 recommendation (N=2^17 for high-security). Tokens have ~160 bits of entropy (32 base32 chars), so the brute-force surface is dominated by token entropy, not hash cost — defaults are acceptable. **But document this and add a `scryptCost` option for operators who want stronger.**

### NO-02: Per-tenant `apiKeys.resolve` is O(n) over the tenant's keys
Linear scan with scrypt-per-row. A tenant with hundreds of revolved keys pays N*scrypt per auth. Negligible in practice (most tenants have 1-5 active keys) but watch for the pathological case.

### NO-03: `revokeAllForTenant` doesn't fire CASCADE because softDelete doesn't actually DELETE
The schema has `ON DELETE CASCADE` from api_keys / credentials to tenants. `softDelete` does an UPDATE, not DELETE — so CASCADE never fires. Correct (audit retention requires keeping the rows), but worth noting because the schema-level invariant suggests cascade-deletion is the intended path. If anyone ever writes a `hardDelete` route, the cascade will wipe credentials irrecoverably.

### NO-04: 403 vs 401 distinction is intentional but documented as security-conscious — the doc could be strengthened
`tenant-bearer.ts:53-61`. The comment says "the token IS valid, just not for this tenant" — accurate. Operator's note in the prompt also acknowledges this. But this is the kind of decision worth a SECURITY.md callout, not just a code comment, because the next person to come along will quite reasonably try to "tighten security" by collapsing it to 401 and break audit-trail diagnostics.

### NO-05: `tenantBearer` enforces tenant binding at HTTP layer; `apiKeys.resolve` also does it at store layer
Defense in depth. Even if a route handler forgot to call `tenantVerifier.verify`, the store's `resolve` filters by `tenant_ref = parsed.tenantRef`. Good — but note that **a token forged with a fake tenantRef segment** (`zts_live_victim_AAAA...`) would fail at the scrypt step because no row matches that tenant_ref + the attacker's hash. Solid.

### NO-06: `verbatimModuleSyntax` / `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` conformance
Spot-checked: route files use `req.params.ref` directly (with Fastify typing, this is `string`, OK). `result.rows[0]?.state` patterns honor `noUncheckedIndexedAccess`. The conditional spread idiom `...(x !== undefined ? { key: x } : {})` is repeated everywhere — works around `exactOptionalPropertyTypes`. Tedious but correct. Some files (`registry-postgres.ts:156`, `audit/log-postgres.ts:56`) end with `as unknown as TenantRecord` casts — TS-escape-hatch, but the surrounding code does the field-by-field copying that justifies the cast. Acceptable.

### NO-07: Tests cover stores + crypto + auth + onboarding wrapper; routes are tested only via `app.test.ts` end-to-end
No direct unit tests for `admin-tenants.ts`, `admin-api-keys.ts`, `admin-onboard.ts`, `tenant-invoices.ts`. The most defect-prone files (routes, where CR-03 and CR-04 live) have the least dedicated test surface. **Recommend route-level integration tests for at least:**
  - CR-04 (cross-tenant revoke): explicit test that DELETE `/v1/tenants/A/api-keys/<B-tokenId>` returns 404.
  - CR-02 (NULL claim expiry): seed a tenant in the wedged state and assert `/unlock` recovers it.
  - CR-03 (idempotency): two concurrent `/onboard` calls with the same Idempotency-Key produce one OTP burn and identical responses.
  - HI-05 (vault-then-state ordering): inject a `setState` failure at the final transition and assert the next `/onboard` doesn't burn a fresh OTP.

### NO-08: The split between three tenant interfaces is held to the letter; the architect's intent is reflected in the code
Per the prompt: "the 3 split interfaces (TenantStore + CredentialVault + ApiKeyStore) were a deliberate architect-reviewed choice." The split is clean and the rationale (different read patterns, different threat models, plug-different-backends) is visible in the code. No proposal to merge.

### NO-09: `pg-mem` workarounds (BYTEA → base64 TEXT, JSON read-modify-write) are correctly documented and don't appear to introduce correctness issues against real Postgres
Spot-checked: `setProductionExpiry` uses `::timestamptz` cast (pg-mem comment is honest); `onboarding_progress` RMW is bounded by the application-level lock; api_key hash/salt as base64 TEXT round-trips identically in real PG (just 33% larger). One concern (CR-02 via the partial-index workaround) is unrelated to pg-mem and exists in real PG too.

### NO-10: `tenant-invoices.ts:89-92` blocks invoice issuance when state !== production-ready
This makes `check-compliance` unusable for tenants that have not yet reached production-ready — but compliance checks are supposed to run *during* the compliance phase. Likely a UX bug, but technically the route demands signing material that is only fully populated post-CSID, so requiring production-ready makes some sense. Flag for product/spec review rather than code review.

### NO-11: Master key rotation story (kid-versioned envelope) is well-implemented and operationally sound
`aes-gcm-cipher.ts` is the cleanest file in the PR. Comments explain the rotation procedure clearly; the IV / kid handling is correct; the auth-tag check is in the right place. No findings.

### NO-12: `bootMemory` in `cli.ts:53-78` allows `STORAGE_DRIVER=memory` in production
If someone misconfigures and ships with `STORAGE_DRIVER` unset (defaults to `memory` per `resolveDriver`), the production server runs entirely in-process. Server restart = total data loss. Consider refusing `memory` outside `NODE_ENV=development`, mirroring `noop-cipher`'s guard.

---

_Reviewed: 2026-05-17_
_Reviewer: Adversarial code review pass (pre-`/ultrareview`)_
_Depth: deep (cross-file analysis on auth, transactions, lock semantics, secret handling)_
