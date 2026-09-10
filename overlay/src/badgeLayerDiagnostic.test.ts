import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { realAugmentOverlayRenderable } from "./augmentOverlayGate";
import {
  badgeLayerSignature,
  describeBadgeLayerDecision,
  type BadgeLayerGate,
} from "./badgeLayerDiagnostic";

/** Every gate open, authorized by the explicit development fixture workflow. */
const FIXTURE_AUTHORIZED: BadgeLayerGate = {
  devBuild: true,
  tierFixtureEnabled: true,
  memberCoachEnabled: false,
  previewMode: false,
  visibleFrameRenderable: true,
  offerSurfaceRenderable: true,
  geometrySchedulerHealthy: true,
  offerGeneration: 41,
  renderedBadgeCount: 3,
  previewBadgeCount: 0,
};

/** Every gate open, authorized by a real member entitlement in any build. */
const MEMBER_AUTHORIZED: BadgeLayerGate = {
  ...FIXTURE_AUTHORIZED,
  devBuild: false,
  tierFixtureEnabled: false,
  memberCoachEnabled: true,
};

describe("final badge-layer decision", () => {
  it("certifies visible badges when every gate is open under the fixture flag", () => {
    const decision = describeBadgeLayerDecision(FIXTURE_AUTHORIZED);

    expect(decision.badgeLayerVisible).toBe(true);
    expect(decision.reason).toBe("badge-layer-visible");
    expect(decision.authorized).toBe(true);
    expect(decision.authorizationSource).toBe("fixture");
    expect(decision.offerGeneration).toBe(41);
    expect(decision.renderedBadgeCount).toBe(3);
  });

  it("certifies visible badges for a real member entitlement", () => {
    const decision = describeBadgeLayerDecision(MEMBER_AUTHORIZED);

    expect(decision.badgeLayerVisible).toBe(true);
    expect(decision.reason).toBe("badge-layer-visible");
    expect(decision.authorizationSource).toBe("member");
  });

  it("names the exact gate that closed", () => {
    const rejections: Array<[Partial<BadgeLayerGate>, string]> = [
      // A plain `npm run tauri dev` launch: dev build, no fixture flag, no member.
      [{ tierFixtureEnabled: false }, "authorization-denied"],
      [{ previewMode: true }, "preview-mode"],
      [{ visibleFrameRenderable: false }, "visible-frame-rejected"],
      [{ offerSurfaceRenderable: false }, "offer-surface-rejected"],
      [{ geometrySchedulerHealthy: false }, "scheduler-unhealthy"],
      // The gate is open but there is nothing to paint: nothing was visible.
      [{ renderedBadgeCount: 0 }, "no-visible-badges"],
    ];

    for (const [override, reason] of rejections) {
      const decision = describeBadgeLayerDecision({
        ...FIXTURE_AUTHORIZED,
        ...override,
      });
      expect(decision.reason).toBe(reason);
      expect(decision.badgeLayerVisible).toBe(false);
    }
  });

  it("reports no authorization source when nothing authorized the overlay", () => {
    const decision = describeBadgeLayerDecision({
      ...FIXTURE_AUTHORIZED,
      tierFixtureEnabled: false,
    });

    expect(decision.authorized).toBe(false);
    expect(decision.authorizationSource).toBe("none");
  });

  it("never claims visibility the real render gate did not grant", () => {
    const flags = [
      "previewMode",
      "visibleFrameRenderable",
      "offerSurfaceRenderable",
      "geometrySchedulerHealthy",
      "tierFixtureEnabled",
      "memberCoachEnabled",
    ] as const;

    // Exhaustive over every combination of the six inputs the gate consults.
    for (let mask = 0; mask < 1 << flags.length; mask += 1) {
      const gate: BadgeLayerGate = { ...FIXTURE_AUTHORIZED };
      flags.forEach((flag, index) => {
        gate[flag] = (mask & (1 << index)) !== 0;
      });
      const decision = describeBadgeLayerDecision(gate);
      expect(decision.badgeLayerVisible).toBe(realAugmentOverlayRenderable(gate));
    }
  });

  it("rejects out-of-range counts and generations instead of emitting them", () => {
    const decision = describeBadgeLayerDecision({
      ...FIXTURE_AUTHORIZED,
      offerGeneration: Number.NaN,
      renderedBadgeCount: -3,
    });

    expect(decision.offerGeneration).toBe(-1);
    expect(decision.renderedBadgeCount).toBe(-1);
    expect(decision.badgeLayerVisible).toBe(false);
  });

  it("emits one logical record per decision change", () => {
    const decision = describeBadgeLayerDecision(FIXTURE_AUTHORIZED);
    const nextGeneration = describeBadgeLayerDecision({
      ...FIXTURE_AUTHORIZED,
      offerGeneration: 42,
    });

    expect(badgeLayerSignature(decision, 1)).toBe(
      badgeLayerSignature(describeBadgeLayerDecision(FIXTURE_AUTHORIZED), 1),
    );
    expect(badgeLayerSignature(decision, 1)).not.toBe(
      badgeLayerSignature(decision, 2),
    );
    expect(badgeLayerSignature(decision, 1)).not.toBe(
      badgeLayerSignature(nextGeneration, 1),
    );
  });

  it("carries no unbounded or identifying payload keys", () => {
    const decision = describeBadgeLayerDecision(FIXTURE_AUTHORIZED);

    for (const value of Object.values(decision)) {
      expect(["boolean", "number", "string"]).toContain(typeof value);
    }
    // Only the two closed enums may be strings.
    expect(
      Object.entries(decision)
        .filter(([, value]) => typeof value === "string")
        .map(([key]) => key)
        .sort(),
    ).toEqual(["authorizationSource", "reason"]);
  });
});

describe("badge-layer diagnostic integration", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  it("is emitted from the same gate that decides showBadgeLayer", () => {
    expect(app).toContain("const realFrameRenderable = realAugmentOverlayRenderable(augmentOverlayGate);");
    expect(app).toContain("describeBadgeLayerDecision({");
    expect(app).toContain("reportBadgeLayerDecision(decision, gameEpochRef.current);");
    // The whole diagnostic sits behind the fold-away development guard.
    expect(app).toContain("if (!import.meta.env.DEV) return;\n    const decision = describeBadgeLayerDecision({");
  });

  it("feeds the diagnostic the same gate inputs the render path uses", () => {
    expect(app).toContain("const badgeLayerVisibleFrame = augmentOverlayGate.visibleFrameRenderable;");
    expect(app).toContain("const badgeLayerOfferSurface = augmentOverlayGate.offerSurfaceRenderable;");
    expect(app).toContain("renderedBadgeCount: badgeLayerRealCount,");
  });
});
