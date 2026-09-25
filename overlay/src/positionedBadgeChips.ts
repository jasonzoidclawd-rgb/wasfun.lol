import {
  cssRectFromCalibratedRect,
  type CssSize,
  type OverlayCalibration,
  type PhysicalRect,
} from "./calibration";
import {
  cardFrameFromNameRect,
  overlayAvoidRectsCss,
  placeBadgeAboveCard,
} from "./badgeLayout";

/** The minimum a chip must expose to be positioned and keyed. */
export interface PlaceableChip {
  regionIndex: number;
  key: string;
}

/** A slot rect supplied by the CURRENT capture. No rect means no chip. */
export interface PlaceableSlot {
  regionIndex: number;
  cardRect: PhysicalRect | null;
}

/**
 * A chip that reached a real screen position: the chip, its region, its stable
 * slot key, and the CSS offsets the badge element is rendered at.
 */
export interface PositionedBadgeChip<Chip extends PlaceableChip> {
  chip: Chip;
  regionIndex: number;
  key: string;
  position: { left: string; top: string };
}

export interface PositionBadgeChipsInput<Chip extends PlaceableChip> {
  chips: readonly Chip[];
  calibration: OverlayCalibration | null;
  slots: readonly PlaceableSlot[] | null;
  cssWindow: CssSize;
}

/**
 * THE badge-placement authority: the single collection both the DOM render and
 * the `[badge-layer]` diagnostic consume.
 *
 * A chip that is not in this list has no `left`/`top` and is therefore not
 * painted, so counting `slotChips` instead would let the diagnostic claim
 * visible badges when calibration is unavailable, when the current capture
 * supplied no rect for that slot, or when `placeBadgeAboveCard` finds nowhere
 * to put the chip. Deriving both from this one collection is what keeps the
 * count equal to the number of badge elements on screen.
 */
export function positionBadgeChips<Chip extends PlaceableChip>({
  chips,
  calibration,
  slots,
  cssWindow,
}: PositionBadgeChipsInput<Chip>): PositionedBadgeChip<Chip>[] {
  if (!calibration || !slots) return [];

  // Chip geometry comes ONLY from the current frame's fresh per-slot rects.
  // A slot without a rect from THIS capture is never positioned — no
  // historical or calibrated fallback geometry can anchor a stale chip.
  const regionRects = new Map<number, PhysicalRect>();
  for (const slot of slots) {
    if (slot.cardRect) regionRects.set(slot.regionIndex, slot.cardRect);
  }

  // THE coordinate boundary: every calibrated rect converts to overlay-window
  // CSS exactly once, as a pure ratio against the overlay anchor. scaleFactor
  // never re-enters, so a flapping monitor scale or a detected-window↔monitor-
  // fallback switch cannot move the chips.
  const toCss = (rect: PhysicalRect) =>
    cssRectFromCalibratedRect(rect, calibration.overlayAnchor, cssWindow);
  const cssGameRect = toCss(calibration.viewport);
  const cssRegionRects = new Map(
    [...regionRects.entries()].map(([regionIndex, rect]) => [regionIndex, toCss(rect)]),
  );
  const avoidRects = overlayAvoidRectsCss(cssWindow, cssGameRect);

  const positioned: PositionedBadgeChip<Chip>[] = [];
  for (const chip of chips) {
    const cardRect = cssRegionRects.get(chip.regionIndex);
    if (!cardRect) continue;
    // A chip must never cover a NEIGHBORING card either — the other card
    // frames are additional keep-out rects.
    const otherFrames = [...cssRegionRects.entries()]
      .filter(([regionIndex]) => regionIndex !== chip.regionIndex)
      .map(([, rect]) => cardFrameFromNameRect(rect, cssGameRect));
    const placement = placeBadgeAboveCard({
      cardRect,
      gameRect: cssGameRect,
      avoidRects: [...avoidRects, ...otherFrames],
    });
    if (!placement) continue;
    positioned.push({
      chip,
      regionIndex: chip.regionIndex,
      key: chip.key,
      position: { left: placement.left, top: placement.top },
    });
  }
  return positioned;
}
