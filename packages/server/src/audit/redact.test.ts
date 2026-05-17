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

  it("redacts Buffer / TypedArray values without serialising bytes (HI-01)", () => {
    const buf = Buffer.from([0x89, 0x42, 0x12, 0x34]);
    const arr = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = redactSecrets({ keyMaterial: buf, somethingElse: arr });
    // Bytes must NOT appear in the output — pre-fix, the redactor
    // walked into the Buffer's Object.entries form and emitted
    // {"0":137,"1":66, ...}, which is fully recoverable.
    expect(JSON.stringify(out)).not.toContain("137");
    expect(JSON.stringify(out)).not.toContain("0x89");
    // The shape conveys the byte length so operators can tell a
    // Buffer was there without learning its content.
    expect(out).toEqual({
      keyMaterial: "[REDACTED:Buffer/4]",
      somethingElse: "[REDACTED:Buffer/8]",
    });
  });

  it("matches sensitive keys case-insensitively (HI-02)", () => {
    const out = redactSecrets({
      APIKey: "x",
      ApiKey: "y",
      apikey: "z",
      Private_Key: "w",
      Authorization: "Bearer 1",
      authorization: "Bearer 2",
    });
    expect(out).toEqual({
      APIKey: "[REDACTED]",
      ApiKey: "[REDACTED]",
      apikey: "[REDACTED]",
      Private_Key: "[REDACTED]",
      Authorization: "[REDACTED]",
      authorization: "[REDACTED]",
    });
  });

  it("redacts via the regex fallback for unfamiliar *secret/token/password* names (HI-02)", () => {
    const out = redactSecrets({
      customAccessToken: "x",
      randomSecretBlob: "y",
      myPasswordField: "z",
      label: "kept",
    });
    expect(out).toEqual({
      customAccessToken: "[REDACTED]",
      randomSecretBlob: "[REDACTED]",
      myPasswordField: "[REDACTED]",
      label: "kept",
    });
  });

  it("redacts CSR / PEM / signature material (HI-02)", () => {
    const out = redactSecrets({
      csr: "-----BEGIN CERTIFICATE REQUEST-----",
      signedXml: "<Invoice>...</Invoice>",
      signatureValue: "QzhxQ...",
    });
    expect(out).toEqual({
      csr: "[REDACTED]",
      signedXml: "[REDACTED]",
      signatureValue: "[REDACTED]",
    });
  });
});
