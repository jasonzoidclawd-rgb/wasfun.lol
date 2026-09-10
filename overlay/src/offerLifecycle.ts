/**
 * Latched augment-offer lifecycle.
 *
 * Once an augment screen is visible its identity is LATCHED per slot by a
 * normalized OCR-title fingerprint. Champion level is never a continuing
 * validity gate: an already-visible offer stays latched across level changes.
 * The offer clears only on explicit evidence:
 *   - the VALIDATED selection surface disappears for SCREEN_ABSENCE_CLEAR_PASSES
 *     scans (absence = a scan in which no slot shows a validated identity),
 *   - the caller confirms a pick / a queued offer replaces the current one,
 *   - the caller resets on focus loss or a gameflow boundary.
 *
 * Validation separates a REAL card surface from OCR noise: a scan only counts
 * as "surface present" when at least one visible slot resolves to a known
 * augment identity (`validate`). Random text read off normal gameplay or an
 * occluding screen (scoreboard, death recap) never latches an offer, never
 * keeps one alive, and never renders placeholder chips — `surfaceVisible`
 * drops on the FIRST scan without validated evidence while the internal latch
 * is retained briefly for occlusion recovery.
 *
 * Reroll semantics: a slot whose title changes (or vanishes while the other
 * slots remain visible) is invalidated IMMEDIATELY and re-resolved — its old
 * identity is never retained; untouched slots keep their resolved state only
 * while their fingerprint still matches. Every transition returns a complete
 * next state, so a publish can never mix two offer generations.
 *
 * Chained rounds (Mayhem delivers queued R2→R3→R4 back-to-back during one
 * death sequence): when one scan swaps two or more validated slots to NEW
 * validated identities, the previous offer was completed and a queued offer
 * took its place — reported as `replacedOffer` so the caller can count the
 * completed round. A single-slot change is a reroll, never a replacement.
 */

export interface OfferSlot<R> {
  regionIndex: number;
  /** Normalized OCR title; null while the slot has no readable card title. */
  fingerprint: string | null;
  /** Raw OCR title backing the fingerprint. */
  title: string | null;
  /** Caller-supplied identity/stat resolution; null while scanning. */
  resolution: R | null;
  /** True when `validate` accepted this slot's resolution (known identity). */
  validated: boolean;
}

export interface OfferState<R> {
  /** Bumps whenever any slot's fingerprint changes — one generation per offer surface. */
  generation: number;
  /** True once a validated card surface has been seen since the last reset. */
  latched: boolean;
  /** Consecutive scans without any validated slot on screen (latched only). */
  screenEmptyPasses: number;
  /**
   * True when the MOST RECENT scan saw a validated card surface. Rendering
   * must gate on this: a latched offer whose surface is currently absent or
   * occluded is internal state, never pixels.
   */
  surfaceVisible: boolean;
  slots: OfferSlot<R>[];
}

/** Full-screen absence tolerated for one scan; the second clears the offer. */
export const SCREEN_ABSENCE_CLEAR_PASSES = 2;

export const OFFER_REGION_COUNT = 3;

export function emptyOfferState<R>(generation = 0): OfferState<R> {
  return {
    generation,
    latched: false,
    screenEmptyPasses: 0,
    surfaceVisible: false,
    slots: Array.from({ length: OFFER_REGION_COUNT }, (_, regionIndex) => ({
      regionIndex,
      fingerprint: null,
      title: null,
      resolution: null,
      validated: false,
    })),
  };
}

export interface ScanApplication<R> {
  state: OfferState<R>;
  /** True when this scan closed the offer (validated surface absent long enough). */
  cleared: boolean;
  /** Regions whose identity changed in this scan (reroll / new offer). */
  changedRegions: number[];
  /**
   * True when a queued offer replaced the previous one in place (≥2 slots
   * swapped to new VALIDATED identities in a single scan while a validated
   * offer was latched). The previous round was completed by a pick.
   */
  replacedOffer: boolean;
}

/**
 * Apply one OCR scan to the offer. `titles[i]` is the raw OCR title for region
 * i, or null when that region had no readable text. `resolve` runs ONLY for a
 * region whose fingerprint changed — stable slots keep their prior resolution
 * without re-resolving. `validate` decides whether a resolution identifies a
 * known augment; a scan with zero validated slots is surface-absence evidence
 * even when it contains readable (noise) text.
 */
export function applyScanToOffer<R>(
  state: OfferState<R>,
  titles: Array<string | null>,
  normalize: (title: string) => string,
  resolve: (title: string, regionIndex: number) => R,
  validate: (resolution: R) => boolean,
): ScanApplication<R> {
  const fingerprints = state.slots.map((slot, regionIndex) => {
    const title = titles[regionIndex] ?? null;
    const normalized = title ? normalize(title) : "";
    return { title, fingerprint: normalized.length > 0 ? normalized : null };
  });

  // Resolve only regions whose fingerprint changed; stable slots keep their
  // stored resolution AND its validity.
  const changedRegions: number[] = [];
  let replacedValidatedSlots = 0;
  const nextSlots = state.slots.map((slot, regionIndex) => {
    const { title, fingerprint } = fingerprints[regionIndex];
    if (fingerprint === slot.fingerprint) {
      return slot;
    }
    changedRegions.push(regionIndex);
    if (fingerprint === null) {
      // Some slots may be visible while this one is not: a reroll in flight.
      // Invalidate the slot's identity immediately — never keep stale data.
      return {
        regionIndex,
        fingerprint: null,
        title: null,
        resolution: null,
        validated: false,
      };
    }
    const resolution = resolve(title as string, regionIndex);
    const validated = validate(resolution);
    if (validated) replacedValidatedSlots += 1;
    return { regionIndex, fingerprint, title, resolution, validated };
  });

  const validatedVisible = nextSlots.filter(
    (slot) => slot.fingerprint !== null && slot.validated,
  ).length;

  if (validatedVisible === 0) {
    if (!state.latched) {
      // Nothing validated has ever been on screen: noise or emptiness before
      // an offer is inert — never latch, never render, never clear anything.
      return { state, cleared: false, changedRegions: [], replacedOffer: false };
    }
    const screenEmptyPasses = state.screenEmptyPasses + 1;
    if (screenEmptyPasses >= SCREEN_ABSENCE_CLEAR_PASSES) {
      return {
        state: emptyOfferState(state.generation + 1),
        cleared: true,
        changedRegions: state.slots
          .filter((slot) => slot.fingerprint !== null)
          .map((slot) => slot.regionIndex),
        replacedOffer: false,
      };
    }
    // One scan without validated evidence is a transient gap (tooltip,
    // scoreboard, animation frame) — hide the surface IMMEDIATELY but retain
    // the latched identities untouched so the same offer can restore when its
    // fingerprints reappear. Noise text is never written into the slots.
    return {
      state: { ...state, screenEmptyPasses, surfaceVisible: false },
      cleared: false,
      changedRegions: [],
      replacedOffer: false,
    };
  }

  const hadValidatedOffer =
    state.latched && state.slots.some((slot) => slot.validated);

  return {
    state: {
      generation:
        changedRegions.length > 0 ? state.generation + 1 : state.generation,
      latched: true,
      screenEmptyPasses: 0,
      surfaceVisible: true,
      slots: nextSlots,
    },
    cleared: false,
    changedRegions,
    // ≥2 slots swapping to new validated identities in ONE scan is a queued
    // offer replacing a completed one; a single-slot change is a reroll.
    replacedOffer: hadValidatedOffer && replacedValidatedSlots >= 2,
  };
}

/** True while a latched offer surface has at least one identified slot. */
export function offerActive<R>(state: OfferState<R>): boolean {
  return state.latched && state.slots.some((slot) => slot.fingerprint !== null);
}
