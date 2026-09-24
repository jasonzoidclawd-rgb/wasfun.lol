/** Site-wide gate: every letter chip clears 4.5:1 contrast in both themes and carries its letter as text. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, test } from "vitest";
import { LetterChip } from "@/components/grades/LetterChip";

const css = readFileSync(path.join(process.cwd(), "src/styles/globals.css"), "utf-8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe("letter chip contrast", () => {
  for (const [theme, tokens, cardBg] of [
    ["dark", block(":root"), "#1a1f2e"],
    ["light", block('[data-theme="light"]'), "#ffffff"],
  ] as const) {
    test(`${theme}: every solid chip's ink on its fill, and the open chips' ink on the card, ≥ 4.5:1`, () => {
      for (const L of ["S", "A", "B", "C", "D"]) {
        const ratio = contrast(tokens[`--grade-${L}-ink`], tokens[`--grade-${L}-fill`]);
        expect(ratio, `${theme} ${L}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(tokens["--grade-open-ink"], cardBg)).toBeGreaterThanOrEqual(4.5);
      // outlined chips: the border is a graphical object, ≥ 3:1 (WCAG 1.4.11)
      for (const L of ["S", "A", "B", "C", "D"]) {
        const ratio = contrast(tokens[`--grade-${L}-edge`], cardBg);
        expect(ratio, `${theme} ${L} edge: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  test("the chip carries its letter as text and its meaning as a label", () => {
    const html = renderToStaticMarkup(createElement(LetterChip, { letter: "S", estimated: true, label: "Grade S, estimated" }));
    expect(html).toContain(">S<");
    expect(html).toContain('aria-label="Grade S, estimated"');
    expect(html).toContain("is-dashed");
  });
});
