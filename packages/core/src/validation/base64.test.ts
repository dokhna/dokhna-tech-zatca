import { describe, expect, it } from "vitest";

import { ZatcaValidationError } from "../types/errors.js";
import {
  asBase64,
  asInvoiceHash,
  isBase64,
  isInvoiceHash,
} from "./base64.js";

describe("asBase64", () => {
  it("accepts unpadded base64", () => {
    expect(asBase64("YWJjZA")).toBe("YWJjZA"); // "abcd"
  });

  it("accepts double-padded base64", () => {
    expect(asBase64("YQ==")).toBe("YQ==");
  });

  it("rejects characters outside the RFC 4648 alphabet", () => {
    expect(() => asBase64("hello world!")).toThrow(ZatcaValidationError);
  });

  it("error name is set", () => {
    try {
      asBase64("!!!");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaValidationError);
      expect((err as ZatcaValidationError).name).toBe("ZatcaValidationError");
    }
  });
});

describe("isBase64", () => {
  it("returns true on valid base64", () => {
    expect(isBase64("YWJjZA==")).toBe(true);
  });
  it("returns false on non-strings", () => {
    expect(isBase64(undefined)).toBe(false);
    expect(isBase64(0)).toBe(false);
  });
});

describe("asInvoiceHash", () => {
  // 32 bytes of base64 is 44 chars ending with '='. Build a stable one.
  const VALID_HASH =
    "OWNiNzFlYmEzMGE1MDA0MGFhM2UwMzRhMzU1ZWUzMmI=";

  it("accepts a 44-char base64 hash ending with '='", () => {
    expect(asInvoiceHash(VALID_HASH)).toBe(VALID_HASH);
  });

  it("rejects hashes of the wrong length", () => {
    expect(() => asInvoiceHash("short=")).toThrow(ZatcaValidationError);
  });

  it("rejects hashes without trailing '='", () => {
    // 44 chars but no '=' at end.
    expect(() =>
      asInvoiceHash("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr"),
    ).toThrow(ZatcaValidationError);
  });
});

describe("isInvoiceHash", () => {
  it("validates the same shape", () => {
    expect(isInvoiceHash("OWNiNzFlYmEzMGE1MDA0MGFhM2UwMzRhMzU1ZWUzMmI=")).toBe(
      true,
    );
    expect(isInvoiceHash("nope")).toBe(false);
  });
});
