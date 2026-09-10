import type { CssSize, NormalizedRegion, PhysicalRect } from "./calibration";

export interface BadgeSize {
  width: number;
  height: number;
}

export interface BadgePlacement {
  left: string;
  top: string;
  rect: PhysicalRect;
  /** "above" = centered over the card frame; "side" = compact anchor outside it. */
  anchor: "above" | "side";
}

/**
 * Compact horizontal chip (e.g. `[S+ · 61.6%]`) rendered OUTSIDE the card
 * artwork. Height must stay within 28–36 CSS px.
 *
 * Everything in this module is CSS pixels in overlay-window coordinates. The
 * caller converts native calibrated rects exactly once at the boundary via
 * `cssRectFromCalibratedRect` — no scale factor exists here.
 */
export const BADGE_CHIP_SIZE: BadgeSize = {
  width: 118,
  height: 32,
};

const BADGE_GAP = 6;

/**
 * The detected rectangle is the card's NAME band (the OCR crop region,
 * normalized y ≈ 0.347, h ≈ 0.083 of the game rect). Measured on the 1280×720
 * reference screenshot the full card frame spans y ≈ 128–483 while the name
 * band spans y ≈ 250–310, so the artwork/icon band ABOVE the name band is
 * (250−128)/720 ≈ 0.17 of the game height and the description body BELOW it
 * is (483−310)/720 ≈ 0.24. A chip anchored to the name band alone would sit
 * inside the artwork — the frame is the true keep-out.
 */
export const CARD_ICON_BAND_VIEWPORT_RATIO = 0.17;
export const CARD_BODY_BAND_VIEWPORT_RATIO = 0.24;

/**
 * Derive the full card frame (icon band above + name band + description body
 * below) from the detected name-band rectangle. Space-agnostic ratios; used
 * here in CSS space with the CSS game rect.
 */
export function cardFrameFromNameRect(
  nameRect: PhysicalRect,
  gameRect: PhysicalRect,
): PhysicalRect {
  const iconBand = Math.round(gameRect.height * CARD_ICON_BAND_VIEWPORT_RATIO);
  const bodyBand = Math.round(gameRect.height * CARD_BODY_BAND_VIEWPORT_RATIO);
  const top = Math.max(gameRect.y, nameRect.y - iconBand);
  const frameBottom = Math.min(
    gameRect.y + gameRect.height,
    nameRect.y + nameRect.height + bodyBand,
  );
  return {
    x: nameRect.x,
    y: top,
    width: nameRect.width,
    height: Math.max(0, frameBottom - top),
  };
}

function right(rect: PhysicalRect): number {
  return rect.x + rect.width;
}

function bottom(rect: PhysicalRect): number {
  return rect.y + rect.height;
}

function overlaps(left: PhysicalRect, rightRect: PhysicalRect): boolean {
  return !(
    right(left) <= rightRect.x ||
    right(rightRect) <= left.x ||
    bottom(left) <= rightRect.y ||
    bottom(rightRect) <= left.y
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/**
 * Game-control keep-out zones as fractions of the game rect, measured on the
 * 1280×720 reference: per-card reroll buttons y ≈ 497–523 under the three
 * cards, central upgrade (升級) control y ≈ 575–608. They scale with the game
 * viewport, not with DPI.
 */
const GAME_CONTROL_ZONES: NormalizedRegion[] = [
  { x: 0.19, y: 0.67, w: 0.62, h: 0.08 },
  { x: 0.4, y: 0.78, w: 0.2, h: 0.09 },
];

/**
 * Reserve fixed overlay UI (relative to the CSS window) and game controls
 * (relative to the CSS game rect). Badge positions themselves always come
 * from the detected card rectangle of the current OCR scan.
 */
export function overlayAvoidRectsCss(
  cssWindow: CssSize,
  cssGameRect: PhysicalRect,
): PhysicalRect[] {
  return [
    // Status dot / startup HUD band across the top of the overlay window.
    { x: 0, y: 0, width: cssWindow.width, height: 44 },
    // Development calibration panel (bottom-left, above the HUD strip). It is
    // absent from production, but badges must also remain safe while
    // diagnostics are enabled.
    {
      x: 0,
      y: Math.max(0, cssWindow.height - 198),
      width: 360,
      height: 150,
    },
    ...GAME_CONTROL_ZONES.map((zone) => ({
      x: cssGameRect.x + Math.round(zone.x * cssGameRect.width),
      y: cssGameRect.y + Math.round(zone.y * cssGameRect.height),
      width: Math.round(zone.w * cssGameRect.width),
      height: Math.round(zone.h * cssGameRect.height),
    })),
  ];
}

/**
 * Place a compact chip immediately above the card FRAME derived from the
 * detected name-band rectangle. The chip never overlaps the card frame (art,
 * icons, name, description), reserved HUD/game controls, or any rect in
 * `avoidRects` (callers pass the other card frames there so a fallback anchor
 * cannot cover a neighboring card). When the space above the frame is too
 * narrow, a compact side anchor OUTSIDE the card is used instead; if no safe
 * position exists the chip is withheld entirely — never rendered inside the
 * card.
 */
export function placeBadgeAboveCard({
  cardRect,
  gameRect,
  avoidRects = [],
  size = BADGE_CHIP_SIZE,
}: {
  /** Detected name-band rect, CSS px in overlay-window coordinates. */
  cardRect: PhysicalRect;
  /** Calibrated game viewport, CSS px in the same coordinates. */
  gameRect: PhysicalRect;
  avoidRects?: PhysicalRect[];
  size?: BadgeSize;
}): BadgePlacement | null {
  const frame = cardFrameFromNameRect(cardRect, gameRect);
  const blockers = [frame, ...avoidRects];

  const fits = (candidate: PhysicalRect): boolean =>
    candidate.x >= gameRect.x &&
    candidate.y >= gameRect.y &&
    right(candidate) <= right(gameRect) &&
    bottom(candidate) <= bottom(gameRect) &&
    blockers.every((rect) => !overlaps(candidate, rect));

  // Preferred: horizontally centered immediately above the card frame, then
  // frame-aligned variants, then nudged upward toward the game-rect top.
  const idealX = frame.x + (frame.width - size.width) / 2;
  const aboveXCandidates = [
    idealX,
    frame.x,
    frame.x + frame.width - size.width,
  ].map((x) => clamp(x, gameRect.x, right(gameRect) - size.width));
  const idealY = frame.y - size.height - BADGE_GAP;
  const aboveYCandidates = [
    idealY,
    ...avoidRects.map((rect) => rect.y - size.height - BADGE_GAP),
    gameRect.y,
  ];

  for (const rawY of aboveYCandidates) {
    const y = clamp(rawY, gameRect.y, bottom(gameRect) - size.height);
    // "Above" placements must keep the chip fully clear of the frame top.
    if (y + size.height + BADGE_GAP > frame.y) continue;
    for (const x of aboveXCandidates) {
      const candidate = { x, y, width: size.width, height: size.height };
      if (fits(candidate)) {
        return {
          left: `${Math.round(x)}px`,
          top: `${Math.round(y)}px`,
          rect: candidate,
          anchor: "above",
        };
      }
    }
  }

  // Insufficient room above: compact side anchor OUTSIDE the card frame.
  const sideYCandidates = [
    frame.y,
    frame.y + (frame.height - size.height) / 2,
  ];
  for (const rawY of sideYCandidates) {
    const y = clamp(rawY, gameRect.y, bottom(gameRect) - size.height);
    for (const x of [
      frame.x - size.width - BADGE_GAP, // left of the card
      right(frame) + BADGE_GAP, // right of the card
    ]) {
      const candidate = { x, y, width: size.width, height: size.height };
      if (fits(candidate)) {
        return {
          left: `${Math.round(x)}px`,
          top: `${Math.round(y)}px`,
          rect: candidate,
          anchor: "side",
        };
      }
    }
  }

  // Do not render a badge if the layout cannot provide a safe position. A
  // missing recommendation is safer than covering the card or a game control.
  return null;
}
