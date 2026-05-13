# Phase 4 — ZATCA API Client

**Status:** pending
**Agent:** backend-developer
**Estimated effort:** 1 session

## Goal

Replace the rwiqha helper's `makeHttpRequest` wrapper (which depends on the host's `got`-based abstraction) with a portable, native-`fetch`-based ZATCA API client in `packages/core/src/api/`. Implement: compliance check, clearance/reporting submit, cancel, status, compliance certificate issuance, CSID issuance. Add retry-with-backoff for 5xx + network errors. Remove debug logging and the simulated CSID dev fallback.

## Source files to read first

- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.package/classes/zatca.check.invoice.complaince.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/zatca.package/classes/zatca.single.invoice.reporting.or.clearance.status.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.cancel.invoice.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.check.invoice.status.with.db.update.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.issue.compliance.certificate.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.issue.csids.function.ts`
- `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/functions/zatca.csids.api.function.ts`

## Files to create

```
packages/core/src/api/
├── index.ts
├── endpoints.ts                 # sandbox/simulation/production base URLs
├── http-client.ts               # fetch-based client with retry, backoff, timeout, error normalization
├── compliance.ts                # checkInvoiceCompliance
├── clearance-reporting.ts       # singleInvoiceReportingOrClearanceStatus (auto-routes by invoice type)
├── cancel-invoice.ts            # cancelInvoice
├── check-status.ts              # checkInvoiceStatus
├── issue-compliance-cert.ts     # issueComplianceCertificate
├── issue-csids.ts               # issueCSIDS (production CSID)
└── *.test.ts                    # one per module, msw-mocked
```

## HTTP client design

```ts
// http-client.ts
export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  retries?: { count: number; baseMs: number; jitterMs: number };
  fetch?: typeof fetch;  // injectable for tests
}

export async function request<TResponse>(
  client: HttpClientOptions,
  args: { method: "GET" | "POST"; path: string; headers?: Record<string, string>; body?: unknown }
): Promise<TResponse> { /* ... */ }
```

Behavioural requirements:
- **Use native `fetch`** by default (Node 20+).
- **Timeout:** `AbortController` with default 30s.
- **Retry:** default 3 attempts on 5xx and `TypeError`/network errors. NO retry on 4xx.
- **Backoff:** exponential `base * 2^attempt + jitter`. Default `base = 250ms`, `jitter = 0..250ms`.
- **Error normalization:** all non-2xx responses parsed and thrown as `ZatcaApiError` with `{statusCode, validationResults, requestId, rawResponse}`.
- **No logging** in production paths. Optional `debug(namespace, msg)` calls gated by `process.env.DEBUG` and the `debug` package — but no `console.log` anywhere.

## Endpoints

```ts
// endpoints.ts
export const ZATCA_ENDPOINTS = {
  sandbox: {
    base: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
    compliance: "/compliance/invoices",
    clearance: "/invoices/clearance/single",
    reporting: "/invoices/reporting/single",
    complianceCertificate: "/compliance",
    csids: "/production/csids",
  },
  simulation: { /* ... */ },
  production: { /* ... */ },
} as const;
```

Verify exact paths against rwiqha source. Provide override via `client.baseUrl`.

## Things to REMOVE (vs. rwiqha source)

1. **Debug token-logging block** in `zatca.check.invoice.complaince.ts` that prints `🔐 ZATCA Authentication Debug:` with truncated tokens. Open-source libraries must not log secrets, even truncated.
2. **Simulated CSID dev fallback** in `zatca.csids.api.function.ts` (`if (!isProduction && !creds) { return mockResponse; }`). Users must hit a real sandbox.
3. **`@hapi/boom`** errors. Throw `ZatcaApiError` (from Phase 1 types).
4. **`makeHttpRequest` wrapper.** All HTTP goes through the new client.

## Test strategy

Use `msw` (Mock Service Worker, ^2.x) to mock ZATCA API responses in unit tests. Record real ZATCA error envelopes from the rwiqha helper's logs (sanitize tokens) and assert that the error normalization parses them correctly into `ZatcaApiError.validationResults`.

## Dependencies to add

In `packages/core/package.json`:
- `debug` (^4.x) — only used inside `debug("zatca:http")` calls, no `console.*`
- `@types/debug` (devDep)

In devDependencies:
- `msw` (^2.x)

## Exit tests

1. `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test` all pass.
2. Each API method has at least one happy-path test and one error-path test against msw.
3. `grep -RE "console\\.(log|error|warn|info|debug)" packages/core/src` returns nothing.
4. `grep -R "@hapi/boom" packages/core/src` returns nothing.
5. `grep -R "makeHttpRequest" packages/core/src` returns nothing.
6. `grep -RE "isProduction.*=== false" packages/core/src/api` returns nothing matching a mock-fallback pattern (manual review acceptable here).
7. Retry-with-backoff: timing test asserts 3 attempts on a 503 response and that 4xx is not retried.

## What this phase does NOT do

- No onboarding orchestration (combining cert issuance with key gen + CSR) — Phase 6.
- No compliance test runner — Phase 6.
- No examples — Phase 7.
