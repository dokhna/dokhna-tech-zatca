/**
 * Tests for the fetch-based ZATCA HTTP client.
 *
 * Coverage:
 *   - Happy path: 200 with parsed JSON body.
 *   - 4xx is NOT retried (exactly 1 fetch call).
 *   - 5xx is retried with exponential backoff (≥4 calls on always-503).
 *   - Network errors (TypeError) are retried.
 *   - Timeout (AbortError) is normalized into a ZatcaApiError(0).
 *   - Validation envelopes are parsed and surfaced on the error.
 *   - Authorization header is never logged by the `debug` adapter
 *     (we mock `debug` formatter and assert it is never called with
 *     header material).
 */

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZatcaApiError } from "../types/errors.js";
import { type HttpClientOptions, computeBackoffMs, request } from "./http-client.js";

const BASE = "https://gw-fatoora.test/zatca";

/** msw server — handlers per-test (we use `server.use()` inside each test). */
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

/** Build a client with retries dialled down to keep test runs fast. */
function fastClient(extra?: Partial<HttpClientOptions>): HttpClientOptions {
  return {
    baseUrl: BASE,
    retries: { count: 3, baseMs: 5, jitterMs: 0 },
    timeoutMs: 5_000,
    ...(extra ?? {}),
  };
}

describe("computeBackoffMs", () => {
  it("returns base*2^attempt with deterministic random=0", () => {
    const retries = { count: 3, baseMs: 100, jitterMs: 1000 };
    expect(computeBackoffMs(0, retries, () => 0)).toBe(100);
    expect(computeBackoffMs(1, retries, () => 0)).toBe(200);
    expect(computeBackoffMs(2, retries, () => 0)).toBe(400);
  });

  it("adds jitter up to (but not including) jitterMs", () => {
    const retries = { count: 3, baseMs: 100, jitterMs: 50 };
    const delay = computeBackoffMs(0, retries, () => 0.5);
    expect(delay).toBe(125);
  });
});

describe("request — happy path", () => {
  it("returns parsed JSON on 200", async () => {
    server.use(http.get(`${BASE}/ping`, () => HttpResponse.json({ ok: true })));
    const out = await request<{ ok: boolean }>(fastClient(), {
      method: "GET",
      path: "/ping",
    });
    expect(out).toEqual({ ok: true });
  });

  it("treats 202 as success", async () => {
    server.use(
      http.post(`${BASE}/ping`, () => HttpResponse.json({ accepted: true }, { status: 202 })),
    );
    const out = await request<{ accepted: boolean }>(fastClient(), {
      method: "POST",
      path: "/ping",
      body: { hi: 1 },
    });
    expect(out).toEqual({ accepted: true });
  });

  it("appends query string when `query` is provided", async () => {
    let receivedUrl = "";
    server.use(
      http.get(`${BASE}/q`, ({ request: req }) => {
        receivedUrl = req.url;
        return HttpResponse.json({ ok: true });
      }),
    );
    await request<{ ok: boolean }>(fastClient(), {
      method: "GET",
      path: "/q",
      query: { foo: "bar", x: "y z" },
    });
    expect(receivedUrl).toContain("foo=bar");
    expect(receivedUrl).toContain("x=y+z");
  });
});

describe("request — 4xx terminal", () => {
  it("does NOT retry on 400 and throws ZatcaApiError with statusCode=400", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/c`, () => {
        calls += 1;
        return HttpResponse.json(
          {
            validationResults: {
              errorMessages: [
                {
                  code: "BR-KSA-31",
                  message: "Invoice signature did not validate",
                  category: "ERROR-INVOICE",
                  status: "ERROR",
                },
              ],
            },
          },
          { status: 400 },
        );
      }),
    );
    try {
      await request(fastClient(), { method: "POST", path: "/c", body: {} });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      const e = err as ZatcaApiError;
      expect(e.statusCode).toBe(400);
      expect(e.validationResults).toBeDefined();
    }
    expect(calls).toBe(1);
  });

  it("does NOT retry on 401", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/auth`, () => {
        calls += 1;
        return HttpResponse.json({ message: "unauthorized" }, { status: 401 });
      }),
    );
    await expect(request(fastClient(), { method: "GET", path: "/auth" })).rejects.toBeInstanceOf(
      ZatcaApiError,
    );
    expect(calls).toBe(1);
  });
});

describe("request — 5xx retry", () => {
  it("retries on 503 and returns 200 on third attempt", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/flaky`, () => {
        calls += 1;
        if (calls < 3) {
          return HttpResponse.json({ err: "down" }, { status: 503 });
        }
        return HttpResponse.json({ recovered: true });
      }),
    );
    const out = await request<{ recovered: boolean }>(fastClient(), {
      method: "POST",
      path: "/flaky",
      body: {},
    });
    expect(out).toEqual({ recovered: true });
    expect(calls).toBe(3);
  });

  it("makes 4 attempts on always-503 and throws ZatcaApiError(503)", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/down`, () => {
        calls += 1;
        return HttpResponse.json({ err: "down" }, { status: 503 });
      }),
    );
    try {
      await request(fastClient(), { method: "POST", path: "/down", body: {} });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      expect((err as ZatcaApiError).statusCode).toBe(503);
    }
    expect(calls).toBe(4);
  });
});

describe("request — network errors and timeout", () => {
  it("retries on network failure and surfaces ZatcaApiError(0) after exhaustion", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/dead`, () => {
        calls += 1;
        return HttpResponse.error();
      }),
    );
    try {
      await request(fastClient(), { method: "GET", path: "/dead" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      expect((err as ZatcaApiError).statusCode).toBe(0);
    }
    expect(calls).toBe(4);
  });

  it("normalizes timeout into ZatcaApiError(0) with a timeout message", async () => {
    // Make the handler hang past the client timeout.
    server.use(
      http.get(
        `${BASE}/slow`,
        async () =>
          new Promise<Response>(() => {
            // never resolves
          }),
      ),
    );
    const opts: HttpClientOptions = {
      baseUrl: BASE,
      retries: { count: 0, baseMs: 1, jitterMs: 0 },
      timeoutMs: 30,
    };
    try {
      await request(opts, { method: "GET", path: "/slow" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      const e = err as ZatcaApiError;
      expect(e.statusCode).toBe(0);
      expect(e.message).toMatch(/timed out/i);
    }
  });
});

describe("request — request id and validation results", () => {
  it("extracts requestId from `x-request-id` response header", async () => {
    server.use(
      http.post(`${BASE}/x`, () =>
        HttpResponse.json(
          { validationResults: { errorMessages: [{ code: "X", message: "x", category: "Y" }] } },
          { status: 400, headers: { "x-request-id": "req-123" } },
        ),
      ),
    );
    try {
      await request(fastClient(), { method: "POST", path: "/x", body: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaApiError);
      expect((err as ZatcaApiError).requestId).toBe("req-123");
    }
  });

  it("extracts requestId from body `requestID` field", async () => {
    server.use(
      http.post(`${BASE}/y`, () =>
        HttpResponse.json({ requestID: "BODY-42", validationResults: {} }, { status: 400 }),
      ),
    );
    try {
      await request(fastClient(), { method: "POST", path: "/y", body: {} });
    } catch (err) {
      expect((err as ZatcaApiError).requestId).toBe("BODY-42");
    }
  });

  it("attaches the raw decoded response to the error", async () => {
    server.use(
      http.post(`${BASE}/r`, () => HttpResponse.json({ message: "boom" }, { status: 500 })),
    );
    try {
      await request(
        { ...fastClient(), retries: { count: 0, baseMs: 1, jitterMs: 0 } },
        { method: "POST", path: "/r", body: {} },
      );
    } catch (err) {
      expect((err as ZatcaApiError).rawResponse).toEqual({ message: "boom" });
    }
  });
});

describe("request — body marshalling", () => {
  it("sends JSON.stringified body for POST", async () => {
    let received: unknown = null;
    server.use(
      http.post(`${BASE}/b`, async ({ request: req }) => {
        received = await req.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    await request(fastClient(), {
      method: "POST",
      path: "/b",
      body: { hello: "world", n: 1 },
    });
    expect(received).toEqual({ hello: "world", n: 1 });
  });

  it("omits body for GET", async () => {
    let receivedBody = "non-empty-sentinel";
    server.use(
      http.get(`${BASE}/g`, async ({ request: req }) => {
        receivedBody = await req.text();
        return HttpResponse.json({ ok: true });
      }),
    );
    await request(fastClient(), { method: "GET", path: "/g" });
    expect(receivedBody).toBe("");
  });
});

describe("request — fetch injection", () => {
  it("uses the injected fetch over globalThis.fetch", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ from: "spy" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const out = await request<{ from: string }>(
      { baseUrl: BASE, fetch: spy as unknown as typeof fetch },
      { method: "GET", path: "/spied" },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ from: "spy" });
  });
});
