import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TierBadgeLabel } from "./TierBadgeLabel";
import type { TierLetter } from "./model/tier";

const srcDir = dirname(fileURLToPath(import.meta.url));
const overlayDir = join(srcDir, "..");

function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, "");
}

describe("tier badge label", () => {
  it.each([
    ["S+", "61.6%"],
    ["S", "57.4%"],
    ["A", "52.0%"],
    ["B", "48.9%"],
    ["C", "41.3%"],
  ] satisfies Array<[TierLetter, string]>)(
    "renders %s as only grade and exact one-decimal percentage",
    (tier, winRateText) => {
      const markup = renderToStaticMarkup(
        <TierBadgeLabel tier={tier} winRateText={winRateText} statScope="champion" />,
      );

      expect(visibleText(markup)).toBe(`${tier}·${winRateText}`);
      expect(visibleText(markup)).not.toContain("CHAMP");
      expect(visibleText(markup)).not.toContain("GLOBAL");
      expect(markup).not.toContain("badge-stat-scope");
      if (tier === "S+") expect(markup).toContain("badge-tier-two-char");
    },
  );

  it("retains champion provenance in the accessible label only", () => {
    const markup = renderToStaticMarkup(
      <TierBadgeLabel tier="S" winRateText="57.4%" statScope="champion" />,
    );

    expect(markup).toContain('aria-label="Champion-specific S tier, 57.4 percent"');
    expect(visibleText(markup)).toBe("S·57.4%");
  });

  it("has no scope prefix when statScope is null (never a global label)", () => {
    const markup = renderToStaticMarkup(
      <TierBadgeLabel tier="B" winRateText="48.9%" statScope={null} />,
    );

    expect(markup).toContain('aria-label="B tier, 48.9 percent"');
    expect(markup).not.toContain("Global");
    expect(visibleText(markup)).toBe("B·48.9%");
  });

  it("keeps the fixed badge geometry and centers the compact label without scope spacing", () => {
    const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.badge-chip\s*\{[^}]*width:\s*118px;[^}]*height:\s*32px;/s);
    expect(css).toMatch(
      /\.badge-label\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*gap:\s*6px;/s,
    );
    expect(css).not.toContain(".badge-stat-scope");
    expect(css).not.toContain(".badge-chip-scoped");
  });

  it("emits the centered compact label without legacy scope spacing in production CSS", () => {
    const distAssets = join(overlayDir, "dist/assets");
    if (!existsSync(distAssets)) return;
    const productionCss = readdirSync(distAssets)
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(join(distAssets, file), "utf8"))
      .join("\n");

    expect(productionCss).toContain(
      ".badge-label{display:flex;align-items:center;justify-content:center;gap:6px;min-width:0}",
    );
    expect(productionCss).not.toContain("badge-stat-scope");
    expect(productionCss).not.toContain("badge-chip-scoped");
  });
});
