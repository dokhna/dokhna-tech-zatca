import { describe, expect, it } from "vitest";

import { ZatcaValidationError } from "../types/errors.js";
import { asVATNumber, isVATNumber } from "./vat-number.js";

describe("asVATNumber", () => {
  it("accepts a syntactically valid VAT (15 digits, starts/ends with 3)", () => {
    const vat = asVATNumber("310987654321003");
    expect(vat).toBe("310987654321003");
    // Branded type is structurally a string at runtime:
    expect(typeof vat).toBe("string");
  });

  it("throws ZatcaValidationError when format is wrong", () => {
    expect(() => asVATNumber("invalid")).toThrow(ZatcaValidationError);
  });

  it("error name is 'ZatcaValidationError' and message includes the bad value", () => {
    try {
      asVATNumber("12345");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaValidationError);
      const e = err as ZatcaValidationError;
      expect(e.name).toBe("ZatcaValidationError");
      expect(e.message).toContain("12345");
    }
  });

  it("rejects 15-digit strings that do not start and end with 3", () => {
    // Starts with 3 but ends with 4.
    expect(() => asVATNumber("310987654321004")).toThrow(ZatcaValidationError);
    // Starts with 4 but ends with 3.
    expect(() => asVATNumber("410987654321003")).toThrow(ZatcaValidationError);
  });

  it("rejects non-digit characters", () => {
    expect(() => asVATNumber("31098765432100A")).toThrow(ZatcaValidationError);
  });

  it("rejects wrong-length inputs", () => {
    expect(() => asVATNumber("3100003")).toThrow(ZatcaValidationError); // 7 digits
    expect(() => asVATNumber("31098765432100033")).toThrow(ZatcaValidationError); // 17 digits
  });
});

describe("isVATNumber", () => {
  it("returns true for a valid VAT", () => {
    expect(isVATNumber("310987654321003")).toBe(true);
  });

  it("returns false for invalid inputs", () => {
    expect(isVATNumber("invalid")).toBe(false);
    expect(isVATNumber(42)).toBe(false);
    expect(isVATNumber(undefined)).toBe(false);
    expect(isVATNumber(null)).toBe(false);
  });
});
