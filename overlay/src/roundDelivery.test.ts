import { describe, expect, it } from "vitest";
import {
  eligibleRoundCount,
  resolveRoundDelivery,
  TOTAL_AUGMENT_ROUNDS,
} from "./roundDelivery";
import {
  applyScanToOffer,
  emptyOfferState,
  offerActive,
  type OfferState,
} from "./offerLifecycle";

const normalize = (title: string) => title.trim();
const validate = (resolution: string) => !resolution.includes("噪");
const resolve = (title: string) => `resolved:${title}`;

function scan(state: OfferState<string>, titles: Array<string | null>) {
  return applyScanToOffer(state, titles, normalize, resolve, validate);
}

describe("eligibility thresholds", () => {
  it("derives eligible rounds from crossed level thresholds only", () => {
    expect(eligibleRoundCount(1)).toBe(0);
    expect(eligibleRoundCount(2)).toBe(0);
    expect(eligibleRoundCount(3)).toBe(1);
    expect(eligibleRoundCount(6)).toBe(1);
    expect(eligibleRoundCount(7)).toBe(2);
    expect(eligibleRoundCount(11)).toBe(3);
    expect(eligibleRoundCount(15)).toBe(4);
    expect(eligibleRoundCount(18)).toBe(4);
    expect(TOTAL_AUGMENT_ROUNDS).toBe(4);
  });
});

describe("round delivery decisions", () => {
  it("A: reaching level 7 while ALIVE never opens a fast scan window", () => {
    // R1 completed, champion alive at level 7 — R2 is pending but only an
    // ambient probe runs; no offer UI, no scan UI, nothing consumed.
    const decision = resolveRoundDelivery({
      playerLevel: 7,
      isDead: false,
      completedRounds: 1,
      offerLatched: false,
    });
    expect(decision.eligibleRounds).toBe(2);
    expect(decision.pendingRounds).toBe(1);
    expect(decision.scanMode).toBe("ambient");
    expect(decision.activeOfferRound).toBe(2);
  });

  it("A: dying with a pending round opens the fast delivery window", () => {
    const decision = resolveRoundDelivery({
      playerLevel: 8,
      isDead: true,
      completedRounds: 1,
      offerLatched: false,
    });
    expect(decision.scanMode).toBe("fast");
    expect(decision.activeOfferRound).toBe(2);
  });

  it("B: one death sequence keeps the window open across queued R2→R3→R4", () => {
    // Survived through 7/11/15: three rounds queued behind one death.
    for (const completedRounds of [1, 2, 3]) {
      const decision = resolveRoundDelivery({
        playerLevel: 15,
        isDead: true,
        completedRounds,
        offerLatched: false,
      });
      expect(decision.pendingRounds).toBe(4 - completedRounds);
      expect(decision.scanMode).toBe("fast");
      expect(decision.activeOfferRound).toBe(completedRounds + 1);
    }
    // All four selected: gameplay resumes, nothing scans.
    expect(
      resolveRoundDelivery({
        playerLevel: 15,
        isDead: true,
        completedRounds: 4,
        offerLatched: false,
      }).scanMode,
    ).toBe("off");
  });

  it("C: a false threshold transition cannot consume a round — completion never derives from level", () => {
    // Level crossed 7 alive with a noisy phase signal: completedRounds is
    // untouched (it only moves on strong evidence), so the actual
    // death-triggered R2 still delivers.
    const whileAlive = resolveRoundDelivery({
      playerLevel: 7,
      isDead: false,
      completedRounds: 1,
      offerLatched: false,
    });
    expect(whileAlive.scanMode).toBe("ambient");
    expect(whileAlive.pendingRounds).toBe(1);

    const afterDeath = resolveRoundDelivery({
      playerLevel: 8,
      isDead: true,
      completedRounds: 1,
      offerLatched: false,
    });
    expect(afterDeath.scanMode).toBe("fast");
    expect(afterDeath.pendingRounds).toBe(1);
  });

  it("D: dying below the next threshold activates nothing", () => {
    const decision = resolveRoundDelivery({
      playerLevel: 6,
      isDead: true,
      completedRounds: 1,
      offerLatched: false,
    });
    expect(decision.pendingRounds).toBe(0);
    expect(decision.scanMode).toBe("off");
  });

  it("before level 3 nothing is eligible and nothing scans", () => {
    const decision = resolveRoundDelivery({
      playerLevel: 2,
      isDead: true,
      completedRounds: 0,
      offerLatched: false,
    });
    expect(decision.eligibleRounds).toBe(0);
    expect(decision.scanMode).toBe("off");
  });

  it("initial R1 window probes ambiently while alive at level 3", () => {
    const decision = resolveRoundDelivery({
      playerLevel: 3,
      isDead: false,
      completedRounds: 0,
      offerLatched: false,
    });
    expect(decision.pendingRounds).toBe(1);
    expect(decision.scanMode).toBe("ambient");
    expect(decision.activeOfferRound).toBe(1);
  });

  it("a latched offer always keeps the fast loop — telemetry cannot block a visible surface", () => {
    // Even with stale telemetry (alive, everything apparently completed), a
    // latched validated surface keeps scanning at full speed.
    const decision = resolveRoundDelivery({
      playerLevel: 15,
      isDead: false,
      completedRounds: 4,
      offerLatched: true,
    });
    expect(decision.scanMode).toBe("fast");
  });

  it("level changes while an offer is latched never change the fast loop (level-immunity)", () => {
    for (const playerLevel of [3, 4, 5, 7, 11, 15]) {
      const decision = resolveRoundDelivery({
        playerLevel,
        isDead: false,
        completedRounds: 0,
        offerLatched: true,
      });
      expect(decision.scanMode).toBe("fast");
    }
  });
});

describe("E: chained death sequence end-to-end (delivery model + offer lifecycle)", () => {
  it("delivers R2→R3→R4 in one death without further deaths, levels, or phase resets", () => {
    // R1 completed at level 3; player survived through 7/11/15 and died once.
    let completedRounds = 1;
    let offer = emptyOfferState<string>();
    const playerLevel = 15;
    const isDead = true;

    const rounds = [
      ["R2一", "R2二", "R2三"],
      ["R3一", "R3二", "R3三"],
      ["R4一", "R4二", "R4三"],
    ];

    for (const [index, titles] of rounds.entries()) {
      const decision = resolveRoundDelivery({
        playerLevel,
        isDead,
        completedRounds,
        offerLatched: offerActive(offer),
      });
      expect(decision.scanMode).toBe("fast");

      // The queued screen swaps in on the next scan. For R3/R4 this REPLACES
      // the previous latched offer in place — that replacement is the strong
      // completion evidence for the previous round.
      const applied = scan(offer, titles);
      if (applied.replacedOffer) completedRounds += 1;
      offer = applied.state;
      expect(offerActive(offer)).toBe(true);
      expect(offer.surfaceVisible).toBe(true);

      // AFTER the scan is applied (and any replacement counted) the latched
      // offer is labeled with its true round.
      const labeled = resolveRoundDelivery({
        playerLevel,
        isDead,
        completedRounds,
        offerLatched: offerActive(offer),
      });
      expect(labeled.activeOfferRound).toBe(index + 2);
    }

    // R4 picked; the surface closes for good.
    const gap = scan(offer, [null, null, null]);
    expect(gap.state.surfaceVisible).toBe(false); // chips hidden immediately
    const done = scan(gap.state, [null, null, null]);
    expect(done.cleared).toBe(true);

    // R2 and R3 were completed via replacement evidence; R4's pick is
    // confirmed by the caller (key confirm) or stays pending — the model only
    // ever undercounts, which keeps probing alive and never suppresses a
    // future real offer.
    expect(completedRounds).toBe(3);
    const after = resolveRoundDelivery({
      playerLevel,
      isDead: false,
      completedRounds,
      offerLatched: false,
    });
    expect(after.scanMode).toBe("ambient");
    // No stale chips: nothing is latched and nothing renders.
    expect(offerActive(done.state)).toBe(false);
  });
});
