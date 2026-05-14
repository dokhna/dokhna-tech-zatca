/**
 * Unit tests — {@link isCertificateValid}.
 */

import { describe, expect, it } from "vitest";
import { readTestKeys } from "../invoices/_test-helpers.js";
import { isCertificateValid } from "./validity.js";

describe("isCertificateValid", () => {
  it("returns true when `now` is inside the validity window", () => {
    const keys = readTestKeys();
    expect(
      isCertificateValid(keys.signingCertificatePem, new Date("2030-01-01T00:00:00.000Z")),
    ).toBe(true);
  });

  it("returns false when `now` is before notBefore", () => {
    const keys = readTestKeys();
    expect(
      isCertificateValid(keys.signingCertificatePem, new Date("2000-01-01T00:00:00.000Z")),
    ).toBe(false);
  });

  it("returns false when `now` is after notAfter", () => {
    const keys = readTestKeys();
    expect(
      isCertificateValid(keys.signingCertificatePem, new Date("2100-01-01T00:00:00.000Z")),
    ).toBe(false);
  });

  it("returns false for a malformed PEM (does not throw)", () => {
    expect(isCertificateValid("garbage")).toBe(false);
  });
});
