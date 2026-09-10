import { describe, expect, test } from "vitest";
import {
  CARD_NAME_REGIONS,
  cssRectFromCalibratedRect,
  physicalRectForNormalizedRegion,
  selectOverlayViewport,
} from "./calibration";

describe("overlay calibration", () => {
  test("uses monitor bounds for a 1920x1080 borderless League window", () => {
    const calibration = selectOverlayViewport(
      { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );

    expect(calibration.mode).toBe("borderless-monitor-fallback");
    expect(calibration.viewport).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(calibration.warnings).toEqual([]);
  });

  test("supports 2560x1080 ultrawide borderless without clipping card regions", () => {
    const viewport = { x: 0, y: 0, width: 2560, height: 1080 };

    const rects = CARD_NAME_REGIONS.map((region) =>
      physicalRectForNormalizedRegion(region, viewport),
    );

    expect(rects).toHaveLength(3);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(2560);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1080);
    }
  });

  test("anchor-ratio conversion is immune to a flapping scale factor", () => {
    // Regression pin for the 13:33:59 chip jump: the same anchored rect must
    // land on the same CSS pixels whether the monitor reports scale 1.0 or
    // 2.0 — scaleFactor is simply not an input to the conversion.
    const nameBand = { x: 280, y: 250, width: 220, height: 60 };
    const anchor = { x: 0, y: 0, width: 1280, height: 720 };
    const cssWindow = { width: 1280, height: 720 };

    expect(cssRectFromCalibratedRect(nameBand, anchor, cssWindow)).toEqual(nameBand);
  });

  test("a Retina physical-pixel anchor converts to the same CSS geometry", () => {
    // 2560×1440 capture-space rects with a 1280×720 CSS window: the ratio
    // halves everything — no devicePixelRatio division anywhere downstream.
    const cssWindow = { width: 1280, height: 720 };
    const anchor = { x: 0, y: 0, width: 2560, height: 1440 };

    expect(
      cssRectFromCalibratedRect(
        { x: 560, y: 500, width: 440, height: 120 },
        anchor,
        cssWindow,
      ),
    ).toEqual({ x: 280, y: 250, width: 220, height: 60 });
  });

  test("a windowed League viewport converts with the anchor offset applied once", () => {
    const cssWindow = { width: 1280, height: 720 };
    const anchor = { x: 0, y: 0, width: 2560, height: 1440 };
    const viewport = { x: 320, y: 180, width: 1920, height: 1080 };

    expect(cssRectFromCalibratedRect(viewport, anchor, cssWindow)).toEqual({
      x: 160,
      y: 90,
      width: 960,
      height: 540,
    });
  });

  test("detected-window and monitor-fallback modes produce equivalent CSS geometry", () => {
    // Regression pin for the flap between "league-window" and
    // "monitor-fallback": for a borderless window both modes resolve the same
    // viewport AND the same anchor, so the converted card geometry cannot
    // move when window detection transiently fails.
    const monitor = { x: 0, y: 0, width: 1280, height: 720, scaleFactor: 2 };
    const detected = selectOverlayViewport(monitor, { x: 0, y: 0, width: 1280, height: 720 });
    const fallback = selectOverlayViewport(monitor, null);
    const cssWindow = { width: 1280, height: 720 };

    expect(detected.overlayAnchor).toEqual(fallback.overlayAnchor);
    for (const region of CARD_NAME_REGIONS) {
      const detectedCss = cssRectFromCalibratedRect(
        physicalRectForNormalizedRegion(region, detected.viewport),
        detected.overlayAnchor,
        cssWindow,
      );
      const fallbackCss = cssRectFromCalibratedRect(
        physicalRectForNormalizedRegion(region, fallback.viewport),
        fallback.overlayAnchor,
        cssWindow,
      );
      expect(detectedCss).toEqual(fallbackCss);
    }
  });

  test("falls back to the monitor when the League window is unavailable", () => {
    const calibration = selectOverlayViewport(
      { x: 0, y: 0, width: 2560, height: 1080, scaleFactor: 1 },
      null,
    );

    expect(calibration.mode).toBe("monitor-fallback");
    expect(calibration.viewport).toEqual({ x: 0, y: 0, width: 2560, height: 1080 });
    expect(calibration.warnings).toContain("League window not detected; using monitor bounds.");
  });

  test("every selection mode carries the monitor as the overlay anchor", () => {
    const monitor = { x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 2 };
    const expected = { x: 0, y: 0, width: 2560, height: 1440 };

    for (const calibration of [
      selectOverlayViewport(monitor, { x: 0, y: 0, width: 2560, height: 1440 }),
      selectOverlayViewport(monitor, { x: 320, y: 180, width: 1920, height: 1080 }),
      selectOverlayViewport(monitor, null),
    ]) {
      expect(calibration.overlayAnchor).toEqual(expected);
    }
  });
});
