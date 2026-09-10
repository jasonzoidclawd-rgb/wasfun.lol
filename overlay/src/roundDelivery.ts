/**
 * Mayhem augment-round DELIVERY model.
 *
 * Reaching a level threshold (3 / 7 / 11 / 15) only makes a round ELIGIBLE.
 * R1 is delivered at the initial level-3 timing; R2/R3/R4 are delivered when
 * the champion DIES after crossing the relevant threshold, and multiple
 * pending rounds can be delivered consecutively during one death sequence
 * (pick R2 → R3 appears immediately → pick → R4 → pick).
 *
 * Crossing a threshold while alive therefore must not enter augment
 * selection, show placeholder chips, consume a round, or suppress the future
 * death-triggered offer. Completion is counted ONLY on strong evidence
 * (confirmed pick / a queued offer replacing the current one) — never from
 * level, a transient phase signal, one absent screenshot, death/respawn
 * state, or elapsed time.
 *
 * Scanning policy: telemetry may identify the EXPECTED round, but it must not
 * block scanning a clearly visible real offer. While rounds are pending the
 * overlay keeps an AMBIENT probe running (one scan per poll tick) even when
 * telemetry says the player is alive — so a real card surface latches even if
 * death/level telemetry is briefly stale — and switches to the FAST loop as
 * soon as an offer is latched, a death sequence starts, or the initial R1
 * window opens. `completedRounds` can only UNDERCOUNT (strong evidence may be
 * missed when picks happen by mouse without a queued replacement), which
 * keeps probing alive longer — never suppresses a real offer.
 */

export const AUGMENT_THRESHOLD_LEVELS = [3, 7, 11, 15] as const;

export const TOTAL_AUGMENT_ROUNDS = AUGMENT_THRESHOLD_LEVELS.length;

/** Rounds made eligible by crossed level thresholds (0–4). */
export function eligibleRoundCount(playerLevel: number): number {
  return AUGMENT_THRESHOLD_LEVELS.filter((level) => playerLevel >= level).length;
}

export type OfferScanMode = "fast" | "ambient" | "off";

export interface RoundDeliveryInput {
  playerLevel: number;
  /** Live Client telemetry: champion currently dead (death sequence). */
  isDead: boolean;
  /** Rounds completed on STRONG evidence only. */
  completedRounds: number;
  /** offerActive(offerState): a latched offer currently exists. */
  offerLatched: boolean;
}

export interface RoundDeliveryDecision {
  eligibleRounds: number;
  pendingRounds: number;
  /**
   * fast    — 20ms self-scheduling scan loop: an offer is currently latched,
   *           or a death sequence can deliver pending rounds right now.
   * ambient — one scan per poll tick: rounds pending (including the initial
   *           R1 window and stale-telemetry cases), so a real surface still
   *           latches promptly; the caller escalates to fast on latch.
   * off     — nothing pending and nothing latched.
   */
  scanMode: OfferScanMode;
  /** 1-based round an offer latching NOW would belong to (display/recording). */
  activeOfferRound: number;
}

export function resolveRoundDelivery(input: RoundDeliveryInput): RoundDeliveryDecision {
  const eligibleRounds = eligibleRoundCount(input.playerLevel);
  const completed = Math.max(0, Math.min(input.completedRounds, TOTAL_AUGMENT_ROUNDS));
  const pendingRounds = Math.max(0, eligibleRounds - completed);

  const deathSequenceActive = pendingRounds > 0 && input.isDead;

  const scanMode: OfferScanMode =
    input.offerLatched || deathSequenceActive
      ? "fast"
      : pendingRounds > 0
        ? "ambient"
        : "off";

  return {
    eligibleRounds,
    pendingRounds,
    scanMode,
    activeOfferRound: Math.min(completed + 1, TOTAL_AUGMENT_ROUNDS),
  };
}
