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
 * data holds. 1.2 pp is the spec's simulated typical value; the sensitivity at
 * 0.6 and 2.5 pp is recorded with the phase 1 results.
 */
export const TAU_ASSUMED = 1.2; // pp

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
