import { describe, expect, it } from "vitest";

import { ZatcaValidationError } from "../types/errors.js";
import { asEGSUuid, asInvoiceUUID, isUuidV4 } from "./uuid.js";

const VALID_V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("asInvoiceUUID", () => {
  it("accepts a canonical v4 UUID", () => {
    expect(asInvoiceUUID(VALID_V4)).toBe(VALID_V4);
  });

  it("accepts upper-case v4", () => {
    expect(asInvoiceUUID(VALID_V4.toUpperCase())).toBe(VALID_V4.toUpperCase());
  });

  it("throws on a non-v4 UUID (version nibble != 4)", () => {
    // Version nibble forced to 5.
    expect(() => asInvoiceUUID("f47ac10b-58cc-5372-a567-0e02b2c3d479")).toThrow(
      ZatcaValidationError,
    );
  });

  it("throws on malformed input", () => {
    expect(() => asInvoiceUUID("not-a-uuid")).toThrow(ZatcaValidationError);
  });

  it("error has correct name and includes the bad value", () => {
    try {
      asInvoiceUUID("xxx");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaValidationError);
      const e = err as ZatcaValidationError;
      expect(e.name).toBe("ZatcaValidationError");
      expect(e.message).toContain("xxx");
    }
  });
});

describe("asEGSUuid", () => {
  it("accepts a canonical v4 UUID", () => {
    expect(asEGSUuid(VALID_V4)).toBe(VALID_V4);
  });
  it("throws on malformed input", () => {
    expect(() => asEGSUuid("not-a-uuid")).toThrow(ZatcaValidationError);
  });
});

describe("isUuidV4", () => {
  it("returns true for a valid v4", () => {
    expect(isUuidV4(VALID_V4)).toBe(true);
  });
  it("returns false for non-strings and malformed strings", () => {
    expect(isUuidV4("nope")).toBe(false);
    expect(isUuidV4(undefined)).toBe(false);
    expect(isUuidV4(0)).toBe(false);
  });
});
