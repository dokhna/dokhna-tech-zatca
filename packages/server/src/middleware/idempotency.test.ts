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
  it("putIfAbsent inserts when key is unseen + returns true", async () => {
    const store = createMemoryIdempotencyStore();
    expect(await store.putIfAbsent("k", RESPONSE, 10_000)).toBe(true);
  });

  it("putIfAbsent returns false on collision within TTL", async () => {
    const store = createMemoryIdempotencyStore();
    await store.putIfAbsent("k", RESPONSE, 10_000);
    expect(await store.putIfAbsent("k", RESPONSE, 10_000)).toBe(false);
  });

  it("get returns the stored response within TTL", async () => {
    const store = createMemoryIdempotencyStore();
    await store.putIfAbsent("k", RESPONSE, 10_000);
    expect(await store.get("k")).toEqual(RESPONSE);
  });

  it("get returns null for unknown key", async () => {
    expect(await createMemoryIdempotencyStore().get("missing")).toBeNull();
  });

  it("get returns null + sweeps expired entries", async () => {
    const store = createMemoryIdempotencyStore();
    await store.set("k", RESPONSE, -1);
    expect(await store.get("k")).toBeNull();
  });

  it("set overwrites prior value", async () => {
    const store = createMemoryIdempotencyStore();
    await store.set("k", RESPONSE, 10_000);
    await store.set("k", { ...RESPONSE, statusCode: 201 }, 10_000);
    expect((await store.get("k"))?.statusCode).toBe(201);
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
