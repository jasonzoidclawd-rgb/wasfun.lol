/**
 * PHASE B — atomic per-slot reroll invalidation.
 *
 * When a single slot is rerolled, only that card's fingerprint changes. The
 * geometry probe that first observes the change must, in one step:
 *   - increment ONLY that slot's generation;
 *   - invalidate ONLY its identity + statistic (store entry → null → SCANNING);
 *   - retain the unchanged neighbours (by reference);
 *   - guarantee any in-flight OCR run stamped with the old slot generation is
 *     rejected on completion.
 *
 * This closes the window that produced the stale 牙仙 chip over the new 不可通行
 * card: previously the identity store was only *masked* by the live fingerprint,
 * so an OCR run triggered by the reroll but reading stale pixels (or resolving
 * during the card-flip's transitional hash) could re-publish the old augment on
 * the new card. Clearing the store atomically the instant a changed fingerprint
 * is observed leaves no old identity to resolve, and the slot-generation stamp
 * rejects any OCR whose slot rerolled again mid-read.
 *
 * Pure — no timers, IPC or React — so left/middle/right reroll ordering is
 * unit-tested deterministically. Fingerprint comparison reuses the geometry
 * average-hash Hamming band, so sub-threshold sparkle drift is the same card.
 */
import { fingerprintChanged, type GeometryObservation, type IdentityRecord } from "./surfaceGeometry";

/** Per-slot sustained-confirmation state, threaded across geometry probes. */
export interface SlotRerollPending {
  /** Candidate replacement fingerprint under confirmation ("" = none pending). */
  candidate: string;
  /** Consecutive probes this candidate has persisted past the Hamming band. */
  count: number;
}

/**
 * Consecutive probes a distinct replacement fingerprint must persist before a
 * resolved slot is treated as rerolled. ~450 ms at the 150 ms geometry cadence —
 * long enough to reject hover glow and card-art animation drift, short enough
 * that a genuine reroll settles almost immediately (accepted ~300–450 ms
 * old-tier hold before the new card re-scans).
 */
export const REROLL_CONFIRM_PROBES = 3;

export function createRerollPending(slots = 3): SlotRerollPending[] {
  return Array.from({ length: slots }, () => ({ candidate: "", count: 0 }));
}

/**
 * SUSTAINED FINGERPRINT CONFIRMATION (hysteresis) — the gate that feeds Phase B.
 *
 * A resolved slot's fingerprint drifting past the Hamming band is HOVER / CARD
 * ANIMATION noise, not a reroll, until a single DISTINCT replacement fingerprint
 * persists `confirmProbes` consecutive probes. This eliminated the churn where
 * ~30% of stable-offer probes invalidated a slot (clearing identity, bumping the
 * slot generation, and cancelling in-flight OCR) — starving OCR so badges sat at
 * SCANNING and flickered on hover.
 *
 *  - `confirmed`: slots whose replacement just reached the threshold → invalidate
 *    exactly once this probe.
 *  - `held`: slots drifting from the accepted fingerprint but not yet confirmed →
 *    keep their resolved tier (no SCANNING, no generation bump, no OCR cancel).
 *
 * The accepted (published) fingerprint is the STABLE baseline the caller holds
 * for a slot; it must not chase the drift, or animation would keep re-arming the
 * streak. Pure — pending state is threaded by the caller.
 */
export function advanceRerollConfirmation(params: {
  pending: SlotRerollPending[];
  acceptedFingerprints: string[];
  observation: GeometryObservation;
  confirmProbes?: number;
}): { pending: SlotRerollPending[]; confirmed: number[]; held: number[] } {
  const confirmProbes = params.confirmProbes ?? REROLL_CONFIRM_PROBES;
  const pending = params.pending.map((slot) => ({ ...slot }));
  const confirmed: number[] = [];
  const held: number[] = [];
  for (const card of params.observation.cards) {
    const i = card.regionIndex;
    if (!card.present) {
      pending[i] = { candidate: "", count: 0 };
      continue;
    }
    const accepted = params.acceptedFingerprints[i] ?? "";
    // Within the band of the accepted fingerprint → still the same card. Any
    // in-flight candidate was hover/animation noise that returned home; reset.
    if (!fingerprintChanged(accepted, card.fingerprint)) {
      pending[i] = { candidate: "", count: 0 };
      continue;
    }
    const prior = pending[i];
    const sameCandidate = prior.count > 0 && !fingerprintChanged(prior.candidate, card.fingerprint);
    const candidate = sameCandidate ? prior.candidate : card.fingerprint;
    const count = sameCandidate ? prior.count + 1 : 1;
    if (count >= confirmProbes) {
      confirmed.push(i);
      pending[i] = { candidate: "", count: 0 };
    } else {
      held.push(i);
      pending[i] = { candidate, count };
    }
  }
  return { pending, confirmed, held };
}

// ─── Provisional baseline settlement (offer appearance) ───

/**
 * Consecutive EQUIVALENT observations a fresh offer's cards must hold before
 * their fingerprints become the accepted reroll baseline.
 */
export const BASELINE_STABLE_OBSERVATIONS = 2;
/**
 * Wall-clock floor for the same decision. Both floors must be met, so the
 * outcome does not depend on probe cadence — the level-3 defect was a pure
 * frame count that closed in ~450 ms at high throughput and ~2 s once the
 * native-outstanding cap slowed geometry to ~650 ms/frame.
 */
export const BASELINE_STABLE_MS = 300;

/** Provisional per-slot baseline held while a freshly appeared offer animates in. */
export interface BaselineSettlement {
  /** Candidate baseline; entry-animation drift moves ONLY this. */
  provisional: string[];
  /** Consecutive observations equivalent to `provisional` (within the band). */
  stableCount: number;
  /** Monotonic clock when the current candidate was first observed. */
  since: number;
  /** True once `provisional` may be adopted as the accepted reroll baseline. */
  latched: boolean;
}

/**
 * Begin settling a freshly appeared offer. NEVER latched on the first frame:
 * that frame is mid-animation, and adopting it as the baseline is exactly what
 * let the cards' entry animation confirm itself as a three-slot reroll and wipe
 * badges that had already published.
 *
 * A new offer always starts from a fresh settlement — it never inherits the
 * previous offer's provisional baseline.
 */
export function beginBaselineSettlement(
  observation: GeometryObservation,
  now: number,
): BaselineSettlement {
  return {
    provisional: observation.cards.map((card) => card.fingerprint),
    stableCount: 1,
    since: now,
    latched: false,
  };
}

/**
 * Advance settlement with one geometry observation.
 *
 * Any present slot drifting past the Hamming band is still animating: the
 * candidate is REPLACED and both floors restart. Sub-band sparkle is equivalent,
 * and the baseline keeps the FIRST equivalent fingerprint rather than chasing
 * the glow. An absent card suspends settlement — a partial offer must not latch.
 *
 * LATCHING IS TERMINAL FOR THE OFFER. Settling answers one question — "has the
 * entry animation finished?" — and that question cannot become unanswered while
 * the same offer is on screen. Re-opening it was the single knot behind the
 * 2026-07-27 hover regressions, because `drifted` is computed over ALL THREE
 * cards: one slot oscillating between two poles ~1-2 s apart unlatched the whole
 * offer, and the caller treats "settling" as a reason to skip
 * `advanceRerollConfirmation` and wipe both the pending streak and the held set.
 * With `REROLL_CONFIRM_PROBES = 3` needing three consecutive probes, no streak
 * ever survived: in that trace the confirmed-reroll authority fired ZERO times
 * across the whole offer — including for the two GENUINE card replacements
 * (slot 1 augment 2018 -> 1051 at Hamming 22, slot 2 1170 -> 2016 at Hamming 30).
 * Each unlatch also re-latched onto whichever pole happened to be quiet, so the
 * accepted baseline itself kept moving.
 *
 * Ending settlement per offer is what makes slot generation safe as the sole
 * identity authority: a real replacement now accumulates its three probes and
 * bumps the generation, while pure A/B oscillation still never confirms (the
 * candidate flips every frame, so `sameCandidate` fails and the count resets).
 * A genuinely new offer calls `beginBaselineSettlement` and settles again.
 */
export function advanceBaselineSettlement(params: {
  settlement: BaselineSettlement;
  observation: GeometryObservation;
  now: number;
  minObservations?: number;
  minStableMs?: number;
}): BaselineSettlement {
  const minObservations = params.minObservations ?? BASELINE_STABLE_OBSERVATIONS;
  const minStableMs = params.minStableMs ?? BASELINE_STABLE_MS;
  const { settlement, observation, now } = params;
  if (settlement.latched) return settlement;
  const present = observation.cards.filter((card) => card.present);
  if (present.length < observation.cards.length) {
    // Incomplete surface: hold the candidate, do not advance either floor.
    return { ...settlement, latched: false };
  }
  const drifted = observation.cards.some((card) =>
    fingerprintChanged(settlement.provisional[card.regionIndex] ?? "", card.fingerprint));
  if (drifted) {
    return {
      provisional: observation.cards.map((card) => card.fingerprint),
      stableCount: 1,
      since: now,
      latched: false,
    };
  }
  const stableCount = settlement.stableCount + 1;
  return {
    provisional: settlement.provisional,
    stableCount,
    since: settlement.since,
    latched: stableCount >= minObservations && now - settlement.since >= minStableMs,
  };
}

export interface RerollInvalidationResult<R> {
  /** New identity store; changed slots set to null, neighbours retained by ref. */
  store: Array<IdentityRecord<R> | null>;
  /** New per-slot generations; only invalidated slots incremented. */
  slotGenerations: number[];
  /** Region indices whose fingerprint changed this observation. */
  invalidated: number[];
  /** Last accepted per-slot fingerprints, independent of OCR completion. */
  acceptedFingerprints: string[];
}

/**
 * Given the current identity store, per-slot generations and a completed
 * geometry observation, invalidate exactly the slots whose present card's
 * fingerprint moved past the Hamming band. An absent card is not a reroll
 * (absence is handled by the geometry presence hysteresis), and a record that
 * is already empty has no identity to invalidate.
 */
export function applyRerollInvalidation<R>(params: {
  store: Array<IdentityRecord<R> | null>;
  acceptedFingerprints?: string[];
  slotGenerations: number[];
  observation: GeometryObservation;
  championGeneration: number;
  now: number;
  /** A genuinely new offer owns fresh slot generations even if pixels repeat. */
  newOffer?: boolean;
  /**
   * When present, invalidate EXACTLY these present slots — the confirmed reroll
   * set from `advanceRerollConfirmation` — instead of deriving the set from a
   * raw per-frame fingerprint change. Retained (held) slots then keep their
   * accepted baseline unchanged, so an unconfirmed drifting slot keeps measuring
   * drift from its resolved fingerprint rather than chasing the animation.
   */
  invalidateSlots?: number[];
}): RerollInvalidationResult<R> {
  const { store, slotGenerations, observation } = params;
  const nextStore = store.slice();
  const nextGenerations = slotGenerations.slice();
  const previousFingerprints = params.acceptedFingerprints ?? store.map((record) => record?.fingerprint ?? "");
  const nextFingerprints = previousFingerprints.slice();
  const confirmed = params.invalidateSlots != null ? new Set(params.invalidateSlots) : null;
  const invalidated: number[] = [];

  for (const card of observation.cards) {
    const i = card.regionIndex;
    if (!card.present) continue;
    const changed = confirmed != null
      ? confirmed.has(i)
      : params.newOffer === true || fingerprintChanged(previousFingerprints[i] ?? "", card.fingerprint);
    if (changed) {
      nextStore[i] = null;
      nextGenerations[i] = slotGenerations[i] + 1;
      invalidated.push(i);
      nextFingerprints[i] = card.fingerprint; // adopt the new card as the baseline
    } else if (confirmed != null) {
      // Hysteresis mode: hold the accepted baseline for a retained/held slot so
      // the confirmation streak keeps measuring from the resolved fingerprint.
      nextFingerprints[i] = previousFingerprints[i] ?? "";
    } else {
      nextFingerprints[i] = card.fingerprint; // legacy: baseline tracks the frame
    }
  }

  return {
    store: nextStore,
    slotGenerations: nextGenerations,
    invalidated,
    acceptedFingerprints: nextFingerprints,
  };
}

/**
 * True when an OCR run stamped with `triggerSlotGeneration` must be discarded
 * because its slot was rerolled again (advancing the current generation) before
 * the run completed.
 */
export function ocrRunSuperseded(triggerSlotGeneration: number, currentSlotGeneration: number): boolean {
  return triggerSlotGeneration !== currentSlotGeneration;
}
