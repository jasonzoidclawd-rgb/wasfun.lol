/**
 * FIX 2 — one authoritative publication snapshot for diagnostics.
 *
 * Rendering is driven by the accepted geometry `VisibleOfferFrame` + per-slot
 * identity store. The development banner and the native [offer-state] /
 * [slot-publication] events MUST describe that same accepted snapshot — never a
 * mix of stale raw OCR probe counts and the internal offer latch, which is what
 * produced the 00:14:35 contradiction (resolved badges on screen while the
 * banner read "No latched offer — captured 0/3 · Riot IDs 0/3").
 *
 * This module derives the snapshot from the render-authoritative inputs only,
 * and exposes the invariant a test can assert: a resolved badge can never
 * coexist with "no visible offer".
 */

/** One rendered slot, as the authoritative frame describes it. */
export interface AuthoritativeSlot {
  /** The slot carries a card rect from the current accepted frame. */
  hasRect: boolean;
  /** The slot renders a resolved tier badge. */
  resolved: boolean;
  /** The slot renders a SCANNING placeholder. */
  scanning: boolean;
}

export interface AuthoritativeSnapshot {
  /** The authoritative frame is being rendered as a visible offer. */
  offerVisible: boolean;
  /** Slots carrying a card rect in the accepted frame. */
  visibleCards: number;
  /** Slots rendering a resolved tier badge. */
  resolvedBadges: number;
  /** Slots rendering a SCANNING placeholder. */
  scanningSlots: number;
  /** This frame is retained-uncertainty continuity, not a fresh publish. */
  retainedContinuity: boolean;
  offerGeneration: number;
  geometrySeq: number;
}

export function summarizeAuthoritativePublication(input: {
  /** The render gate result — is the authoritative frame actually on screen? */
  renderable: boolean;
  /** Per-slot render facts from the SAME frame rendering reads. */
  slots: AuthoritativeSlot[];
  offerGeneration: number;
  geometrySeq: number;
  retainedContinuity: boolean;
}): AuthoritativeSnapshot {
  // When the frame is not renderable it shows NOTHING; every count is zero, so a
  // resolved badge can never be attributed to a non-visible frame.
  const slots = input.renderable ? input.slots : [];
  return {
    offerVisible: input.renderable && slots.some((slot) => slot.hasRect),
    visibleCards: slots.filter((slot) => slot.hasRect).length,
    resolvedBadges: slots.filter((slot) => slot.resolved).length,
    scanningSlots: slots.filter((slot) => slot.scanning).length,
    retainedContinuity: input.retainedContinuity,
    offerGeneration: input.offerGeneration,
    geometrySeq: input.geometrySeq,
  };
}

/**
 * The FIX 2 invariant: a rendered resolved badge cannot coexist with a snapshot
 * that claims no visible offer. Retained-uncertainty continuity is the ONE
 * allowed case where prior badges render while the current probe is a preserved
 * negative — and there offerVisible is still true, so the invariant holds.
 */
export function publicationSnapshotConsistent(snapshot: AuthoritativeSnapshot): boolean {
  if (snapshot.resolvedBadges > 0 && !snapshot.offerVisible) return false;
  return true;
}
