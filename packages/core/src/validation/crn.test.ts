import { describe, expect, it } from "vitest";

import { ZatcaValidationError } from "../types/errors.js";
import {
  asCommercialRegistrationNumber,
  isCommercialRegistrationNumber,
} from "./crn.js";

describe("asCommercialRegistrationNumber", () => {
  it("accepts a 10-digit value", () => {
    const crn = asCommercialRegistrationNumber("1010101010");
    expect(crn).toBe("1010101010");
  });

  it("throws ZatcaValidationError on wrong length", () => {
    expect(() => asCommercialRegistrationNumber("123")).toThrow(
      ZatcaValidationError,
    );
    expect(() => asCommercialRegistrationNumber("12345678901")).toThrow(
      ZatcaValidationError,
    );
  });

  it("rejects non-digit characters", () => {
    expect(() => asCommercialRegistrationNumber("12345ABCDE")).toThrow(
      ZatcaValidationError,
    );
  });

  it("error has the right name and includes the bad value", () => {
    try {
      asCommercialRegistrationNumber("nope");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaValidationError);
      const e = err as ZatcaValidationError;
      expect(e.name).toBe("ZatcaValidationError");
      expect(e.message).toContain("nope");
    }
  });
});

describe("isCommercialRegistrationNumber", () => {
  it("returns true for a valid CRN", () => {
    expect(isCommercialRegistrationNumber("1010101010")).toBe(true);
  });
  it("returns false otherwise", () => {
    expect(isCommercialRegistrationNumber("short")).toBe(false);
    expect(isCommercialRegistrationNumber(1010101010)).toBe(false);
  });
});
