/**
 * DEVELOPMENT-ONLY overlay fixture state machine.
 *
 * Cleanly separates the two independent dev flags and the four mutually
 * exclusive overlay states, so injected geometry can NEVER mask real OCR:
 *
 *   - MAYHEM_OVERLAY_TIER_FIXTURE=1   → ARAMGG stats over REAL OCR-detected
 *     cards. Never injects geometry, never forces focus/phase.
 *   - MAYHEM_OVERLAY_GEOMETRY_PREVIEW=1 → synthetic preview cards, allowed
 *     ONLY when League is entirely absent (idle + unfocused), always
 *     watermarked. Requires its own flag; TIER_FIXTURE alone never enables it.
 *
 * The resolver is pure so every reported failure sequence (blur/refocus,
 * transient OCR failure, changed offer, League-absent) is unit-testable.
 */

export type OverlayPhase = "idle" | "client_found" | "in_game" | "augment_selection";

export type OverlayFixtureMode =
  /** League focused, a latched real OCR offer, ARAMGG ready → per-slot badges. */
  | { kind: "real-offer" }
  /** League focused at an augment screen but no latched offer yet → diagnostic, no badges. */
  | { kind: "ocr-unavailable" }
  /** Explicit preview flag AND League absent → watermarked preview badges. */
  | { kind: "preview" }
  /** Everything else → no in-game overlay surfaces. */
  | { kind: "hidden" };

export interface FixtureModeInput {
  tierFixtureOn: boolean;
  previewOn: boolean;
  gameWindowForeground: boolean;
  phase: OverlayPhase;
  /**
   * offerActive(offerState) — a latched offer surface with ≥1 identified slot.
   * Slots render per-slot states (matched / NO DATA / UNMATCHED / SCANNING);
   * a slot never shows stale or invented data, so a partially-resolved offer
   * is safe to render.
   */
  offerActive: boolean;
  aramggReady: boolean;
}

/**
 * Decide what the overlay may render. Injected geometry (`preview`) is gated on
 * League being completely absent (`phase === "idle"` AND not focused) so it can
 * never appear while League is visible, focused, in an active game, or during a
 * transient OCR failure.
 */
export function resolveOverlayFixtureMode(input: FixtureModeInput): OverlayFixtureMode {
  // Preview is the ONLY geometry-injecting path and needs its own flag. It is
  // permitted only when League is entirely absent; a running/focused/in-game
  // League (any non-idle phase, or focus) suppresses it unconditionally.
  if (input.previewOn && !input.gameWindowForeground && input.phase === "idle") {
    return input.aramggReady ? { kind: "preview" } : { kind: "hidden" };
  }

  if (!input.tierFixtureOn) return { kind: "hidden" };

  // Tier-fixture only paints over a real, focused, latched OCR offer.
  if (input.gameWindowForeground && input.phase === "augment_selection") {
    if (input.offerActive && input.aramggReady) return { kind: "real-offer" };
    // Focused augment screen but no latched offer (or ARAMGG still loading):
    // show a diagnostic, never synthetic cards, never stale badges.
    return { kind: "ocr-unavailable" };
  }

  return { kind: "hidden" };
}

// ─── Enable predicates (separated from import.meta so they are unit-testable) ───

export function geometryPreviewEnabledFrom(input: {
  dev: boolean;
  flag: string | undefined;
}): boolean {
  return input.dev === true && input.flag === "1";
}

export function isGeometryPreviewEnabled(): boolean {
  // Cast supplies the shape so this typechecks under both the overlay tsconfig
  // and the repo-root Next tsconfig (which lacks Vite client types). Runtime
  // is unchanged — Vite statically injects these values.
  const env = (import.meta as unknown as {
    env: { DEV: boolean; MAYHEM_OVERLAY_GEOMETRY_PREVIEW?: string };
  }).env;
  return geometryPreviewEnabledFrom({
    dev: env.DEV,
    flag: env.MAYHEM_OVERLAY_GEOMETRY_PREVIEW,
  });
}
