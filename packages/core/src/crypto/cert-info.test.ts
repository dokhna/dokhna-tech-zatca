/**
 * Tests for `extractCertificateInfo`.
 *
 * Generates a fresh self-signed EC certificate on-demand (via
 * `openssl` CLI) so the test is self-contained and reproducible
 * regardless of any committed fixtures.
 *
 * If OpenSSL is absent the test suite is skipped — covered by the
 * openssl-probe test set instead.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZatcaCertificateError } from "../types/errors.js";
import {
  cleanUpCertificateString,
  extractCertificateInfo,
  wrapCertificateString,
} from "./cert-info.js";

interface Fixture {
  pem: string;
  body: string;
  keyPath: string;
  certPath: string;
}

let fixture: Fixture | undefined;

beforeAll(async () => {
  const opensslCheck = spawnSync("openssl", ["version"]);
  if (opensslCheck.status !== 0) {
    return; // tests below will short-circuit
  }
  const dir = tmpdir();
  const keyPath = join(dir, `${randomUUID()}.pem`);
  const certPath = join(dir, `${randomUUID()}.pem`);
  // Generate EC key with secp256k1.
  spawnSync("openssl", ["ecparam", "-name", "secp256k1", "-genkey", "-noout", "-out", keyPath], {
    stdio: "ignore",
  });
  // Self-signed cert with a stable subject.
  spawnSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-key",
      keyPath,
      "-out",
      certPath,
      "-days",
      "30",
      "-subj",
      "/C=SA/O=Test Org/OU=Test Branch/CN=test-egs-id",
    ],
    { stdio: "ignore" },
  );
  if (!existsSync(certPath)) return;
  const pem = await fs.readFile(certPath, "utf8");
  fixture = {
    pem,
    body: cleanUpCertificateString(pem),
    keyPath,
    certPath,
  };
});

afterAll(async () => {
  if (!fixture) return;
  await fs.unlink(fixture.keyPath).catch(() => {});
  await fs.unlink(fixture.certPath).catch(() => {});
});

describe("cleanUpCertificateString", () => {
  it("strips the BEGIN / END framing", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nABCDEF\n-----END CERTIFICATE-----";
    expect(cleanUpCertificateString(pem)).toBe("ABCDEF");
  });
});

describe("wrapCertificateString", () => {
  it("rebuilds the framing around a body", () => {
    expect(wrapCertificateString("ABC")).toContain(
      "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
    );
  });
});

describe("extractCertificateInfo", () => {
  it("parses a self-signed EC certificate", () => {
    if (!fixture) {
      // OpenSSL unavailable — skip silently. probeOpenssl test covers absence.
      return;
    }
    const info = extractCertificateInfo(fixture.pem);
    expect(info.hash).toHaveLength(88); // base64-of-hex
    expect(info.serial_number).toMatch(/^\d+$/);
    expect(info.issuer).toContain("CN=");
    expect(info.public_key.byteLength).toBeGreaterThan(0);
    expect(info.signature.byteLength).toBeGreaterThan(0);
  });

  it("accepts a bare base64 body or full PEM (same result)", () => {
    if (!fixture) return;
    const fromPem = extractCertificateInfo(fixture.pem);
    const fromBody = extractCertificateInfo(fixture.body);
    expect(fromBody.hash).toBe(fromPem.hash);
    expect(fromBody.serial_number).toBe(fromPem.serial_number);
  });

  it("throws ZatcaCertificateError for malformed PEM", () => {
    expect(() => extractCertificateInfo("not-a-cert")).toThrow(ZatcaCertificateError);
  });
});
