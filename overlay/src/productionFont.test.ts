import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = dirname(fileURLToPath(import.meta.url));
const overlayDir = join(srcDir, "..");

describe("Anton tier-glyph font asset", () => {
  it("bundles a real local woff2 with its OFL license", () => {
    const fontPath = join(srcDir, "assets/fonts/anton-latin.woff2");
    expect(existsSync(fontPath)).toBe(true);
    const bytes = readFileSync(fontPath);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("wOF2");
    expect(bytes.length).toBeGreaterThan(1_000);

    const license = readFileSync(join(srcDir, "assets/fonts/OFL.txt"), "utf8");
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(license).toContain("Anton");
  });

  it("references the font locally and never a remote font URL", () => {
    const css = readFileSync(join(srcDir, "App.css"), "utf8");
    expect(css).toContain('font-family: "Anton"');
    expect(css).toContain("./assets/fonts/anton-latin.woff2");
    // No url(...) in the stylesheet may point at a remote host.
    const remoteUrls = css.match(/url\(\s*["']?https?:/gi) ?? [];
    expect(remoteUrls).toEqual([]);
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it("emits the font into the production bundle with no remote font requests (skipped until dist exists)", () => {
    const distAssets = join(overlayDir, "dist/assets");
    if (!existsSync(distAssets)) return; // build not run yet — audited in CI/verify step
    const files = readdirSync(distAssets);
    expect(files.some((file) => /anton.*\.woff2$/i.test(file))).toBe(true);
    for (const file of files.filter((name) => /\.(css|js)$/.test(name))) {
      const content = readFileSync(join(distAssets, file), "utf8");
      expect(content).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
      const remoteFontUrls = content.match(/url\(\s*["']?https?:[^)]*\.(woff2?|ttf|otf)/gi) ?? [];
      expect(remoteFontUrls).toEqual([]);
    }
  });
});
