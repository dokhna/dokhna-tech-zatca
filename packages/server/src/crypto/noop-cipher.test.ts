import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ZatcaCipherError } from "../errors.js";
import { createNoopCipher } from "./noop-cipher.js";

describe("createNoopCipher", () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });
  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("refuses to construct outside NODE_ENV=development by default", () => {
    process.env.NODE_ENV = "production";
    expect(() => createNoopCipher()).toThrow(ZatcaCipherError);
  });

  it("constructs in development without acknowledgement", () => {
    process.env.NODE_ENV = "development";
    expect(() => createNoopCipher()).not.toThrow();
  });

  it("constructs outside development when acknowledgeUnsafe is true", () => {
    process.env.NODE_ENV = "production";
    expect(() => createNoopCipher({ acknowledgeUnsafe: true })).not.toThrow();
  });

  it("round-trips plaintext", async () => {
    process.env.NODE_ENV = "development";
    const cipher = createNoopCipher();
    const envelope = await cipher.encrypt("secret");
    expect(envelope.alg).toBe("noop");
    expect(envelope.kid).toBe("noop");
    expect(await cipher.decrypt(envelope)).toBe("secret");
  });

  it("rejects envelopes from other algorithms on decrypt", async () => {
    process.env.NODE_ENV = "development";
    const cipher = createNoopCipher();
    await expect(
      cipher.decrypt({ kid: "v1", alg: "aes-256-gcm", iv: "x", ct: "x", tag: "x" }),
    ).rejects.toThrow(/not handled by the noop cipher/);
  });
});
