import type { PhysicalRect } from "./calibration";
import { OFFER_REGION_COUNT } from "./offerLifecycle";
import {
  LATCHED_SURFACE_MIN_VALIDATED,
  NEW_SURFACE_MIN_VALIDATED,
  validateOfferSurface,
} from "./visibleOfferFrame";

/**
 * Stage 1 of the two-stage offer pipeline: SURFACE PRESENCE.
 *
 * Presence answers "is a three-card augment surface on screen right now?" and
 * is deliberately INDEPENDENT of Stage 2 (canonical Riot/ARAMGG identity).
 * Presence must never require a known augment: a real offer whose names are not
 * in the catalog is still an offer, and combat text that happens to resolve to
 * a catalog entry is still not one. This module's only inputs are the current
 * capture's crop geometry and OCR title-quality — never a catalog match.
 *
 * Today the presence signal is OCR title-presence (the only signal that exists;
 * there is no pixel card-frame detector yet). The {@link SurfacePresenceProvider}
 * seam lets a future Rust geometry detector replace that signal without touching
 * the scheduler, watchdog, visible-frame freshness, or stale-result guards.
 */

/** Basic OCR title-quality bounds — a compact card-name string, not combat noise. */
export const TITLE_MIN_LENGTH = 2;
export const TITLE_MAX_LENGTH = 16;

/**
 * A normalized OCR title passes the basic quality check when it is a compact
 * string (card names normalize to 2–16 chars after whitespace/punctuation is
 * stripped) and is not a bare number (combat damage/timers OCR as digits).
 * Catalog membership is intentionally NOT consulted here.
 */
export function isPlausibleTitle(normalized: string): boolean {
  const text = normalized.trim();
  if (text.length < TITLE_MIN_LENGTH || text.length > TITLE_MAX_LENGTH) return false;
  if (/^\d+$/.test(text)) return false;
  return true;
}

/** Count of regions whose fresh OCR text passes the basic title-quality check. */
export function plausibleTitleCount(
  titles: Array<string | null>,
  normalize: (title: string) => string,
): number {
  return titles.filter((title) => title != null && isPlausibleTitle(normalize(title))).length;
}

/** One probe's result — the Stage-1 observation the scheduler publishes from. */
export interface SurfaceObservation {
  /** Monotonic probe sequence claimed at probe START (stale-result guard). */
  probeSeq: number;
  /** Monotonic clock (performance.now()) at capture — drives the freshness TTL. */
  capturedAt: number;
  present: boolean;
  /** 0..1 — fraction of regions carrying a plausible title this capture. */
  confidence: number;
  cropsCaptured: number;
  plausibleTitles: number;
  /** Per-region fresh card rect from THIS capture, or null (no crop). */
  cardRects: Array<PhysicalRect | null>;
  rejectionReasons: string[];
}

export interface SurfacePresenceInput {
  cropsCaptured: number;
  plausibleTitles: number;
  /** The most recently published frame showed a present surface. */
  previouslyPresent: boolean;
}

export interface SurfacePresenceVerdict {
  present: boolean;
  confidence: number;
  rejectionReasons: string[];
}

/**
 * Decide surface presence from title-quality evidence alone. A NEW surface needs
 * all three crops plus ≥2 plausible titles so a single stray name over combat
 * cannot latch; an already-present surface stays through a one-card reroll on ≥1.
 * Threshold logic is shared with {@link validateOfferSurface} so presence and the
 * frame validator can never drift apart.
 */
export function evaluateSurfacePresence(input: SurfacePresenceInput): SurfacePresenceVerdict {
  const verdict = validateOfferSurface({
    cropsCaptured: input.cropsCaptured,
    validatedSlots: input.plausibleTitles,
    latched: input.previouslyPresent,
  });
  return {
    present: verdict.validated,
    confidence: verdict.validated
      ? Math.min(1, input.plausibleTitles / OFFER_REGION_COUNT)
      : 0,
    rejectionReasons: verdict.validated ? [] : [verdict.reason],
  };
}

/** Minimum plausible titles to newly assert / to keep a present surface. */
export const PRESENCE_MIN_NEW = NEW_SURFACE_MIN_VALIDATED;
export const PRESENCE_MIN_LATCHED = LATCHED_SURFACE_MIN_VALIDATED;

/**
 * The narrow provider contract a presence source implements. The current source
 * derives presence from OCR title-presence (see App.tsx `runSurfaceProbe`); a
 * future Rust pixel/geometry provider would return present + cardRects WITHOUT
 * OCR and let Stage 2 run identity separately. Swapping the provider must not
 * change the scheduler, watchdog, freshness TTL, or stale-result contracts.
 */
export interface SurfacePresenceProvider {
  probe(probeSeq: number, capturedAt: number): Promise<SurfaceObservation>;
}
