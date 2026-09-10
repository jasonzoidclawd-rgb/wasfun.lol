import { describe, expect, it } from "vitest";
import {
  BADGE_CHIP_SIZE,
  cardFrameFromNameRect,
  overlayAvoidRectsCss,
  placeBadgeAboveCard,
} from "./badgeLayout";
import { cssRectFromCalibratedRect, type CssSize, type PhysicalRect } from "./calibration";

function overlaps(left: PhysicalRect, right: PhysicalRect): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

/** Name-band rects matching CARD_NAME_REGIONS (y≈0.347, h≈0.083 of the game rect). */
function nameBands(gameRect: PhysicalRect): PhysicalRect[] {
  return [0.219, 0.414, 0.609].map((x) => ({
    x: Math.round(gameRect.x + gameRect.width * x),
    y: Math.round(gameRect.y + gameRect.height * 0.347),
    width: Math.round(gameRect.width * 0.172),
    height: Math.round(gameRect.height * 0.083),
  }));
}

function placeAll(gameRect: PhysicalRect, cssWindow: CssSize) {
  const avoidRects = overlayAvoidRectsCss(cssWindow, gameRect);
  const bands = nameBands(gameRect);
  return {
    avoidRects,
    bands,
    placements: bands.map((cardRect, index) =>
      placeBadgeAboveCard({
        cardRect,
        gameRect,
        avoidRects: [
          ...avoidRects,
          ...bands
            .filter((_, other) => other !== index)
            .map((rect) => cardFrameFromNameRect(rect, gameRect)),
        ],
      }),
    ),
  };
}

describe("badge chip layout (CSS space)", () => {
  it("is a compact horizontal chip 28–36px tall", () => {
    expect(BADGE_CHIP_SIZE.height).toBeGreaterThanOrEqual(28);
    expect(BADGE_CHIP_SIZE.height).toBeLessThanOrEqual(36);
    expect(BADGE_CHIP_SIZE.width).toBeGreaterThan(BADGE_CHIP_SIZE.height);
  });

  it("derives a card frame that covers the artwork ABOVE and the body BELOW the name band", () => {
    // Measured 1280×720 reference: card frame y≈128–483, name band y≈250–310.
    const gameRect = { x: 0, y: 0, width: 1280, height: 720 };
    const nameRect = { x: 280, y: 250, width: 220, height: 60 };
    const frame = cardFrameFromNameRect(nameRect, gameRect);
    expect(frame.y).toBe(250 - Math.round(720 * 0.17)); // ≈128
    expect(frame.y + frame.height).toBe(310 + Math.round(720 * 0.24)); // ≈483
    expect(frame.x).toBe(nameRect.x);
    // The frame never escapes the game rect.
    const clipped = cardFrameFromNameRect({ ...nameRect, y: 10 }, gameRect);
    expect(clipped.y).toBe(0);
  });

  for (const [label, cssWindow, gameRect] of [
    ["1280x720 fullscreen", { width: 1280, height: 720 }, { x: 0, y: 0, width: 1280, height: 720 }],
    ["1920x1080 fullscreen", { width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }],
    [
      "windowed League inside a larger monitor",
      { width: 1280, height: 720 },
      { x: 160, y: 90, width: 960, height: 540 },
    ],
  ] as const) {
    it(`places chips above every card frame at ${label}, clear of cards and controls`, () => {
      const { avoidRects, bands, placements } = placeAll(gameRect, cssWindow);

      for (const [index, placement] of placements.entries()) {
        expect(placement).not.toBeNull();
        if (!placement) throw new Error("expected a safe chip placement");
        expect(placement.anchor).toBe("above");
        expect(placement.rect.width).toBe(BADGE_CHIP_SIZE.width);
        expect(placement.rect.height).toBe(BADGE_CHIP_SIZE.height);

        // Fully inside the game rect (and therefore the CSS window).
        expect(placement.rect.x).toBeGreaterThanOrEqual(gameRect.x);
        expect(placement.rect.y).toBeGreaterThanOrEqual(gameRect.y);
        expect(placement.rect.x + placement.rect.width).toBeLessThanOrEqual(
          gameRect.x + gameRect.width,
        );
        expect(placement.rect.y + placement.rect.height).toBeLessThanOrEqual(
          gameRect.y + gameRect.height,
        );

        // intersection(chip, cardFrame) is EMPTY, and the chip sits above the
        // frame top with a visible gap.
        const frame = cardFrameFromNameRect(bands[index], gameRect);
        expect(overlaps(placement.rect, frame)).toBe(false);
        expect(placement.rect.y + placement.rect.height).toBeLessThan(frame.y);

        // Clear of the raw name band, every reserved control (HUD, reroll,
        // central upgrade, calibration panel), and every OTHER card frame.
        expect(overlaps(placement.rect, bands[index])).toBe(false);
        for (const avoid of avoidRects) {
          expect(overlaps(placement.rect, avoid)).toBe(false);
        }
        for (const [other, band] of bands.entries()) {
          if (other === index) continue;
          expect(overlaps(placement.rect, cardFrameFromNameRect(band, gameRect))).toBe(false);
        }
      }

      // Chips of neighboring cards do not collide with each other.
      const rects = placements.map((placement) => placement!.rect);
      expect(overlaps(rects[0], rects[1])).toBe(false);
      expect(overlaps(rects[1], rects[2])).toBe(false);
    });
  }

  it("produces identical chips whether the anchor reports logical or Retina physical pixels", () => {
    // Regression pin for the 13:33:59 scale flap: the same screen state
    // expressed at scale 1.0 (logical 1280×720) and scale 2.0 (physical
    // 2560×1440) must land chips on identical CSS pixels — the conversion is
    // one anchor ratio, applied exactly once, with no devicePixelRatio.
    const cssWindow = { width: 1280, height: 720 };
    const logicalAnchor = { x: 0, y: 0, width: 1280, height: 720 };
    const physicalAnchor = { x: 0, y: 0, width: 2560, height: 1440 };

    const place = (anchor: PhysicalRect, nativeGameRect: PhysicalRect) => {
      const gameRect = cssRectFromCalibratedRect(nativeGameRect, anchor, cssWindow);
      const nativeBands = nameBands(nativeGameRect);
      const bands = nativeBands.map((band) => cssRectFromCalibratedRect(band, anchor, cssWindow));
      const avoidRects = overlayAvoidRectsCss(cssWindow, gameRect);
      return bands.map((cardRect, index) =>
        placeBadgeAboveCard({
          cardRect,
          gameRect,
          avoidRects: [
            ...avoidRects,
            ...bands
              .filter((_, other) => other !== index)
              .map((rect) => cardFrameFromNameRect(rect, gameRect)),
          ],
        }),
      );
    };

    const atScale1 = place(logicalAnchor, logicalAnchor);
    const atScale2 = place(physicalAnchor, physicalAnchor);
    // Identical up to ±1px of native rounding — the double-scaling bug this
    // pins produced half-coordinate chips (~150px off), never 1px.
    for (const [index, placement] of atScale1.entries()) {
      const other = atScale2[index];
      expect(placement).not.toBeNull();
      expect(other).not.toBeNull();
      if (!placement || !other) throw new Error("expected placements at both scales");
      expect(placement.anchor).toBe(other.anchor);
      expect(Math.abs(placement.rect.x - other.rect.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(placement.rect.y - other.rect.y)).toBeLessThanOrEqual(1);
      expect(placement.rect.width).toBe(other.rect.width);
      expect(placement.rect.height).toBe(other.rect.height);
    }
  });

  it("places identical chips on Windows 125% and 150% DPI for the same CSS window", () => {
    // Windows anchors are the physical viewport; the CSS window is the same
    // 1280×720 logical surface in both cases.
    const cssWindow = { width: 1280, height: 720 };
    const anchors = [
      { x: 0, y: 0, width: 1600, height: 900 }, // 125%
      { x: 0, y: 0, width: 1920, height: 1080 }, // 150%
    ];
    const results = anchors.map((anchor) => {
      const gameRect = cssRectFromCalibratedRect(anchor, anchor, cssWindow);
      const bands = nameBands(anchor).map((band) =>
        cssRectFromCalibratedRect(band, anchor, cssWindow),
      );
      return bands.map((cardRect) =>
        placeBadgeAboveCard({
          cardRect,
          gameRect,
          avoidRects: overlayAvoidRectsCss(cssWindow, gameRect),
        }),
      );
    });
    expect(results[0]).toEqual(results[1]);
    expect(results[0][0]).not.toBeNull();
  });

  it("clamps the chip inside the game rect for a card hugging the right edge", () => {
    const gameRect = { x: 0, y: 0, width: 1280, height: 720 };
    const placement = placeBadgeAboveCard({
      cardRect: { x: 1180, y: 250, width: 100, height: 60 },
      gameRect,
      avoidRects: overlayAvoidRectsCss({ width: 1280, height: 720 }, gameRect),
    });
    expect(placement).not.toBeNull();
    if (!placement) throw new Error("expected a clamped chip placement");
    expect(placement.rect.x).toBeGreaterThanOrEqual(0);
    expect(placement.rect.x + placement.rect.width).toBeLessThanOrEqual(1280);
  });

  it("clamps the chip inside the game rect for a card hugging the left edge", () => {
    const gameRect = { x: 0, y: 0, width: 1280, height: 720 };
    const placement = placeBadgeAboveCard({
      cardRect: { x: 0, y: 250, width: 100, height: 60 },
      gameRect,
      avoidRects: overlayAvoidRectsCss({ width: 1280, height: 720 }, gameRect),
    });
    expect(placement).not.toBeNull();
    if (!placement) throw new Error("expected a clamped chip placement");
    expect(placement.rect.x).toBeGreaterThanOrEqual(0);
  });

  it("falls back to a side anchor OUTSIDE the frame when the top margin is too narrow", () => {
    const gameRect = { x: 0, y: 0, width: 1280, height: 720 };
    const nameRect = { x: 280, y: 70, width: 220, height: 60 };
    const placement = placeBadgeAboveCard({
      cardRect: nameRect,
      gameRect,
      avoidRects: overlayAvoidRectsCss({ width: 1280, height: 720 }, gameRect),
    });
    expect(placement).not.toBeNull();
    if (!placement) throw new Error("expected a side-anchored chip placement");
    expect(placement.anchor).toBe("side");
    const frame = cardFrameFromNameRect(nameRect, gameRect);
    expect(overlaps(placement.rect, frame)).toBe(false);
  });

  it("withholds the chip entirely when no safe position exists — never inside the card", () => {
    // A game rect barely larger than the card leaves no safe space anywhere.
    const gameRect = { x: 0, y: 0, width: 240, height: 200 };
    const placement = placeBadgeAboveCard({
      cardRect: { x: 4, y: 60, width: 232, height: 138 },
      gameRect,
      avoidRects: overlayAvoidRectsCss({ width: 240, height: 200 }, gameRect),
    });
    expect(placement).toBeNull();
  });

  it("never intersects the reroll / central-upgrade control zones", () => {
    const gameRect = { x: 0, y: 0, width: 1280, height: 720 };
    const avoidRects = overlayAvoidRectsCss({ width: 1280, height: 720 }, gameRect);
    // A low-slung card frame forces the placer to negotiate around the lower
    // control zones.
    const placement = placeBadgeAboveCard({
      cardRect: { x: 530, y: 560, width: 220, height: 60 },
      gameRect,
      avoidRects,
    });
    if (placement) {
      for (const avoid of avoidRects) {
        expect(overlaps(placement.rect, avoid)).toBe(false);
      }
    }
  });

  it("anchors to the detected rectangle, not a fixed position", () => {
    const gameRect = { x: 0, y: 0, width: 1280, height: 720 };
    const avoidRects = overlayAvoidRectsCss({ width: 1280, height: 720 }, gameRect);
    const first = placeBadgeAboveCard({
      cardRect: { x: 280, y: 250, width: 220, height: 60 },
      gameRect,
      avoidRects,
    });
    const shifted = placeBadgeAboveCard({
      cardRect: { x: 280, y: 310, width: 220, height: 60 },
      gameRect,
      avoidRects,
    });

    expect(first).not.toBeNull();
    expect(shifted).not.toBeNull();
    if (!first || !shifted) throw new Error("expected safe chip placements");
    expect(shifted.rect.y).toBeGreaterThan(first.rect.y);
    expect(first.left).not.toContain("%");
  });
});
