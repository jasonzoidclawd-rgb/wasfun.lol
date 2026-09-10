import type { PhysicalRect } from "./calibration";
import { OFFER_REGION_COUNT, type OfferState } from "./offerLifecycle";

/**
 * Visual/internal state separation for the augment offer.
 *
 * The overlay keeps TWO distinct things:
 *
 *   - InternalOfferLatch (`OfferState`, offerLifecycle.ts): last validated
 *     fingerprints, resolved identities, generation, and a short occlusion
 *     grace window. This is NON-VISUAL bookkeeping. It must NEVER directly
 *     render chips: a latched offer whose surface is currently absent is
 *     memory, not pixels.
 *
 *   - VisibleOfferFrame (this module): the ONLY thing rendered components may
 *     read. It carries the CURRENT capture's fresh evidence — a
 *     `surfaceValidated` flag proven by the current scan, per-slot card
 *     rectangles that belong to THIS capture, the offer generation the frame
 *     describes, and a monotonic `revision`/`captureSeq` for stale-result
 *     rejection.
 *
 * Every scan publishes either (A) a fresh validated frame with real geometry
 * and slot states, or (B) an explicit EMPTY frame. It must never leave the
 * previous visible frame untouched after a completed scan, so a stale surface
 * can never linger over normal gameplay, respawn, the scoreboard, or a new
 * map. The 01:32 / 01:48 / 00:25 retest failures were exactly that: rendering
 * was driven by the internal latch, whose invalidation depended on the scan
 * loop continuing to run — and telemetry-gated scanning stopped, freezing the
 * last frame.
 */
export interface VisibleSlot<R> {
  regionIndex: number;
  /**
   * Card name-band rectangle from THIS capture (calibrated logical space,
   * same space as `OverlayCalibration.viewport`). Null when the current scan
   * produced no successful crop for this region — such a slot is never
   * rendered, so no historical/calibrated geometry can back a chip.
   */
  cardRect: PhysicalRect | null;
  fingerprint: string | null;
  resolution: R | null;
  unresolvedState?: "scanning" | "unmatched" | "ocr-error";
}

export interface VisibleOfferFrame<R> {
  /** Monotonic, bumped on every publish (fresh or empty). Render/debug only. */
  revision: number;
  /** Probe sequence that produced this frame; the supersede guard uses it. */
  captureSeq: number;
  /** Monotonic clock (performance.now()) at capture — diagnostic provenance. */
  capturedAt: number;
  /** True ONLY when this capture independently validated a real offer surface. */
  surfaceValidated: boolean;
  /** Internal-latch generation this frame describes. */
  generation: number;
  slots: VisibleSlot<R>[];
}

export function emptyVisibleFrame<R>(
  revision: number,
  captureSeq: number,
  generation: number,
  capturedAt = 0,
): VisibleOfferFrame<R> {
  return { revision, captureSeq, capturedAt, surfaceValidated: false, generation, slots: [] };
}

/**
 * Multi-signal validation that the CURRENT capture shows a real three-card
 * offer surface — not OCR-title success alone. Combat/respawn/scoreboard UI
 * must never be classified as three slots merely because historical card
 * coordinates exist or one stray region happened to match a name.
 *
 * Signals combined:
 *   - structural: all three name-band crops were captured this scan
 *     (`cropsCaptured === OFFER_REGION_COUNT`);
 *   - identity corroboration: enough slots resolved to a KNOWN augment that
 *     arbitrary UI cannot masquerade as an offer. Latching a NEW surface needs
 *     ≥2 known identities; an already-latched offer stays visible through a
 *     single-slot reroll on ≥1.
 */
export const NEW_SURFACE_MIN_VALIDATED = 2;
export const LATCHED_SURFACE_MIN_VALIDATED = 1;

export interface SurfaceValidationInput {
  cropsCaptured: number;
  validatedSlots: number;
  /** An offer was already internally latched BEFORE this scan. */
  latched: boolean;
}

export interface SurfaceValidation {
  validated: boolean;
  /** Dev diagnostic: why an offer surface was or wasn't accepted this scan. */
  reason:
    | "validated-new-surface"
    | "validated-latched-reroll"
    | "insufficient-crops"
    | "insufficient-identity";
}

export function validateOfferSurface(input: SurfaceValidationInput): SurfaceValidation {
  if (input.cropsCaptured < OFFER_REGION_COUNT) {
    return { validated: false, reason: "insufficient-crops" };
  }
  const required = input.latched
    ? LATCHED_SURFACE_MIN_VALIDATED
    : NEW_SURFACE_MIN_VALIDATED;
  if (input.validatedSlots < required) {
    return { validated: false, reason: "insufficient-identity" };
  }
  return {
    validated: true,
    reason: input.latched ? "validated-latched-reroll" : "validated-new-surface",
  };
}

/**
 * Build the visible frame for one scan from the post-scan internal latch, the
 * fresh per-region rects, and the surface-validation verdict. When the surface
 * is not validated the frame is EMPTY (no slots) regardless of what the
 * internal latch still remembers.
 */
export function buildVisibleFrame<R>(params: {
  revision: number;
  captureSeq: number;
  capturedAt: number;
  offerState: OfferState<R>;
  /** Per region: the fresh card rect from this capture, or null (no crop). */
  freshRects: Array<PhysicalRect | null>;
  surfaceValidated: boolean;
}): VisibleOfferFrame<R> {
  const { revision, captureSeq, capturedAt, offerState, freshRects, surfaceValidated } = params;
  if (!surfaceValidated) {
    return emptyVisibleFrame(revision, captureSeq, offerState.generation, capturedAt);
  }
  return {
    revision,
    captureSeq,
    capturedAt,
    surfaceValidated: true,
    generation: offerState.generation,
    slots: offerState.slots.map((slot) => ({
      regionIndex: slot.regionIndex,
      cardRect: freshRects[slot.regionIndex] ?? null,
      fingerprint: slot.fingerprint,
      resolution: slot.resolution,
      unresolvedState: slot.resolution === null ? "scanning" : undefined,
    })),
  };
}

/**
 * Stale-result rejection. A scan captures its `captureSeq` at START; the newest
 * started scan (and every synchronous clear) advances `latestSeq`. A result may
 * publish only if its own seq is still the latest — a delayed OCR result from an
 * older scan can never restore an already-superseded frame.
 */
export function frameResultIsCurrent(resultSeq: number, latestSeq: number): boolean {
  return resultSeq === latestSeq;
}

/** Structural render gate: a validated frame while the game is in front. */
export function visibleFrameRenderable<R>(
  frame: VisibleOfferFrame<R> | null,
  gameWindowForeground: boolean,
): boolean {
  return gameWindowForeground && frame != null && frame.surfaceValidated;
}

/** A slot is renderable only when it carries a current card rect from its capture. */
export function slotHasCurrentRect<R>(slot: VisibleSlot<R>): boolean {
  return slot.cardRect !== null;
}

export const VISIBLE_FRAME_REGION_COUNT = OFFER_REGION_COUNT;
