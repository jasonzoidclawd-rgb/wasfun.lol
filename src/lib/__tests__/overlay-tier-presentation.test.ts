import { describe, expect, test } from "vitest";
import type { DecisionGrade } from "../contracts/decision";
import {
  TIER_COLORS,
  formatWinRate,
  tierClassName,
  tierForGrade,
} from "../../../overlay/src/model/tier";

describe("overlay tier presentation (DESIGN.md v1)", () => {
  test("maps the five decision grades onto the S+/S/A/B/C tier scale", () => {
    const expected: Record<DecisionGrade, string> = {
      hot: "S+",
      strong: "S",
      steady: "A",
      average: "B",
      weak: "C",
    };
    for (const [grade, letter] of Object.entries(expected)) {
      expect(tierForGrade(grade as DecisionGrade)).toBe(letter);
    }
  });

  test("uses the frozen DESIGN.md tier tokens", () => {
    expect(TIER_COLORS).toEqual({
      "S+": "#ff4655",
      S: "#ff8c00",
      A: "#3b82f6",
      B: "#22c55e",
      C: "#6b7280",
    });
  });

  test("derives a stable css class per tier letter", () => {
    expect(tierClassName("S+")).toBe("tier-splus");
    expect(tierClassName("S")).toBe("tier-s");
    expect(tierClassName("A")).toBe("tier-a");
    expect(tierClassName("B")).toBe("tier-b");
    expect(tierClassName("C")).toBe("tier-c");
  });

  test("formats win rate with one decimal and preserves missing data", () => {
    expect(formatWinRate(52.34)).toBe("52.3% WR");
    expect(formatWinRate(50)).toBe("50.0% WR");
    expect(formatWinRate(null)).toBe("WR —");
    expect(formatWinRate(undefined)).toBe("WR —");
    expect(formatWinRate(Number.NaN)).toBe("WR —");
  });
});
