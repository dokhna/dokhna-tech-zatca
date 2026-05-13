/**
 * Native-`fetch` HTTP client for the ZATCA gateway.
 *
 * Behavioural contract:
 *
 *   - **Native `fetch`** (Node 20+) is used by default. The caller may
 *     inject a custom `fetch` for tests or for advanced TLS / proxy
 *     setups.
 *   - **Timeout** via `AbortController` (default 30s). The timeout
 *     timer is always cleared on resolve/reject — no leaked handles.
 *   - **Retry** on transient failures only:
 *       - 5xx responses,
 *       - `TypeError` (Node's `fetch` reports network errors as
 *         `TypeError`),
 *       - `AbortError` raised by our own timeout abort.
 *     We **do not** retry on 4xx — client errors are deterministic
 *     and a retry would only burn rate limit.
 *   - **Backoff** is exponential with jitter:
 *       delay = baseMs * 2^attempt + random(0, jitterMs)
 *     Defaults: baseMs=250, jitterMs=250, count=3 retries (4 attempts
 *     total).
 *   - **Error normalization** — every non-2xx response is parsed and
 *     thrown as a `ZatcaApiError`. The ZATCA validation envelope
 *     (`validationResults`) is attached when present, along with the
 *     gateway's `requestId` (when surfaced as a header or in the
 *     body) and the raw decoded response for callers that want to
 *     inspect it.
 *   - **Diagnostics** via the `debug` package under namespace
 *     `zatca:http`. Logs method, path, attempt, status — never
 *     headers (would leak `Authorization`) and never bodies (could
 *     leak certificate material or invoice contents).
 */

import debugFactory from "debug";
import { ZatcaApiError } from "../types/errors.js";

const debug = debugFactory("zatca:http");

/**
 * Retry tuning for the HTTP client.
 */
export interface RetryOptions {
  /** Number of retries on top of the initial attempt. */
  count: number;
  /** Base delay in ms for exponential backoff. */
  baseMs: number;
  /** Random jitter (0..jitterMs) added to each backoff. */
  jitterMs: number;
}

/**
 * Configuration for an HTTP client instance.
 *
 * `baseUrl` must not include a trailing slash. `path` arguments must
 * include a leading slash.
 */
export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly retries?: RetryOptions;
  readonly fetch?: typeof fetch;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}

/**
 * A single request issued through the client.
 */
export interface RequestArgs<TBody = unknown> {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: TBody;
  readonly query?: Readonly<Record<string, string>>;
}

/** Default request timeout (ZATCA can take a few seconds on clearance). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default retry profile. 3 retries → 4 attempts total. */
const DEFAULT_RETRY: RetryOptions = {
  count: 3,
  baseMs: 250,
  jitterMs: 250,
};

/**
 * HTTP statuses that ZATCA considers success on the invoice-flow
 * endpoints. `200` is the steady-state response; `202` is returned by
 * the clearance endpoint when the gateway accepts an invoice with
 * warnings.
 */
const SUCCESS_STATUSES: ReadonlySet<number> = new Set([200, 202]);

/** Pluck the `requestId`-like field out of a parsed body or response. */
function extractRequestId(
  response: Response,
  parsed: unknown,
): string | undefined {
  // ZATCA's gateway surfaces a request identifier in a few different
  // shapes across endpoints. Check the common ones.
  const headerCandidates = [
    "x-request-id",
    "x-requestid",
    "request-id",
    "dxaddress",
  ];
  for (const name of headerCandidates) {
    const value = response.headers.get(name);
    if (value) return value;
  }
  if (parsed && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    const id = body["requestID"] ?? body["requestId"] ?? body["request_id"];
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
  }
  return undefined;
}

/** Pluck the validation envelope out of a parsed body. */
function extractValidationResults(parsed: unknown): unknown {
  if (parsed && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    if ("validationResults" in body) return body["validationResults"];
  }
  return undefined;
}

/** Best-effort JSON parse of a response body. Returns the raw text on failure. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Sleep helper that resolves with the elapsed delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Compute the backoff delay for retry attempt `attempt` (0-indexed).
 *
 * Exposed for testing — keeps the retry timing assertion deterministic
 * when the test injects a custom retry profile.
 */
export function computeBackoffMs(
  attempt: number,
  retries: RetryOptions,
  random: () => number = Math.random,
): number {
  const exp = retries.baseMs * 2 ** attempt;
  const jitter = Math.floor(random() * retries.jitterMs);
  return exp + jitter;
}

/** Decide whether a fetch error (rejection) is worth retrying. */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Node's `fetch` reports network failures as `TypeError`.
  if (error.name === "TypeError") return true;
  if (error.name === "AbortError") return true;
  return false;
}

/**
 * Build the full URL for a request. `query` keys are encoded.
 */
function buildUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, string>>,
): string {
  const url = `${baseUrl}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.append(key, value);
  }
  const qs = params.toString();
  return qs.length > 0 ? `${url}?${qs}` : url;
}

/**
 * Issue one HTTP request through the ZATCA gateway with retry, timeout
 * and error normalization. Returns the parsed JSON body on success
 * (or `undefined` for empty 2xx). Throws `ZatcaApiError` on every
 * non-2xx terminal status.
 */
export async function request<TResponse, TBody = unknown>(
  options: HttpClientOptions,
  args: RequestArgs<TBody>,
): Promise<TResponse> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error(
      "global `fetch` is not available; pass `options.fetch` explicitly (Node <20 not supported).",
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRY;
  const maxAttempts = retries.count + 1;
  const url = buildUrl(options.baseUrl, args.path, args.query);

  const headers: Record<string, string> = {
    ...(options.defaultHeaders ?? {}),
    ...(args.headers ?? {}),
  };

  const bodyString =
    args.body === undefined ? undefined : JSON.stringify(args.body);

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    debug("attempt %d/%d %s %s", attempt + 1, maxAttempts, args.method, args.path);

    try {
      const init: RequestInit = {
        method: args.method,
        headers,
        signal: controller.signal,
      };
      if (bodyString !== undefined) {
        init.body = bodyString;
      }
      const response = await fetchFn(url, init);
      clearTimeout(timer);

      if (SUCCESS_STATUSES.has(response.status)) {
        const parsed = (await readBody(response)) as TResponse;
        debug("ok %s %s -> %d", args.method, args.path, response.status);
        return parsed;
      }

      // Non-success: decide whether to retry. 5xx is retryable.
      const isRetryableStatus = response.status >= 500 && response.status < 600;
      if (isRetryableStatus && attempt < maxAttempts - 1) {
        debug("retryable %d on %s %s", response.status, args.method, args.path);
        // Drain the body so the connection can be reused.
        await readBody(response).catch(() => undefined);
        const delay = computeBackoffMs(attempt, retries);
        await sleep(delay);
        continue;
      }

      // Terminal failure — parse and throw.
      const parsed = await readBody(response);
      const requestId = extractRequestId(response, parsed);
      const validationResults = extractValidationResults(parsed);
      debug(
        "fail %s %s -> %d (terminal)",
        args.method,
        args.path,
        response.status,
      );
      throw new ZatcaApiError(
        `ZATCA API request failed with status ${response.status}`,
        response.status,
        validationResults,
        requestId,
        parsed,
      );
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof ZatcaApiError) {
        // Already normalized — don't wrap or retry.
        throw error;
      }
      lastError = error;
      if (attempt < maxAttempts - 1 && isRetryableError(error)) {
        debug(
          "retryable error %s on %s %s",
          error instanceof Error ? error.name : "unknown",
          args.method,
          args.path,
        );
        const delay = computeBackoffMs(attempt, retries);
        await sleep(delay);
        continue;
      }
      // Non-retryable or exhausted — surface as ZatcaApiError.
      if (error instanceof Error && error.name === "AbortError") {
        throw new ZatcaApiError(
          `ZATCA API request timed out after ${timeoutMs}ms`,
          0,
          undefined,
          undefined,
          undefined,
        );
      }
      if (error instanceof Error) {
        throw new ZatcaApiError(
          `ZATCA API network error: ${error.message}`,
          0,
          undefined,
          undefined,
          undefined,
        );
      }
      throw new ZatcaApiError(
        "ZATCA API request failed with unknown error",
        0,
        undefined,
        undefined,
        undefined,
      );
    }
  }

  // Loop exited without returning — should be unreachable, but if it
  // happens (e.g. all attempts produced retryable 5xx), surface the
  // last error.
  if (lastError instanceof ZatcaApiError) throw lastError;
  throw new ZatcaApiError(
    "ZATCA API request failed: retry attempts exhausted",
    0,
    undefined,
    undefined,
    lastError,
  );
}
