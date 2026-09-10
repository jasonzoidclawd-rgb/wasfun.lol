import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { auditWindowsArtifact } from "./audit-windows-artifact.mjs";

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value));
}

async function createOverlayFixture() {
  const overlayRoot = mkdtempSync(join(tmpdir(), "mayhem-overlay-audit-"));
  await mkdir(join(overlayRoot, "public", "data", "abilities"), { recursive: true });
  await mkdir(join(overlayRoot, "dist", "data", "abilities"), { recursive: true });
  await mkdir(join(overlayRoot, "dist", "assets"), { recursive: true });
  await mkdir(join(overlayRoot, "src-tauri", "capabilities"), { recursive: true });
  await mkdir(join(overlayRoot, "src-tauri", "target", "release", "bundle", "nsis"), {
    recursive: true,
  });

  await writeJson(join(overlayRoot, "public", "data", "augments.json"), { augments: [] });
  await writeJson(join(overlayRoot, "public", "data", "champions.json"), { champions: [] });
  await writeJson(join(overlayRoot, "public", "data", "combos.json"), { combos: [] });
  await writeJson(join(overlayRoot, "public", "data", "pool-rules.json"), { rules: [] });
  await writeFile(join(overlayRoot, "public", "data", "abilities", "brand.json"), "{}");

  await writeFile(join(overlayRoot, "dist", "index.html"), "<script src=\"/assets/app.js\"></script>");
  await writeFile(join(overlayRoot, "dist", "data", "augments.json"), "{\"augments\":[]}");
  await writeFile(join(overlayRoot, "dist", "data", "champions.json"), "{\"champions\":[]}");
  await writeFile(join(overlayRoot, "dist", "data", "combos.json"), "{\"combos\":[]}");
  await writeFile(join(overlayRoot, "dist", "data", "pool-rules.json"), "{\"rules\":[]}");
  await writeFile(join(overlayRoot, "dist", "data", "abilities", "brand.json"), "{}");
  await writeFile(
    join(overlayRoot, "src-tauri", "capabilities", "default.json"),
    "{\"permissions\":[\"core:default\"]}",
  );
  await writeFile(
    join(overlayRoot, "src-tauri", "tauri.conf.json"),
    JSON.stringify({
      build: { frontendDist: "../dist" },
      app: { security: { csp: "default-src 'self'" } },
      bundle: { active: true },
    }),
  );
  await writeFile(
    join(overlayRoot, "src-tauri", "target", "release", "bundle", "nsis", "Mayhem.exe"),
    "fake unsigned installer",
  );

  return overlayRoot;
}

describe("windows artifact audit", () => {
  test("accepts a local packaged overlay tree with public data and capabilities", async () => {
    const overlayRoot = await createOverlayFixture();

    await expect(auditWindowsArtifact({ overlayRoot })).resolves.toMatchObject({
      checkedRoots: expect.arrayContaining([
        expect.stringContaining("public/data"),
        expect.stringContaining("dist"),
        expect.stringContaining("src-tauri/capabilities"),
      ]),
    });
  });

  test("rejects forbidden artifact contents", async () => {
    const overlayRoot = await createOverlayFixture();
    await writeFile(join(overlayRoot, "dist", ".env"), "RIOT_API_KEY=RGAPI-secret");

    await expect(auditWindowsArtifact({ overlayRoot })).rejects.toThrow(/forbidden/i);
  });

  test("rejects built renderer output without packaged public data", async () => {
    const overlayRoot = await createOverlayFixture();
    await rm(join(overlayRoot, "dist", "data"), { recursive: true });

    await expect(auditWindowsArtifact({ overlayRoot })).rejects.toThrow(/dist\/data/i);
  });

  test("rejects built renderer output without packaged ability data", async () => {
    const overlayRoot = await createOverlayFixture();
    await rm(join(overlayRoot, "dist", "data", "abilities"), { recursive: true });

    await expect(auditWindowsArtifact({ overlayRoot })).rejects.toThrow(/ability/i);
  });

  test("rejects remote renderer JavaScript", async () => {
    const overlayRoot = await createOverlayFixture();
    await writeFile(
      join(overlayRoot, "dist", "index.html"),
      "<script src=\"https://cdn.example.invalid/overlay.js\"></script>",
    );

    await expect(auditWindowsArtifact({ overlayRoot })).rejects.toThrow(/remote/i);
  });

  test("rejects development-only overlay surfaces in renderer output", async () => {
    const overlayRoot = await createOverlayFixture();
    await writeFile(
      join(overlayRoot, "dist", "assets", "app.js"),
      "ARAMGG TIER FIXTURE data-dev-only force-refresh Foreground: app=",
    );

    await expect(auditWindowsArtifact({ overlayRoot })).rejects.toThrow(/forbidden/i);
  });

  test("allows inert ARAMGG resolution field names without a dev adapter", async () => {
    const overlayRoot = await createOverlayFixture();
    await writeFile(
      join(overlayRoot, "dist", "assets", "app.js"),
      "const resolution = { aramgg: null };",
    );

    await expect(auditWindowsArtifact({ overlayRoot })).resolves.toBeDefined();
  });

  test("rejects an ARAMGG development adapter in renderer output", async () => {
    const overlayRoot = await createOverlayFixture();
    await writeFile(
      join(overlayRoot, "dist", "assets", "app.js"),
      "fetch('/aramgg-dev/augment-stats.json');",
    );

    await expect(auditWindowsArtifact({ overlayRoot })).rejects.toThrow(/forbidden/i);
  });

  test("rejects geometry rolling diagnostics in renderer output", async () => {
    const overlayRoot = await createOverlayFixture();
    await writeFile(
      join(overlayRoot, "dist", "assets", "app.js"),
      "window.__getGeometryProbeDiagnostics = () => []; console.info('[geometry-probe]');",
    );

    await expect(auditWindowsArtifact({ overlayRoot })).rejects.toThrow(/forbidden/i);
  });
});
