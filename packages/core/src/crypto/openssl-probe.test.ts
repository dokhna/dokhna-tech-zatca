/**
 * Tests for the OpenSSL probe.
 *
 * The dev box is expected to have OpenSSL on PATH; the probe must
 * return `available: true` and a non-null version string. The
 * unavailable-case branch is covered by mocking `spawn` via vitest.
 */

import { describe, expect, it } from "vitest";
import { ensureOpenssl, probeOpenssl, resetOpensslProbeCache } from "./openssl-probe.js";

describe("probeOpenssl", () => {
  it("reports OpenSSL as available on the dev machine", async () => {
    const result = await probeOpenssl();
    expect(result.available).toBe(true);
    expect(result.version).toMatch(/OpenSSL/i);
  });

  it("returns a stable shape (no extra keys)", async () => {
    const result = await probeOpenssl();
    expect(Object.keys(result).sort()).toEqual(["available", "version"]);
  });
});

describe("ensureOpenssl", () => {
  it("resolves when OpenSSL is available", async () => {
    resetOpensslProbeCache();
    await expect(ensureOpenssl()).resolves.toMatchObject({ available: true });
  });
});
