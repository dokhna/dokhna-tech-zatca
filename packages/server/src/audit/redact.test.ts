import { describe, expect, it } from "vitest";

import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("passes primitives through unchanged", () => {
    expect(redactSecrets("hello")).toBe("hello");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it("redacts top-level secret keys", () => {
    const out = redactSecrets({
      tenantRef: "acme",
      privateKey: "PEM...",
      apiSecret: "secret",
      otp: "123456",
    });
    expect(out).toEqual({
      tenantRef: "acme",
      privateKey: "[REDACTED]",
      apiSecret: "[REDACTED]",
      otp: "[REDACTED]",
    });
  });

  it("redacts deeply nested secrets", () => {
    const out = redactSecrets({
      tenantRef: "acme",
      credentials: {
        privateKey: "PEM",
        productionApiSecret: "x",
        meta: { binarySecurityToken: "BST" },
      },
    });
    const creds = (
      out as { credentials: { privateKey: string; meta: { binarySecurityToken: string } } }
    ).credentials;
    expect(creds.privateKey).toBe("[REDACTED]");
    expect(creds.productionApiSecret).toBe("[REDACTED]");
    expect(creds.meta.binarySecurityToken).toBe("[REDACTED]");
  });

  it("redacts inside arrays", () => {
    const out = redactSecrets({
      keys: [
        { privateKey: "k1", label: "a" },
        { privateKey: "k2", label: "b" },
      ],
    });
    const keys = (out as { keys: ReadonlyArray<{ privateKey: string; label: string }> }).keys;
    expect(keys[0]?.privateKey).toBe("[REDACTED]");
    expect(keys[0]?.label).toBe("a");
    expect(keys[1]?.privateKey).toBe("[REDACTED]");
  });

  it("redacts the Authorization header (any casing)", () => {
    const out = redactSecrets({ Authorization: "Bearer xxx", authorization: "Bearer yyy" });
    expect(out).toEqual({ Authorization: "[REDACTED]", authorization: "[REDACTED]" });
  });

  it("preserves Date / Map / Set as-is", () => {
    const now = new Date();
    const map = new Map([["k", "v"]]);
    const set = new Set([1, 2]);
    const out = redactSecrets({ now, map, set });
    expect((out as { now: Date }).now).toBe(now);
    expect((out as { map: Map<string, string> }).map).toBe(map);
    expect((out as { set: Set<number> }).set).toBe(set);
  });

  it("tolerates cycles without infinite recursion", () => {
    const a: { name: string; child?: unknown } = { name: "a" };
    a.child = a;
    expect(() => redactSecrets(a)).not.toThrow();
  });

  it("does not mutate the original input", () => {
    const original = { privateKey: "k", nested: { otp: "123" } };
    const copy = JSON.parse(JSON.stringify(original));
    redactSecrets(original);
    expect(original).toEqual(copy);
  });
});
