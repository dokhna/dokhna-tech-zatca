/**
 * Tests for `generateSecp256k1KeyPair`.
 *
 * Each test shells out to the real OpenSSL — slower than mocked
 * tests but matches the production codepath byte-for-byte. The dev
 * machine is required to have OpenSSL installed (covered by the
 * openssl-probe sibling test).
 */

import { describe, expect, it } from "vitest";
import { createPrivateKey } from "node:crypto";
import { generateSecp256k1KeyPair } from "./generate-keys.js";

describe("generateSecp256k1KeyPair", () => {
  it("returns a PEM-encoded EC private key", async () => {
    const pem = await generateSecp256k1KeyPair();
    expect(pem.startsWith("-----BEGIN EC PRIVATE KEY-----")).toBe(true);
    expect(pem.endsWith("-----END EC PRIVATE KEY-----")).toBe(true);
  });

  it("produces a key parseable by node:crypto", async () => {
    const pem = await generateSecp256k1KeyPair();
    expect(() => createPrivateKey(pem)).not.toThrow();
  });

  it("produces a different key on every call", async () => {
    const a = await generateSecp256k1KeyPair();
    const b = await generateSecp256k1KeyPair();
    expect(a).not.toBe(b);
  });

  it("uses the secp256k1 curve", async () => {
    const pem = await generateSecp256k1KeyPair();
    const key = createPrivateKey(pem);
    const jwk = key.export({ format: "jwk" }) as { crv?: string };
    expect(jwk.crv).toBe("secp256k1");
  });
});
