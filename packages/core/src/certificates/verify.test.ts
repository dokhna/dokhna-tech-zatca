/**
 * Unit tests — {@link verifyCertificate}.
 *
 * Uses the bundled test PEM in `packages/core/src/fixtures/_keys/`
 * (self-signed; matches `test-key.pem`).
 */

import { describe, expect, it } from "vitest";
import { readTestKeys } from "../invoices/_test-helpers.js";
import { ZatcaCertificateError } from "../types/errors.js";
import { verifyCertificate } from "./verify.js";

describe("verifyCertificate", () => {
  it("parses the bundled fixture cert and reports all fields", () => {
    const keys = readTestKeys();
    const result = verifyCertificate({
      certificate: keys.signingCertificatePem,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(result.serialNumber).toMatch(/^[0-9A-F]+$/);
    expect(result.subject).toContain("acme-egs-001");
    expect(result.issuer).toContain("acme-egs-001");
    expect(result.validFrom).toBeInstanceOf(Date);
    expect(result.validTo).toBeInstanceOf(Date);
    expect(result.validTo.getTime()).toBeGreaterThan(
      result.validFrom.getTime(),
    );
    expect(result.isValid).toBe(true);
    expect(result.publicKeyMatchesPrivateKey).toBeNull();
  });

  it("reports publicKeyMatchesPrivateKey=true when the key matches", () => {
    const keys = readTestKeys();
    const result = verifyCertificate({
      certificate: keys.signingCertificatePem,
      privateKey: keys.signingPrivateKeyPem,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(result.publicKeyMatchesPrivateKey).toBe(true);
  });

  it("reports publicKeyMatchesPrivateKey=false for an unrelated private key", () => {
    const keys = readTestKeys();
    // A garbage PEM body — `createPrivateKey` will reject.
    const result = verifyCertificate({
      certificate: keys.signingCertificatePem,
      privateKey: "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n",
    });
    expect(result.publicKeyMatchesPrivateKey).toBe(false);
  });

  it("reports isValid=false when `now` is before notBefore", () => {
    const keys = readTestKeys();
    const result = verifyCertificate({
      certificate: keys.signingCertificatePem,
      now: new Date("2000-01-01T00:00:00.000Z"),
    });
    expect(result.isValid).toBe(false);
  });

  it("reports isValid=false when `now` is after notAfter", () => {
    const keys = readTestKeys();
    const result = verifyCertificate({
      certificate: keys.signingCertificatePem,
      now: new Date("2100-01-01T00:00:00.000Z"),
    });
    expect(result.isValid).toBe(false);
  });

  it("throws ZatcaCertificateError on malformed PEM", () => {
    expect(() =>
      verifyCertificate({ certificate: "not-a-cert" }),
    ).toThrowError(ZatcaCertificateError);
  });
});
