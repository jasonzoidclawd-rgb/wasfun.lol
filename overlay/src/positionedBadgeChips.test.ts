import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { positionBadgeChips, type PlaceableSlot } from "./positionedBadgeChips";
import { describeBadgeLayerDecision, type BadgeLayerGate } from "./badgeLayerDiagnostic";
import type { CssSize, OverlayCalibration, PhysicalRect } from "./calibration";
import type { SlotChip } from "./BadgeChipLayer";

const CSS_WINDOW: CssSize = { width: 1280, height: 720 };

const CALIBRATION: OverlayCalibration = {
  viewport: { x: 0, y: 0, width: 1280, height: 720 },
  overlayAnchor: { x: 0, y: 0, width: 1280, height: 720 },
} as OverlayCalibration;

/** Name-band rects matching CARD_NAME_REGIONS (y≈0.347, h≈0.083 of the game rect). */
function nameBand(index: number): PhysicalRect {
  const x = [0.219, 0.414, 0.609][index];
  return {
    x: Math.round(1280 * x),
    y: Math.round(720 * 0.347),
    width: Math.round(1280 * 0.172),
    height: Math.round(720 * 0.083),
  };
}

function chip(regionIndex: number): SlotChip {
  return {
    regionIndex,
    key: `slot-${regionIndex}-g41`,
    state: "tier",
    tier: "S",
    winRateText: "59.2%",
    isNew: false,
    statScope: "champion",
  };
}

function slots(...regionIndexes: number[]): PlaceableSlot[] {
  return [0, 1, 2].map((regionIndex) => ({
    regionIndex,
    cardRect: regionIndexes.includes(regionIndex) ? nameBand(regionIndex) : null,
  }));
}

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
  renderedBadgeCount: 0,
  previewBadgeCount: 0,
};

describe("positioned badge chips", () => {
  it("positions every chip whose slot supplied a rect this capture", () => {
    const positioned = positionBadgeChips({
      chips: [chip(0), chip(1), chip(2)],
      calibration: CALIBRATION,
      slots: slots(0, 1, 2),
      cssWindow: CSS_WINDOW,
    });

    expect(positioned).toHaveLength(3);
    expect(positioned.map((entry) => entry.regionIndex)).toEqual([0, 1, 2]);
    for (const entry of positioned) {
      expect(entry.key).toBe(`slot-${entry.regionIndex}-g41`);
      expect(entry.position.left).toMatch(/^-?\d+px$/);
      expect(entry.position.top).toMatch(/^-?\d+px$/);
    }
  });

  it("drops a chip whose slot supplied no rect", () => {
    // The offer surface listed three chips but this capture only produced a
    // rectangle for two of them; the third paints nothing.
    const positioned = positionBadgeChips({
      chips: [chip(0), chip(1), chip(2)],
      calibration: CALIBRATION,
      slots: slots(0, 2),
      cssWindow: CSS_WINDOW,
    });

    expect(positioned.map((entry) => entry.regionIndex)).toEqual([0, 2]);
  });

  it("counts only the positioned chips in a mixed set", () => {
    const positioned = positionBadgeChips({
      chips: [chip(0), chip(1), chip(2)],
      calibration: CALIBRATION,
      slots: slots(1),
      cssWindow: CSS_WINDOW,
    });

    expect(positioned).toHaveLength(1);
    expect(positioned[0].regionIndex).toBe(1);
  });

  it("produces zero badges when calibration is unavailable", () => {
    expect(
      positionBadgeChips({
        chips: [chip(0), chip(1), chip(2)],
        calibration: null,
        slots: slots(0, 1, 2),
        cssWindow: CSS_WINDOW,
      }),
    ).toEqual([]);
  });

  it("produces zero badges when the capture supplied no frame at all", () => {
    expect(
      positionBadgeChips({
        chips: [chip(0), chip(1), chip(2)],
        calibration: CALIBRATION,
        slots: null,
        cssWindow: CSS_WINDOW,
      }),
    ).toEqual([]);
  });
});

describe("positioned badge chips when placement fails", () => {
  it("produces zero badges when placeBadgeAboveCard finds nowhere to put them", async () => {
    vi.resetModules();
    vi.doMock("./badgeLayout", async () => {
      const actual = await vi.importActual<typeof import("./badgeLayout")>("./badgeLayout");
      return { ...actual, placeBadgeAboveCard: () => null };
    });
    const { positionBadgeChips: withoutPlacement } = await import("./positionedBadgeChips");

    expect(
      withoutPlacement({
        chips: [chip(0), chip(1), chip(2)],
        calibration: CALIBRATION,
        slots: slots(0, 1, 2),
        cssWindow: CSS_WINDOW,
      }),
    ).toEqual([]);

    vi.doUnmock("./badgeLayout");
    vi.resetModules();
  });
});

describe("badge-layer count versus rendered DOM nodes", () => {
  async function renderBadgeLayer(positionedChips: ReturnType<typeof positionBadgeChips<SlotChip>>) {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { BadgeChipLayer } = await import("./BadgeChipLayer");
    const markup = renderToStaticMarkup(
      BadgeChipLayer({ positionedChips, isPreviewMode: false }),
    );
    // Only the top-level chip elements; `badge-chip-sep` inside the tier label
    // is not a badge.
    return (markup.match(/<div class="badge-chip/g) ?? []).length;
  }

  it("reports exactly as many badges as the layer paints", async () => {
    for (const present of [[0, 1, 2], [0, 2], [1], []]) {
      const positioned = positionBadgeChips({
        chips: [chip(0), chip(1), chip(2)],
        calibration: CALIBRATION,
        slots: slots(...present),
        cssWindow: CSS_WINDOW,
      });
      const decision = describeBadgeLayerDecision({
        ...FIXTURE_AUTHORIZED,
        renderedBadgeCount: positioned.length,
      });

      expect(decision.renderedBadgeCount).toBe(await renderBadgeLayer(positioned));
    }
  });

  it("never certifies visible badges when nothing was positioned", () => {
    const positioned = positionBadgeChips({
      chips: [chip(0), chip(1), chip(2)],
      calibration: null,
      slots: slots(0, 1, 2),
      cssWindow: CSS_WINDOW,
    });
    const decision = describeBadgeLayerDecision({
      ...FIXTURE_AUTHORIZED,
      renderedBadgeCount: positioned.length,
    });

    expect(decision.badgeLayerVisible).toBe(false);
    expect(decision.reason).toBe("no-visible-badges");
  });

  it("still certifies fixture-authorized and member-authorized positioned badges", () => {
    const positioned = positionBadgeChips({
      chips: [chip(0), chip(1), chip(2)],
      calibration: CALIBRATION,
      slots: slots(0, 1, 2),
      cssWindow: CSS_WINDOW,
    });
    expect(positioned).toHaveLength(3);

    const fixture = describeBadgeLayerDecision({
      ...FIXTURE_AUTHORIZED,
      renderedBadgeCount: positioned.length,
    });
    expect(fixture.badgeLayerVisible).toBe(true);
    expect(fixture.authorizationSource).toBe("fixture");
    expect(fixture.renderedBadgeCount).toBe(3);

    const member = describeBadgeLayerDecision({
      ...FIXTURE_AUTHORIZED,
      devBuild: false,
      tierFixtureEnabled: false,
      memberCoachEnabled: true,
      renderedBadgeCount: positioned.length,
    });
    expect(member.badgeLayerVisible).toBe(true);
    expect(member.authorizationSource).toBe("member");
    expect(member.renderedBadgeCount).toBe(3);
  });
});

describe("App wiring of the positioned collection", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const layer = readFileSync(new URL("./BadgeChipLayer.tsx", import.meta.url), "utf8");

  it("counts the diagnostic from the positioned collection, never from slotChips", () => {
    expect(app).toContain("const badgeLayerRealCount = realFrameRenderable ? positionedChips.length : 0;");
    expect(app).toContain("const badgeLayerPreviewCount = previewBadgesReady ? positionedChips.length : 0;");
    expect(app).not.toContain("slotChips.length : 0");
  });

  it("renders the DOM from the same collection with no second drop decision", () => {
    expect(app).toContain("<BadgeChipLayer\n          positionedChips={positionedChips}");
    expect(layer).toContain("positionedChips.map(");
    // A `return null` inside the map would paint fewer nodes than were counted.
    expect(layer).not.toMatch(/return null/);
  });

  it("keeps positioning logic in exactly one place", () => {
    expect(app).not.toContain("placeBadgeAboveCard");
    expect(app).toContain("positionBadgeChips({");
  });
});
