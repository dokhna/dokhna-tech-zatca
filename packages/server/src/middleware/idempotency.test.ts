import { describe, expect, it } from "vitest";

import {
  buildIdempotencyCacheKey,
  type CachedResponse,
  createMemoryIdempotencyStore,
} from "./idempotency.js";

const RESPONSE: CachedResponse = {
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: '{"ok":true}',
};

describe("createMemoryIdempotencyStore", () => {
  it("begin returns 'claimed' for an unseen key", async () => {
    const store = createMemoryIdempotencyStore();
    const result = await store.begin("k", 10_000);
    expect(result.kind).toBe("claimed");
  });

  it("begin returns 'in-flight' while a prior claim is open", async () => {
    const store = createMemoryIdempotencyStore();
    await store.begin("k", 10_000);
    const result = await store.begin("k", 10_000);
    expect(result.kind).toBe("in-flight");
  });

  it("begin returns 'replay' once the prior caller committed", async () => {
    const store = createMemoryIdempotencyStore();
    await store.begin("k", 10_000);
    await store.commit("k", RESPONSE, 10_000);
    const result = await store.begin("k", 10_000);
    expect(result.kind).toBe("replay");
    if (result.kind === "replay") {
      expect(result.response).toEqual(RESPONSE);
    }
  });

  it("release allows a fresh claim on retry", async () => {
    const store = createMemoryIdempotencyStore();
    await store.begin("k", 10_000);
    await store.release("k");
    const result = await store.begin("k", 10_000);
    expect(result.kind).toBe("claimed");
  });

  it("commit without prior begin throws (programming-error guard)", async () => {
    const store = createMemoryIdempotencyStore();
    await expect(store.commit("k", RESPONSE, 10_000)).rejects.toThrow(/unclaimed key/);
  });

  it("expired in-flight slot is sweepable by a fresh begin", async () => {
    const store = createMemoryIdempotencyStore();
    await store.begin("k", -1);
    const result = await store.begin("k", 10_000);
    expect(result.kind).toBe("claimed");
  });

  it("expired committed entry is sweepable by a fresh begin", async () => {
    const store = createMemoryIdempotencyStore();
    await store.begin("k", 10_000);
    await store.commit("k", RESPONSE, -1);
    const result = await store.begin("k", 10_000);
    expect(result.kind).toBe("claimed");
  });

  it("release of an unknown key is a no-op", async () => {
    const store = createMemoryIdempotencyStore();
    await expect(store.release("missing")).resolves.toBeUndefined();
  });
});

describe("buildIdempotencyCacheKey", () => {
  it("namespaces by tenant + route + key hash", () => {
    const a = buildIdempotencyCacheKey({
      tenantRef: "acme",
      route: "/v1/tenants/acme/invoices",
      presentedKey: "abc-123",
    });
    expect(a).toMatch(/^idem:acme:\/v1\/tenants\/acme\/invoices:[A-Za-z0-9_-]+$/);
  });

  it("uses an admin sentinel when no tenant is supplied", () => {
    const a = buildIdempotencyCacheKey({
      tenantRef: undefined,
      route: "/v1/tenants",
      presentedKey: "abc-123",
    });
    expect(a).toMatch(/^idem:_admin_:/);
  });

  it("identical inputs produce identical keys", () => {
    const a = buildIdempotencyCacheKey({
      tenantRef: "acme",
      route: "/x",
      presentedKey: "k",
    });
    const b = buildIdempotencyCacheKey({
      tenantRef: "acme",
      route: "/x",
      presentedKey: "k",
    });
    expect(a).toBe(b);
  });

  it("different presentedKeys produce different cache keys", () => {
    const a = buildIdempotencyCacheKey({
      tenantRef: "acme",
      route: "/x",
      presentedKey: "k1",
    });
    const b = buildIdempotencyCacheKey({
      tenantRef: "acme",
      route: "/x",
      presentedKey: "k2",
    });
    expect(a).not.toBe(b);
  });
});
