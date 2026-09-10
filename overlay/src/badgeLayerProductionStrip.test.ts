import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(srcDir, "../dist");

/**
 * Every token the final badge-layer diagnostic contributes. A production bundle
 * that contains any of them is shipping a development-only diagnostic to users.
 */
const DIAGNOSTIC_TOKENS = [
  // The trace tag itself.
  "[badge-layer]",
  // Helper names.
  "describeBadgeLayerDecision",
  "reportBadgeLayerDecision",
  "badgeLayerSignature",
  "badgeLayerDiagnostic",
  // Reason enum.
  "badge-layer-visible",
  "authorization-denied",
  "preview-mode",
  "visible-frame-rejected",
  "offer-surface-rejected",
  "scheduler-unhealthy",
  "no-visible-badges",
  // Payload keys unique to the diagnostic.
  "badgeLayerVisible",
  "authorizationSource",
  "renderedBadgeCount",
  "previewBadgeCount",
  // Phase-1E extension of the existing offer-session family: only its new,
  // uniquely owned tokens belong in this production-strip audit.
  "describeOfferAcquisitionDiagnostic",
  "describeLiveClientStatusTransition",
  "fingerprintHashes",
  "fingerprintChangeCount",
  "confirmedRerollCount",
  "baselineSettling",
  "geometryAction",
  "timeSinceLastAcceptedOfferMs",
  "stale-result-rejected",
  "geometry-currentness",
  "surface-classification",
  "fingerprint-comparison",
  "fingerprint-confirmation",
  "superseded-geometry-sequence",
  "current-surface-absent",
  "current-surface-occluded",
  "duplicate-observation",
  "one-slot-reroll",
  "multi-slot-confirmation-pending",
  "ready->unavailable",
  "unavailable->ready",
  "ready->error",
] as const;

function bundleFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...bundleFiles(full));
    } else if (/\.(js|mjs|cjs|css|html)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe("badge-layer diagnostic production strip", () => {
  it("owns every token the audit searches for", () => {
    const source = readFileSync(join(srcDir, "badgeLayerDiagnostic.ts"), "utf8");
    const app = readFileSync(join(srcDir, "App.tsx"), "utf8");
    const marker = readFileSync(join(srcDir, "dev/publicationDiagnostics.ts"), "utf8");
    const authored = `${source}\n${app}\n${marker}`;

    // A token nothing authors would make the dist audit below vacuous.
    for (const token of DIAGNOSTIC_TOKENS) {
      expect(authored, token).toContain(token);
    }
  });

  it("guards the emitter behind a statically foldable development check", () => {
    const app = readFileSync(join(srcDir, "App.tsx"), "utf8");
    // `import.meta.env.DEV` folds to `false` in a production build, so esbuild
    // drops the effect body and Rollup then tree-shakes the whole module. A
    // runtime flag here (a state value, an env lookup) would keep it.
    expect(app).toContain("if (!import.meta.env.DEV) return;\n    const decision = describeBadgeLayerDecision({");
  });

  it("emits none of it into the production bundle (skipped until dist exists)", () => {
    if (!existsSync(distDir)) return; // build not run yet — audited in the verify step
    const files = bundleFiles(distDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const token of DIAGNOSTIC_TOKENS) {
        if (content.includes(token)) {
          offenders.push(`${file}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
