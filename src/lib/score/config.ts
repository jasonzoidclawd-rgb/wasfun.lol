/**
 * Engine switches whose values were decided by data, not taste. Each one names
 * the evidence that set it; change it only with new evidence of the same kind.
 */

/**
 * Carry-over (The math, section 3) is OFF. Its real-data backtest failed: on
 * the provider's own champion history (344 champion-patches, 26.15–26.19), the
 * first snapshot of a patch predicted the end-of-patch win rate with an RMSE of
 * 0.153 pp; carrying last patch forward with the spec's 0.5 pp drift gave 0.193
 * (worse), and larger drift only converges back to the raw value. Champions
 * moved 1.3 pp between patches, far more than the assumed drift. Re-run
 * `carryOverBacktest` on augment snapshots once they cover a full patch.
 */
export const CARRY_OVER_ENABLED = false;

/**
 * The provider publishes no champion-specific augment outcome, so the spread τ
 * of champion-specific effects cannot be measured (phase 0). Decisions for one
 * champion (the Pick verdict, close calls, reroll odds) add τ² to each card's
 * variance so they never claim more certainty about that champion than the
 * data holds. 2.0 pp keeps the calibration promise (verdicts without a close
 * call hold ≥ 80% per certainty bin) up to a true spread of 2.0 pp, where the
 * spec's typical 1.2 pp would break it. Revisit when the spread is measured.
 */
export const TAU_ASSUMED = 2.0; // pp

/**
 * The takers adjustment (section 2, gₐ) is ON. It needs how often each
 * champion takes each augment: the champions' appearance rates are their own
 * (0 of 3,114 equal the global pick rate; every augment listed on five or more
 * champions varies across them), unlike their augment win rates. Unlisted
 * shares are bounded and mass-constrained, and the adjustment's spread
 * between plausible shares is added to each augment's variance (engine.ts).
 */
export const TAKERS_ADJUSTMENT = true;

/**
 * The envelope of an unlisted augment's share for a champion, as fractions of
 * the champion's least-picked listed augment of that rarity. That bound
 * assumes the source lists each champion's six most-picked augments, which is
 * unverified (48 of 519 lists are not in descending pick-rate order), so the
 * envelope runs from 0 to the mass cap alone: the high end is never binding
 * below the cap. Letters take the most conservative grade across it.
 */
export const UNLISTED_ENVELOPE: [number, number] = [0, 1e6];

/** Variance multiplier for the close-call test until calibration says otherwise (see the calibration test). */
export const VERDICT_INFLATE = 1.0;

/**
 * Unit guard (The math, section 2): the unlisted-pair subtraction runs only
 * when the feed's units are confirmed AND every augment's listed share is at
 * most its global share. Over-subtracting is the dangerous error.
 */
export function unlistedSubtractionAllowed(opts: {
  unitsConfirmed: boolean;
  listedShare: Record<string, number>;
  globalShare: Record<string, number>;
}): boolean {
  if (!opts.unitsConfirmed) return false;
  return Object.entries(opts.listedShare).every(([id, share]) => share <= (opts.globalShare[id] ?? -Infinity));
}
