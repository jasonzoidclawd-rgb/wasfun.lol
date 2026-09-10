import { describe, expect, it } from "vitest";
import {
  compactWinRateFromFraction,
  compactWinRateFromPercent,
  decimalShiftPercent,
  roundPercentOneDecimalHalfUp,
} from "./winRateFormat";

describe("compactWinRateFromFraction (exact string pipeline)", () => {
  it("shifts and half-up rounds the required boundary matrix", () => {
    expect(compactWinRateFromFraction("0.5914")).toBe("59.1%");
    expect(compactWinRateFromFraction("0.5915")).toBe("59.2%");
    expect(compactWinRateFromFraction("0.5916")).toBe("59.2%");
    expect(compactWinRateFromFraction("0.5")).toBe("50.0%");
    expect(compactWinRateFromFraction("0.599999")).toBe("60.0%");
    expect(compactWinRateFromFraction("0.9995")).toBe("100.0%");
    expect(compactWinRateFromFraction("0.0005")).toBe("0.1%");
  });

  it("is exact where float arithmetic would not be", () => {
    // 0.5915 × 100 = 59.150000000000006 and (59.15).toFixed(1) = "59.1" —
    // both wrong. The digit pipeline must produce "59.2%".
    expect(compactWinRateFromFraction("0.5915")).toBe("59.2%");
    // Long tails cannot accumulate float error either.
    expect(compactWinRateFromFraction("0.563213")).toBe("56.3%");
    expect(compactWinRateFromFraction("0.56350000000000001")).toBe("56.4%");
  });

  it("handles leading and trailing zeroes", () => {
    expect(compactWinRateFromFraction("00.5915")).toBe("59.2%");
    expect(compactWinRateFromFraction("0.50")).toBe("50.0%");
    expect(compactWinRateFromFraction("0.5000")).toBe("50.0%");
    expect(compactWinRateFromFraction("0.0500")).toBe("5.0%");
    expect(compactWinRateFromFraction("0")).toBe("0.0%");
    expect(compactWinRateFromFraction("1")).toBe("100.0%");
    expect(compactWinRateFromFraction("1.000")).toBe("100.0%");
  });

  it("rejects malformed, negative, and above-1 input with null", () => {
    for (const bad of ["", "abc", "0.59.15", "0,5915", ".5915", "5915e-4", " 0.5"]) {
      expect(compactWinRateFromFraction(bad)).toBeNull();
    }
    expect(compactWinRateFromFraction("-0.5")).toBeNull();
    expect(compactWinRateFromFraction("1.0001")).toBeNull();
    expect(compactWinRateFromFraction("2")).toBeNull();
  });

  it("rejects numeric input on the fraction path entirely", () => {
    expect(compactWinRateFromFraction(0.5915 as unknown as string)).toBeNull();
  });
});

describe("compactWinRateFromPercent (explicit legacy percent path)", () => {
  it("formats catalog percent numbers to one half-up decimal", () => {
    expect(compactWinRateFromPercent(61.5667)).toBe("61.6%");
    expect(compactWinRateFromPercent(50)).toBe("50.0%");
    expect(compactWinRateFromPercent(99.95)).toBe("100.0%");
    expect(compactWinRateFromPercent(0)).toBe("0.0%");
  });

  it("formats already-shifted percent strings exactly", () => {
    expect(compactWinRateFromPercent("59.15")).toBe("59.2%");
    expect(compactWinRateFromPercent("59.14")).toBe("59.1%");
    expect(compactWinRateFromPercent("100")).toBe("100.0%");
  });

  it("rejects out-of-range and malformed input with null", () => {
    expect(compactWinRateFromPercent(-1)).toBeNull();
    expect(compactWinRateFromPercent(100.01)).toBeNull();
    expect(compactWinRateFromPercent(Number.NaN)).toBeNull();
    expect(compactWinRateFromPercent(Number.POSITIVE_INFINITY)).toBeNull();
    expect(compactWinRateFromPercent("101")).toBeNull();
    expect(compactWinRateFromPercent("59.1.5")).toBeNull();
    expect(compactWinRateFromPercent(null)).toBeNull();
    expect(compactWinRateFromPercent(undefined)).toBeNull();
  });
});

describe("shift + round primitives", () => {
  it("decimalShiftPercent keeps its exact-shift contract", () => {
    expect(decimalShiftPercent("0.563213")).toBe("56.3213");
    expect(decimalShiftPercent("0.5")).toBe("50");
    expect(decimalShiftPercent("0.5000")).toBe("50.00");
    expect(decimalShiftPercent("1")).toBe("100");
    expect(() => decimalShiftPercent("0.59.15")).toThrow();
  });

  it("roundPercentOneDecimalHalfUp carries through 9s", () => {
    expect(roundPercentOneDecimalHalfUp("59.95")).toBe("60.0");
    expect(roundPercentOneDecimalHalfUp("99.99")).toBe("100.0");
    expect(roundPercentOneDecimalHalfUp("9.96")).toBe("10.0");
    expect(roundPercentOneDecimalHalfUp("59")).toBe("59.0");
    expect(roundPercentOneDecimalHalfUp("59.1499")).toBe("59.1");
    expect(() => roundPercentOneDecimalHalfUp("x")).toThrow();
  });
});
