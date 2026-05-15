/**
 * Unit tests — {@link toFixedNoRounding}.
 *
 * The legacy `Number.prototype.toFixedNoRounding` helper has been
 * lifted to a free function. Behaviour must remain byte-identical to
 * the legacy implementation for the ZATCA fixtures to round-trip.
 */

import { describe, expect, it } from "vitest";
import { toFixedNoRounding } from "./fixed-no-rounding.js";

describe("toFixedNoRounding", () => {
  it("pads an integer with the requested fractional zeros", () => {
    expect(toFixedNoRounding(20, 2)).toBe("20.00");
    expect(toFixedNoRounding(0, 2)).toBe("0.00");
    expect(toFixedNoRounding(1, 4)).toBe("1.0000");
  });

  it("pads a value with insufficient fractional digits", () => {
    expect(toFixedNoRounding(20.5, 2)).toBe("20.50");
    expect(toFixedNoRounding(1.1, 3)).toBe("1.100");
  });

  it("truncates (never rounds) beyond the requested precision", () => {
    expect(toFixedNoRounding(3.149, 2)).toBe("3.14");
    expect(toFixedNoRounding(2.999, 2)).toBe("2.99");
  });

  it("handles negative numbers", () => {
    expect(toFixedNoRounding(-3.149, 2)).toBe("-3.14");
    expect(toFixedNoRounding(-1, 2)).toBe("-1.00");
  });

  it("returns '0.00' for NaN", () => {
    expect(toFixedNoRounding(Number.NaN, 2)).toBe("0.00");
  });
});
