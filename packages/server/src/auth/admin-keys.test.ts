import { describe, expect, it } from "vitest";

import { ZatcaAuthError, ZatcaServerError } from "../errors.js";

import { createAdminKeyVerifier, extractBearer, parseAdminKeys } from "./admin-keys.js";

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);

describe("parseAdminKeys", () => {
  it("parses a single labelled entry", () => {
    expect(parseAdminKeys(`ops:${KEY_A}`)).toEqual([{ label: "ops", key: KEY_A }]);
  });

  it("parses multiple comma-separated entries with whitespace", () => {
    const out = parseAdminKeys(`ops:${KEY_A} , ci:${KEY_B}`);
    expect(out).toHaveLength(2);
    expect(out[0]?.label).toBe("ops");
    expect(out[1]?.label).toBe("ci");
  });

  it("rejects empty input", () => {
    expect(() => parseAdminKeys("")).toThrow(ZatcaServerError);
  });

  it("rejects entries missing the colon", () => {
    expect(() => parseAdminKeys(KEY_A)).toThrow(/of the form 'label:key'/);
  });

  it("rejects entries with an empty key", () => {
    expect(() => parseAdminKeys("ops:")).toThrow(/of the form 'label:key'/);
  });

  it("rejects keys below the minimum length", () => {
    expect(() => parseAdminKeys("ops:short")).toThrow(/too short/);
  });

  it("rejects duplicate labels", () => {
    expect(() => parseAdminKeys(`ops:${KEY_A},ops:${KEY_B}`)).toThrow(/Duplicate admin label/);
  });
});

describe("extractBearer", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearer("bearer abc123")).toBe("abc123");
    expect(extractBearer("BEARER abc123")).toBe("abc123");
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(extractBearer("Basic abc")).toBeNull();
  });

  it("returns null for a missing token", () => {
    expect(extractBearer("Bearer ")).toBeNull();
    expect(extractBearer("Bearer")).toBeNull();
  });
});

describe("createAdminKeyVerifier", () => {
  it("returns the matched label on success", () => {
    const verifier = createAdminKeyVerifier(`ops:${KEY_A},ci:${KEY_B}`);
    expect(verifier.verify(KEY_A)).toEqual({ label: "ops" });
    expect(verifier.verify(KEY_B)).toEqual({ label: "ci" });
  });

  it("returns null for an unknown key", () => {
    const verifier = createAdminKeyVerifier(`ops:${KEY_A}`);
    expect(verifier.verify(KEY_B)).toBeNull();
  });

  it("returns null for a length mismatch (no leak via timingSafeEqual)", () => {
    const verifier = createAdminKeyVerifier(`ops:${KEY_A}`);
    expect(verifier.verify(`${KEY_A}extra`)).toBeNull();
  });

  describe("verifyHeader", () => {
    it("matches a well-formed Authorization header", () => {
      const verifier = createAdminKeyVerifier(`ops:${KEY_A}`);
      expect(verifier.verifyHeader(`Bearer ${KEY_A}`)).toEqual({ label: "ops" });
    });

    it("throws 401 on missing header", () => {
      const verifier = createAdminKeyVerifier(`ops:${KEY_A}`);
      try {
        verifier.verifyHeader(undefined);
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ZatcaAuthError);
        expect((err as ZatcaAuthError).statusHint).toBe(401);
      }
    });

    it("throws 401 on malformed header", () => {
      const verifier = createAdminKeyVerifier(`ops:${KEY_A}`);
      try {
        verifier.verifyHeader(`Basic ${KEY_A}`);
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ZatcaAuthError);
        expect((err as ZatcaAuthError).statusHint).toBe(401);
      }
    });

    it("throws 401 on unknown key", () => {
      const verifier = createAdminKeyVerifier(`ops:${KEY_A}`);
      try {
        verifier.verifyHeader(`Bearer ${KEY_B}`);
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ZatcaAuthError);
        expect((err as ZatcaAuthError).statusHint).toBe(401);
      }
    });
  });
});
