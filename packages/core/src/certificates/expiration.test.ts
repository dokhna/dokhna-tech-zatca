/**
 * Unit tests — {@link getCertificateExpirationDate}.
 */

import { describe, expect, it } from "vitest";
import { readTestKeys } from "../invoices/_test-helpers.js";
import { ZatcaCertificateError } from "../types/errors.js";
import { getCertificateExpirationDate } from "./expiration.js";

describe("getCertificateExpirationDate", () => {
  it("returns the notAfter date for the fixture certificate", () => {
    const keys = readTestKeys();
    const expirationDate = getCertificateExpirationDate(keys.signingCertificatePem);
    expect(expirationDate).toBeInstanceOf(Date);
    // The fixture cert was generated with a 10-year validity window —
    // assert it expires in the future relative to a reasonable lower
    // bound. We do NOT hard-code the exact value because the fixture
    // may be regenerated; the test asserts the helper returns a sane
    // Date instance.
    expect(expirationDate.getTime()).toBeGreaterThan(
      new Date("2025-01-01T00:00:00.000Z").getTime(),
    );
  });

  it("throws ZatcaCertificateError on malformed PEM", () => {
    expect(() => getCertificateExpirationDate("not-a-cert")).toThrowError(ZatcaCertificateError);
  });
});
