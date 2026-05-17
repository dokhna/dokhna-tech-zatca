---
phase: pr-29-feat-zatca-server-pass-2
reviewed: 2026-05-17T00:00:00Z
depth: deep
files_reviewed: 18
files_reviewed_list:
  - packages/server/src/app.ts
  - packages/server/src/cli.ts
  - packages/server/src/config.ts
  - packages/server/src/errors.ts
  - packages/server/src/auth/admin-keys.ts
  - packages/server/src/auth/tenant-bearer.ts
  - packages/server/src/audit/log.ts
  - packages/server/src/audit/log-postgres.ts
  - packages/server/src/audit/redact.ts
  - packages/server/src/middleware/errors.ts
  - packages/server/src/middleware/idempotency.ts
  - packages/server/src/middleware/semaphore.ts
  - packages/server/src/observability/metrics.ts
  - packages/server/src/onboarding/run.ts
  - packages/server/src/routes/admin-api-keys.ts
  - packages/server/src/routes/admin-onboard.ts
  - packages/server/src/routes/admin-tenants.ts
  - packages/server/src/routes/tenant-invoices.ts
  - packages/server/src/routes/ops.ts
  - packages/server/src/routes/deps.ts
  - packages/server/src/tenants/registry-memory.ts
  - packages/server/src/tenants/registry-mongo.ts
  - packages/server/src/tenants/registry-postgres.ts
findings:
  critical: 1
  warning: 7
  info: 3
  total: 11
status: issues_found
---

# PR #29 (`feat/zatca-server`) — Local Code Review, Pass 2

**Reviewed:** 2026-05-17 (second local pre-`/ultrareview` pass)
**Reviewer:** Adversarial / FORCE stance
**Scope:** Regression check on the 19 fix commits since pass 1, plus any new defects the fixes introduced

## Summary

The fix pass landed cleanly on most fronts — CR-01 (transactional UoW), CR-04 (tenant-scoped revoke), HI-01/HI-02 (redaction hardening), HI-03 (constant-time admin compare), HI-08 (status-routing via code field), ME-02 (upstream-status remap), ME-09 (audit-action override), ME-11/ME-12 (cheap+sanitized /readyz), ME-15/ME-16 (configurable trust + per-route timeout), ME-17/ME-19 (tenant pre-check + active-only default), and ME-25 (audit payload cap) all check out under read-through.

The one critical regression is in the CR-02 fix itself: adding `"onboarding"` to `runOnboarding`'s `expectedFrom` loop broadened the per-backend CAS predicate to match a **fresh** onboarding claim, not just a stale one. Under contention this lets a second instance steal a still-held lock and run a concurrent onboard.

The other findings are operator-facing quality issues introduced or left open by the fix pass — `/readyz` is fine but Fastify's setErrorHandler silently swallows the ME-06 diagnostic; the idempotency state machine has a lease-token gap; the metrics gauge grows monotonically as tenants are revoked; the onboardingTotal counter only increments on success; replays return `text/plain` instead of `application/json`; the semaphore is honestly per-process but the 503 message reads as global.

---

## CRITICAL

### CR2-01: CAS predicate steals fresh onboarding locks when `expectedFrom='onboarding'` is tried
**Files:**
- `packages/server/src/onboarding/run.ts:249` (loop now includes `"onboarding"`)
- `packages/server/src/tenants/registry-postgres.ts:357-362` (CAS first branch `state = $7`)
- `packages/server/src/tenants/registry-mongo.ts:416-430` (CAS first $or branch `{ state: opts.expectedFrom }`)
- `packages/server/src/tenants/registry-memory.ts:212-220` (`existing.state !== options.expectedFrom && !lockNotHeld`)

**Issue:** The CR-02 fix added `"onboarding"` to the `expectedFrom` loop. All three CAS predicates have the same shape:
```sql
state = $expectedFrom
OR
(state = 'onboarding' AND (claim_expires_at IS NULL OR claim_expires_at <= now))
```
When `expectedFrom='onboarding'`, **the first branch trivially matches any onboarding row regardless of `claim_expires_at`** — including a fresh lock held by another instance. The second (stale-only) branch is effectively dead in this case.

Race that triggers it:
1. Instance A reads tenant in state=`created`. Pre-flight passes.
2. A's setState CAS from `created` → `onboarding` succeeds. `claim_expires_at = T+180s`.
3. Instance B reads tenant a moment earlier than A's setState lands — still sees state=`created` (or `failed`/`production-ready`). Pre-flight (run.ts:224–236) passes because state is not yet `onboarding`.
4. B's CAS loop tries `expectedFrom='created'` (fail, A is now onboarding), then `'failed'`, then `'production-ready'`, then `'onboarding'` — which **matches A's fresh row via `state = $7`**. B's setState succeeds, replaces `claimed_by` with B's instance id, resets `claim_expires_at` to a new T+180s.
5. Both A and B now believe they own the slot. Both run `core.onboard()`. Both burn a separate OTP (or one ZATCA call fails partway). On race-completion the `production-ready` setState CAS at run.ts:346 races; one wins, the other rolls back the UoW. The OTP is gone either way.

The pre-flight (run.ts:224–236) was the only thing protecting fresh claims, and a snapshot read can be stale by any amount of time relative to the CAS.

**Why it matters:** The entire purpose of the lock is to make concurrent onboarding mutually exclusive. The CR-02 fix solved the wedged-NULL case but reopened the steal-fresh-lock case the original CAS specifically defended against. Burns OTPs on a real race; depending on which ZATCA stage each instance reached, a tenant could end up with mismatched vault material and audit history.

**Suggested fix:** Require the stale predicate whenever `expectedFrom` is `'onboarding'`. Tighten the CAS to:
```sql
-- Postgres
WHERE tenant_ref = $1
  AND deleted_at IS NULL
  AND (
    (state = $7 AND $7 <> 'onboarding')
    OR (state = 'onboarding' AND (claim_expires_at IS NULL OR claim_expires_at <= $3))
  )
```
Equivalent for Mongo:
```js
{
  _id: tenantRef, deletedAt: { $exists: false },
  $or: [
    { state: opts.expectedFrom, ...(opts.expectedFrom === 'onboarding' ? { _impossible: true } : {}) },
    { state: 'onboarding', $or: [{ claimExpiresAt: { $lte: now } }, { claimExpiresAt: null }, { claimExpiresAt: { $exists: false } }] },
  ],
}
```
And the memory check at registry-memory.ts:215 becomes:
```ts
const expectedFromMatches =
  existing.state === options.expectedFrom && options.expectedFrom !== "onboarding";
if (!expectedFromMatches && !lockNotHeld) { throw ... }
```
Add a regression test that:
- seeds two callers, A acquires from `created`, B's pre-flight is mocked stale, and B's CAS chain is exercised. Expect B's `expectedFrom='onboarding'` CAS to throw `ZatcaRegistryError(code:'conflict')` rather than succeed.

---

## HIGH

(none)

---

## WARNING

### WR2-01: `IdempotencyStore.commit` doesn't verify the slot still belongs to the committer
**File:** `packages/server/src/middleware/idempotency.ts:126-134`

**Issue:** The state machine documented at lines 50–69 says "every `begin` that returns `claimed` MUST be followed by exactly one of `commit` or `release`." But the in-memory `commit` doesn't carry a lease/token from `begin`. Failure mode:

1. Caller A `begin`s, gets `claimed`. TTL = idempotencyWindowMs (default 24h).
2. A's request hangs (e.g. ZATCA blocking 180s + the surrounding `connectionTimeout: onboardingTimeoutMs + 10_000` fires).
3. A's slot has not yet expired (TTL is 24h, far longer than the per-request timeout), but the route handler aborted. Nothing called `release`.
4. Hours pass; the slot expires.
5. Caller B `begin`s, claims a fresh slot, starts running.
6. Caller A's awaited `commit` finally resolves (the promise chain landed after the connection died — rare but possible with detached awaits in unusual error paths). A's commit overwrites B's still-in-flight entry with A's response. Concurrent retries of B see A's committed response.

Within the documented per-request timeouts and the 24h TTL the race is narrow but not zero — and once the contract is dropped into a Redis-backed implementation (as the doc invites at lines 18–22), the lease semantics will be load-bearing.

A second misuse trap, separate but in the same function: `commit` of an already-`committed` key silently overwrites the prior response. If a route gains a double-commit bug, replays will start returning whichever commit ran last with no warning.

**Suggested fix:** Have `begin` return an opaque lease token; `commit(key, token, response, ttl)` and `release(key, token)` verify the token matches the in-flight slot before mutating. Reject commits that don't match (already expired and replaced, or already committed) with a typed error so the route can decide whether to log-and-continue or 500.

### WR2-02: Idempotency-replay path drops the response content-type
**Files:**
- `packages/server/src/routes/admin-onboard.ts:80-82, 254-258, 338-342`
- `packages/server/src/routes/tenant-invoices.ts:91-94, 331-335`

**Issue:** On commit, the captured `CachedResponse` is `{ statusCode, headers: {}, body: JSON.stringify(responseBody) }` — headers is an empty object. On replay, `beginIdempotency` does `for (const [k, v] of Object.entries(result.response.headers)) reply.header(k, v); ... reply.code(...).send(result.response.body)`. Fastify's `reply.send(string)` defaults the content-type to `text/plain` when no header was set, while the original (live) response is serialized from an object and sent as `application/json`.

Net behaviour: first call returns parsed JSON with `Content-Type: application/json`; replay returns the same JSON string but with `Content-Type: text/plain; charset=utf-8`. Clients that key on the content-type (most generated SDK clients do) will fail to parse the replay.

**Why it matters:** Silent protocol divergence between live and replay. Defeats the "idempotent retries return byte-identical responses" promise.

**Suggested fix:** Capture `Content-Type` in the cached response, default to `application/json; charset=utf-8` when committing the success path:
```ts
const headers: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
};
if (zatcaRequestId !== undefined) headers["X-Zatca-Request-Id"] = zatcaRequestId;
await commitIdempotency(deps, idem.cacheKey, idem.ttl, {
  statusCode: 200,
  headers,
  body: JSON.stringify(responseBody),
});
```
Or have the replay branch `reply.type("application/json").code(...).send(body)`.

### WR2-03: Wrong-tenant diagnostic on `Error.cause` is never logged server-side (ME-06 regression)
**Files:**
- `packages/server/src/auth/tenant-bearer.ts:53-66`
- `packages/server/src/app.ts:207-213` (global error handler)
- `packages/server/src/errors.ts:90-97`

**Issue:** ME-06's fix collapses 403-on-wrong-tenant to 401-on-invalid-key and "buries the diagnostic on Error.cause" — but the global error handler at app.ts:207–213 only calls `mapErrorToResponse` then `reply.code/send`. It never inspects `err.cause` or calls `req.log.error(...)`. Fastify's default request-level error log is suppressed when `setErrorHandler` is supplied, so the diagnostic `{ reason: "wrong_tenant_bearer", presentedTenantRef, expectedTenantRef }` set by tenant-bearer.ts:61–65 is silently discarded.

Operators end up with the same line in the log for "valid bearer wrong tenant" and "invalid token entirely" — exactly the diagnostic capability the fix promised to retain.

**Why it matters:** The fix traded operator diagnostic for attacker information-hiding; without the log line, only the attacker-hiding half landed.

**Suggested fix:** Have the global handler log every mapped error:
```ts
server.setErrorHandler((err, req, reply) => {
  const mapped = mapErrorToResponse(err);
  // Always log; the audit log captures business events, this is the operator's eyes on auth failures.
  if (mapped.statusCode >= 500) {
    req.log.error({ err, cause: (err as { cause?: unknown })?.cause }, "request errored");
  } else if (mapped.statusCode === 401 || mapped.statusCode === 403) {
    req.log.warn({ err, cause: (err as { cause?: unknown })?.cause, name: (err as Error).name, msg: (err as Error).message }, "auth failure");
  }
  for (const [k, v] of Object.entries(mapped.headers)) reply.header(k, v);
  return reply.code(mapped.statusCode).send(mapped.body);
});
```

### WR2-04: Cancel route persists local "cancelled" status without transactional integrity vs the audit row
**File:** `packages/server/src/routes/tenant-invoices.ts:388-418`

**Issue:** Cancel flow is:
```ts
try {
  result = await cancelInvoice({...});                                    // ZATCA call
  await deps.storage.updateInvoiceStatus(scope, req.params.invoiceId, "cancelled");
} catch (err) {
  cancelStatus = "error";
  if (err instanceof ZatcaApiError) zatcaRequestId = err.requestId;
  throw err;
} finally {
  await deps.auditLog.write({ ..., result: cancelStatus, ... });
}
```
If `cancelInvoice` (the ZATCA hop) succeeds but the **local** `updateInvoiceStatus` throws (DB blip, schema drift, network blip to the storage adapter), control falls into the `catch`:
1. `cancelStatus` is flipped to `"error"`.
2. `err` is the storage error, NOT a `ZatcaApiError`, so `zatcaRequestId` stays undefined.
3. The audit row records `result: "error"` for an invoice that ZATCA already cancelled.
4. The client gets a 5xx and may retry; ZATCA returns "already cancelled".

**Why it matters:** The audit log is the compliance system of record. A successful ZATCA cancel that's audited as `error` corrupts the compliance view; an operator triaging this row has no signal that the upstream actually succeeded.

The same shape exists in the invoice POST at lines 267–294: a ZATCA-accepted submission followed by a local `updateInvoiceStatus` failure produces a 5xx and (in this case) leaves `status` unchanged in the local store while ZATCA holds the accepted record. Neither of these mutations is inside `withUnitOfWork` (storage isn't part of the UoW by current design — the UoW only covers tenants/vault/apiKeys/auditLog).

**Suggested fix:** Track the ZATCA result independently of the local write. If `cancelInvoice` resolved successfully, set `cancelStatus = "ok"` BEFORE attempting the local update; if the local update fails, audit it as a separate `invoice.cancelled-locally-pending` event and re-raise. Or — broader change — fold `deps.storage` into the UoW so the local status update and the audit row commit atomically (Postgres can do this; the storage adapter would need a tx-scoped variant).

At minimum, capture the upstream `requestId` BEFORE the local update so the audit row preserves the ZATCA correlation id even when the local write fails:
```ts
try {
  result = await cancelInvoice({...});
  if (result is shaped { requestId }) zatcaRequestId = result.requestId;
  await deps.storage.updateInvoiceStatus(scope, req.params.invoiceId, "cancelled");
} catch ...
```

### WR2-05: `productionCertExpirySeconds` gauge series grows monotonically — revoked-tenant labels never cleared
**File:** `packages/server/src/app.ts:174-203`, `packages/server/src/observability/metrics.ts:86-91`

**Issue:** The hourly refresh hook lists `includeDeleted: false` then calls `metrics.productionCertExpirySeconds.set({ tenant: t.tenantRef }, ...)` for each active tenant. When a tenant is soft-deleted or revoked, the next refresh skips it — but the gauge's prior label series stays around in the prom-client registry at its last-set value (which is now stale). Over time, the series count grows by the total number of revoked tenants ever held.

For a deployment that runs months with frequent tenant lifecycle churn, this is a slow-burn cardinality leak in Prometheus exactly of the kind ME-14 was trying to prevent on the `invoices*` counters.

**Why it matters:** ME-14 dropped the `tenant` label on counters precisely because of cardinality. The PR's defense for keeping `tenant` on this gauge is "cardinality is bounded by the tenant population" — but only if the gauge is pruned. It isn't.

**Suggested fix:** Reset the gauge before each refresh and only re-set for the current active set:
```ts
async function refreshRegistryGauges(): Promise<void> {
  try {
    const tenants = await options.registry.tenants.list({ includeDeleted: false });
    metrics.activeTenants.set(tenants.length);
    metrics.productionCertExpirySeconds.reset();  // <-- add
    const now = Date.now();
    for (const t of tenants) {
      const expiry = t.productionCertificateExpiresAt;
      if (expiry !== undefined) {
        metrics.productionCertExpirySeconds.set(
          { tenant: t.tenantRef },
          Math.floor((expiry.getTime() - now) / 1000),
        );
      }
    }
  } catch (err) { ... }
}
```
Or use `metrics.productionCertExpirySeconds.remove({ tenant })` for tenants no longer present, computed via a diff of last-refresh.

### WR2-06: `onboardingTotal` counter only increments on success — `failed`/`locked` outcomes never observed
**Files:**
- `packages/server/src/routes/admin-onboard.ts:243-272` (onboard route)
- `packages/server/src/routes/admin-onboard.ts:332-352` (rotate route)
- `packages/server/src/observability/metrics.ts:66-71` (declared with three outcomes)

**Issue:** The counter is declared `outcome: "succeeded" | "failed" | "locked"` and helped as "Count of onboarding attempts grouped by outcome." Only the `succeeded` increment exists, inside the onboard route's try block at admin-onboard.ts:244–246. The rotate route increments nothing. The catch block at admin-onboard.ts:260–263 (and the symmetric rotate one at 344–347) increments nothing — both just `releaseIdempotency` and rethrow.

The 503-throttled path at admin-onboard.ts:200–201 returns before reaching the inner try block, so `outcome: "locked"` also never fires.

**Why it matters:** A dashboard built on `rate(zatca_onboarding_total{outcome="failed"}[5m])` will read 0 forever, hiding real failure waves. Same for `locked` — the operator cap event is what `outcome: "locked"` was supposed to surface.

**Suggested fix:** Increment in all three branches:
- Around line 245 (succeed): keep.
- In the catch around line 261 (failed): add `deps.metrics?.onboardingTotal.inc({ outcome: "failed" })`.
- In the 503 branch before returning (locked): add the same with `outcome: "locked"`.
- Mirror in the rotate route.

### WR2-07: Idempotency-Key is optional on OTP-burning routes — TCP retry without one still burns a second OTP
**Files:**
- `packages/server/src/routes/admin-onboard.ts:74-76, 211-212` (onboard)
- `packages/server/src/routes/admin-onboard.ts:295-296` (rotate)

**Issue:** `beginIdempotency` short-circuits with `proceed: true, cacheKey: undefined` when no `Idempotency-Key` header is presented. The route then runs `runOnboarding` with no replay protection. A client/load-balancer TCP retry of an `/onboard` POST that lost its first connection mid-flight still burns a second OTP.

The previous review's CR-03 explicitly recommended "At minimum, require `Idempotency-Key` on `/onboard` and `/credentials/rotate` — refuse without it." The fix made the header **optional** rather than required.

**Why it matters:** OTPs are operationally expensive (Fatoora-issued, human-action-bound). The whole point of CR-03 was that absent idempotency, retries burn OTPs. Making the protection opt-in moves the foot-gun from server to operator-coordination.

**Suggested fix:** Require the header on `/onboard` and `/credentials/rotate`. If absent, return 400 with a clear "Idempotency-Key header is required for OTP-burning routes" message. Document the requirement in the operator README. Clients that legitimately want fire-and-forget can supply a generated UUID.

---

## INFO

### IN2-01: Onboarding 503 message reports `capacity` as if it were `inFlight`; "Server" reads as global
**File:** `packages/server/src/routes/admin-onboard.ts:176-180`

**Issue:** The message reads:
```
Server is at its onboarding concurrency cap (${deps.onboardingSemaphore.capacity} in flight). Retry after a short delay.
```
Two confusions:
1. `capacity` is the configured maximum, not the current `inFlight`. The English template "(N in flight)" suggests it's the current count.
2. "Server" reads as global. The semaphore is documented in semaphore.ts:1–13 as in-process only; in multi-replica deployments, each replica enforces its own cap independently. An operator reading the message could assume a global cap and tune accordingly.

**Suggested fix:** Use the explicit field and qualify scope:
```
This replica is at its onboarding concurrency cap (${deps.onboardingSemaphore.inFlight}/${deps.onboardingSemaphore.capacity} in flight). Note: the cap is per-replica, not global. Retry after a short delay.
```

### IN2-02: Semaphore is acquired BEFORE idempotency replay check — replays consume a slot
**File:** `packages/server/src/routes/admin-onboard.ts:200-213`

**Issue:** `acquireOnboardingSlot` runs before `beginIdempotency`. A flurry of retries with the same `Idempotency-Key` — which are supposed to be cheap O(1) cache lookups — each acquire and release a semaphore slot. Under burst load this can falsely trigger the 503 throttle even though the actual work is just a memory map read.

**Suggested fix:** Idempotency-check first; only acquire the semaphore when `idem.proceed === true` (i.e. there's actual work to do). Move `acquireOnboardingSlot` after the `if (!idem.proceed) return reply;` guard.

### IN2-03: `lockTtlMs` set from `onboardingTimeoutMs` but onboarding can outrun the TTL on slow ZATCA hops
**File:** `packages/server/src/routes/admin-onboard.ts:231` passes `lockTtlMs: deps.config.onboardingTimeoutMs`; `packages/server/src/onboarding/run.ts:247` uses it as the lock expiry

**Issue:** Lock TTL and the per-request socket timeout are now equal (both default to 180s). If `core.onboard()` takes 175s and then `setProductionExpiry`+`setState` together take 8s, the lock has already expired by 3s and a concurrent retry would see a stale-onboarding row. Under the WR2-01/CR2-01 stack, that means another instance could now CAS-steal the slot. Without a margin, the failure mode is not theoretical — the lock TTL should comfortably exceed the worst-case post-onboard local-write time.

**Suggested fix:** Set `lockTtlMs = config.onboardingTimeoutMs + 30_000` (or some configurable margin). Document the relationship in the operator README.

---

## NOTES

### NO2-01: HI-11 fix has the right shape but the lease-token gap (WR2-01) is the load-bearing detail
The previous review's HI-11 recommendation (a) was "introduce explicit states: `inFlight | committed`" — done. The supplemental "with `start(key) → token` / `commit(key, token, response)` / `getCommitted(key)`" — not done. The current shape is correct for the single-replica common case; it'll bite on a Redis-backed multi-replica deployment.

### NO2-02: ME-06 collapse to 401 leaves tenant existence un-leakable but loses operator diagnostic
The 401-for-both fix is correct on its security premise (no longer leaks tenant existence to a holder of any valid bearer). The diagnostic-via-`Error.cause` is the right place to put the operator-side detail — but it currently goes nowhere because of WR2-03. Fixing WR2-03 reinstates the diagnostic without giving anything back to the attacker.

### NO2-03: HI-09 fix is clean — `SafeServerConfig` strips the raw bytes; routes get only `cipher` and verifiers
Spot-checked toSafeServerConfig in config.ts:105–108 and the deps wiring in app.ts:134–149: the raw `masterKeys` / `activeKid` / `adminKeysRaw` are removed from the type passed through `deps.config`. A stray `log.info({ config: deps.config }, ...)` from any route would no longer dump the secret material. The raw fields are consumed once at boot, then dropped.

### NO2-04: ME-04 debounce uses an in-process Map; correctness depends on a single replica
The Postgres `lastUsedWriteAt` map in `createPostgresApiKeyStore` (registry-postgres.ts:675) is per-process. In a multi-replica deployment each replica has its own debounce window, so the worst-case write-rate is (replica count) × (1/60s). That's still fine for the originally-cited 100 req/s problem, but worth noting that the fix isn't strictly equivalent to a 1/min global debounce. Not a defect.

### NO2-05: NO-12 (memory driver in production) still open — not on the "do not re-flag" list but documented as deferred
The cli.ts driver resolution still accepts `STORAGE_DRIVER=memory` (or unset, which defaults to memory) regardless of `NODE_ENV`. Previous review's NO-12 flagged this. Carrying forward as a NOTE.

### NO2-06: Outstanding from pass 1 — re-check
| Pass 1 id  | Status                                                                                             |
|------------|----------------------------------------------------------------------------------------------------|
| CR-01      | Fixed via `withUnitOfWork` threaded through every mutating route. Verified `admin-tenants.ts:133`, `:192`, `:218`; `admin-api-keys.ts:57`, `:117`; `admin-onboard.ts:419`; `onboarding/run.ts:334`. |
| CR-02      | Partially fixed — NULL-expiry recovery works (verified via app.test.ts:381), but the fix introduces CR2-01 above. |
| CR-03      | Wired but optional — see WR2-07.                                                                  |
| CR-04      | Fixed — verified `admin-api-keys.ts:117-118` passes both `ref` and `tokenId`; store impls add tenant predicate. |
| HI-01      | Fixed — `redact.ts:138-141` short-circuits Buffer/TypedArray/ArrayBuffer.                        |
| HI-02      | Fixed — case-insensitive lookup + expanded list + regex fallback.                                 |
| HI-03      | Fixed — SHA-256-then-timingSafeEqual.                                                              |
| HI-04      | Fixed — `admin-tenants.ts:218-228` bundles softDelete + revokeAllForTenant + audit in UoW.       |
| HI-05      | Fixed — vault.put now inside the same UoW as setState + audit at `run.ts:334-362`.               |
| HI-06      | Fixed — `/unlock` accepts NULL claimExpiresAt; force flag added.                                  |
| HI-07      | Fixed — `statusHint` on `ZatcaServerError`, mapped at `errors.ts:154`.                            |
| HI-08      | Fixed — `code` field on `ZatcaRegistryError`, mapped at `errors.ts:176-183`.                      |
| HI-09      | Fixed — `SafeServerConfig` strips the raw bytes (NO2-03).                                         |
| HI-10      | Fixed — Mongo `put` builds `$unset` for absent compliance fields (registry-mongo.ts:557-572).    |
| HI-11      | Fixed in shape, lease-token gap remains — see WR2-01.                                             |
| ME-01      | Fixed — `TENANT_REF_RE` allow-list in `admin-tenants.ts:47`.                                      |
| ME-02      | Fixed — upstream 401/403 → 502, 429 → 503 with retry-after (errors.ts:104-120).                  |
| ME-03      | Fixed — pino redact wildcards in `observability/logger.ts` (re-verified separately).             |
| ME-04      | Fixed — 60s debounce; NO2-04 caveat.                                                              |
| ME-05      | Fixed — `WHERE deleted_at IS NULL` added; throw `already deleted` on second softDelete.          |
| ME-06      | Fixed in shape — see WR2-03.                                                                       |
| ME-07      | Fixed — `_egsInfo` dead-store removed.                                                            |
| ME-08      | Fixed — Phase 1 + submit=true now throws (`tenant-invoices.ts:236-244`).                          |
| ME-09      | Fixed — `auditAction` passed from rotate route (admin-onboard.ts:320).                            |
| ME-10      | Deferred (SignerMaterial phantom-brand — out of scope per the "do not re-flag" list).             |
| ME-11      | Fixed — `tenants.ping()` (registry-postgres.ts:479-483; mongo:512-520).                          |
| ME-12      | Fixed — `/readyz` body sanitised (ops.ts:34-38).                                                  |
| ME-13      | Partially fixed — refresh hook lands; `zatcaApiLatencySeconds` removed (deliberate per prompt); gauge cleanup missing (WR2-05). |
| ME-14      | Fixed — `tenant` label dropped from counters; kept on `productionCertExpirySeconds` per design (but see WR2-05). |
| ME-15      | Fixed — `trustProxy` is now `config.trustProxy` (app.ts:103).                                     |
| ME-16      | Fixed — server-level 30s, per-route extension via `req.raw.setTimeout` in admin-onboard.ts:195-197, 282-284. |
| ME-17      | Fixed — `tenants.get` precheck in `admin-api-keys.ts:91-96`.                                      |
| ME-18      | Fixed — `zatcaInvoiceId`/`clearanceNumber` now optional, fall back to record.                     |
| ME-19      | Fixed — default active-only, `?includeRevoked=true` opt-in.                                       |
| ME-20      | Fixed — `revoke` returns `boolean`; route 404s on miss.                                           |
| ME-21      | Fixed — `connection.close()` waits for buffered ops; documented at cli.ts:131-141.               |
| ME-22      | Fixed — TOKEN_RE tightened to `[a-z0-9-]+`.                                                       |
| ME-23      | Fixed — `silent` accepted in `LevelSchema`; `logger` injection seam on `buildApp`.                |
| ME-24      | Fixed — base64 alphabet check before length check (config.ts:145-150).                            |
| ME-25      | Fixed — `capAuditPayload` at 16KB cap, applied in all three audit log impls.                      |
| ME-26      | Deferred (no commit message references it; state still in enum but unreached). Not blocking.     |
| ME-27      | Fixed in-process — see IN2-01 for the message-clarity caveat.                                    |
| LO-02      | Fixed — `fileURLToPath`-based comparison (cli.ts:261-272).                                        |
| LO-03      | Fixed — exit non-zero on shutdown error (cli.ts:250).                                             |
| LO-06      | Fixed — `connection.on('error', ...)` registered before `asPromise` (cli.ts:105-108).             |
| LO-07      | Fixed (per commit 5f293db).                                                                       |
| LO-11      | Fixed — `redactSecrets({label})` (admin-api-keys.ts:70).                                          |
| LO-13      | Fixed — Dockerfile HEALTHCHECK now respects env (out of scope to re-verify).                     |
| LO-01, LO-04, LO-08, LO-09, LO-10, LO-12 | Deferred per the "do not re-flag" list.                                          |

### NO2-07: Test coverage gap — no regression test for CR2-01
The new CR-02 fix has the `re-onboard from a wedged state=onboarding/NULL-expiry succeeds` test in `app.test.ts:381`. There is **no test** asserting that an `expectedFrom='onboarding'` CAS against a row with `claimExpiresAt > now` is REJECTED. Add one before this PR ships, alongside the CR2-01 fix.

---

_Reviewed: 2026-05-17_
_Reviewer: Adversarial code review pass 2 (pre-`/ultrareview`)_
_Depth: deep (cross-file analysis on CAS predicates, transactional UoW, idempotency state machine, error logging chain, metrics cardinality)_
