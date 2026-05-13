/**
 * Unit tests for the datetime helpers.
 *
 * Coverage targets:
 * - Round-trip a known ISO string through every helper and verify
 *   the exact ZATCA wire format.
 * - Edge cases: midnight (`00:00:00`), end-of-second (`.999Z`),
 *   leap-second-safe (Feb 29 in a leap year), sub-second precision.
 * - Reject `Invalid Date` inputs eagerly.
 */

import { describe, expect, it } from "vitest";
import {
  extractZatcaDateTime,
  formatSignTimestamp,
  formatZatcaDate,
  formatZatcaDateTime,
  formatZatcaTime,
} from "./datetime.js";

describe("formatZatcaDate", () => {
  it("formats a UTC Date as YYYY-MM-DD", () => {
    expect(formatZatcaDate(new Date("2024-01-15T14:30:45.123Z"))).toBe("2024-01-15");
  });

  it("accepts an ISO string", () => {
    expect(formatZatcaDate("2024-01-15T14:30:45.123Z")).toBe("2024-01-15");
  });

  it("handles leap-year Feb 29 correctly", () => {
    expect(formatZatcaDate("2024-02-29T00:00:00Z")).toBe("2024-02-29");
  });

  it("handles midnight (00:00:00)", () => {
    expect(formatZatcaDate("2024-01-15T00:00:00Z")).toBe("2024-01-15");
  });
});

describe("formatZatcaTime", () => {
  it("formats a UTC Date as HH:mm:ssZ", () => {
    expect(formatZatcaTime(new Date("2024-01-15T14:30:45.123Z"))).toBe("14:30:45Z");
  });

  it("preserves seconds at end-of-day boundary", () => {
    expect(formatZatcaTime("2024-01-15T23:59:59.999Z")).toBe("23:59:59Z");
  });

  it("formats midnight as 00:00:00Z", () => {
    expect(formatZatcaTime("2024-01-15T00:00:00Z")).toBe("00:00:00Z");
  });

  it("truncates sub-second precision (does not round)", () => {
    expect(formatZatcaTime("2024-01-15T14:30:45.999Z")).toBe("14:30:45Z");
  });
});

describe("formatZatcaDateTime", () => {
  it("formats as YYYY-MM-DDTHH:mm:ss (no trailing Z)", () => {
    expect(formatZatcaDateTime(new Date("2024-01-15T14:30:45.123Z"))).toBe(
      "2024-01-15T14:30:45",
    );
  });

  it("preserves UTC even when given a Date constructed locally", () => {
    const d = new Date(Date.UTC(2024, 0, 15, 14, 30, 45));
    expect(formatZatcaDateTime(d)).toBe("2024-01-15T14:30:45");
  });
});

describe("formatSignTimestamp", () => {
  it("appends Z to the combined timestamp", () => {
    expect(formatSignTimestamp("2024-01-15T14:30:45Z")).toBe("2024-01-15T14:30:45Z");
  });

  it("strips milliseconds", () => {
    expect(formatSignTimestamp("2024-01-15T14:30:45.999Z")).toBe(
      "2024-01-15T14:30:45Z",
    );
  });
});

describe("extractZatcaDateTime", () => {
  it("returns the canonical pair", () => {
    expect(extractZatcaDateTime("2024-01-15T14:30:45.123Z")).toEqual({
      issue_date: "2024-01-15",
      issue_time: "14:30:45Z",
    });
  });
});

describe("invalid inputs", () => {
  it("rejects non-parseable strings", () => {
    expect(() => formatZatcaDate("not a date")).toThrow(TypeError);
  });

  it("rejects invalid Date instances", () => {
    expect(() => formatZatcaTime(new Date("invalid"))).toThrow(TypeError);
  });
});
