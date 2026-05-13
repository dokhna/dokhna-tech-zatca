/**
 * Unit tests for the TLV byte encoder.
 *
 * Coverage:
 * - Tag numbers count from 1.
 * - String values are UTF-8 encoded.
 * - `Uint8Array` / `Buffer` values are taken verbatim.
 * - Length-byte equals the encoded byte length (not character count).
 * - Multi-byte UTF-8 characters round-trip correctly.
 * - Values over 255 bytes throw `RangeError`.
 */

import { describe, expect, it } from "vitest";
import { createTLV, encodeTLVAsBase64 } from "./tlv.js";

describe("createTLV", () => {
  it("encodes a single ASCII string with tag=1, length=N", () => {
    const out = createTLV(["AB"]);
    // [tag=1, length=2, 'A', 'B']
    expect(Array.from(out)).toEqual([1, 2, 0x41, 0x42]);
  });

  it("counts byte length for multi-byte UTF-8, not character length", () => {
    // Arabic "س" is 0xD8 0xB3 in UTF-8 — 2 bytes, 1 character.
    const out = createTLV(["س"]);
    expect(Array.from(out)).toEqual([1, 2, 0xd8, 0xb3]);
  });

  it("assigns sequential tag numbers starting at 1", () => {
    const out = createTLV(["A", "B", "C"]);
    expect(out[0]).toBe(1);
    expect(out[3]).toBe(2);
    expect(out[6]).toBe(3);
  });

  it("accepts Uint8Array values verbatim", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const out = createTLV([bytes]);
    expect(Array.from(out)).toEqual([1, 4, 0xde, 0xad, 0xbe, 0xef]);
  });

  it("accepts Buffer values verbatim", () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const out = createTLV([buf]);
    expect(Array.from(out)).toEqual([1, 3, 0x01, 0x02, 0x03]);
  });

  it("concatenates segments in order", () => {
    const out = createTLV(["A", Buffer.from([0xff])]);
    expect(Array.from(out)).toEqual([1, 1, 0x41, 2, 1, 0xff]);
  });

  it("throws RangeError when a single value exceeds 255 bytes", () => {
    const oversized = "x".repeat(256);
    expect(() => createTLV([oversized])).toThrow(RangeError);
  });

  it("supports an empty value (length 0)", () => {
    const out = createTLV([""]);
    expect(Array.from(out)).toEqual([1, 0]);
  });
});

describe("encodeTLVAsBase64", () => {
  it("returns the base64 of the encoded TLV", () => {
    // [1, 2, 0x41, 0x42] → "AQJBQg=="
    expect(encodeTLVAsBase64(["AB"])).toBe("AQJBQg==");
  });
});
