/**
 * PHASE A — unified publication ownership + slot stability.
 *
 * One explicit ownership token is shared by geometry, OCR, champion datasets,
 * statistics and rendering. Every async result must validate all relevant
 * ownership fields immediately before publication, and an unchanged card's
 * canonical identity and statistic are IMMUTABLE within a champion generation.
 */
import { describe, expect, it } from "vitest";
import {
  ownershipCurrent,
  reconcileSlotIdentity,
  type OwnershipToken,
  type SlotIdentity,
} from "./publicationOwnership";

function token(overrides: Partial<OwnershipToken> = {}): OwnershipToken {
  return {
    foregroundEpoch: 1,
    gameEpoch: 1,
    championGeneration: 3,
    championId: "56",
    championRequestId: 5,
    offerGeneration: 2,
    geometrySeq: 40,
    slotGeneration: 7,
    fingerprint: "111100001111000011110000",
    ocrRunId: 11,
    ...overrides,
  };
}

function identity(overrides: Partial<SlotIdentity<string>> = {}): SlotIdentity<string> {
  return {
    foregroundEpoch: 1,
    gameEpoch: 1,
    fingerprint: "111100001111000011110000",
    championGeneration: 3,
    offerGeneration: 2,
    augmentId: "1006",
    resolution: "S+/48.0096",
    slotGeneration: 7,
    ocrRunId: 11,
    conflictCount: 0,
    ...overrides,
  };
}

describe("ownershipCurrent — publish only when every relevant field matches", () => {
  it("permits publication when the whole token matches current state", () => {
    expect(ownershipCurrent(token(), token())).toBe(true);
  });

  it("rejects older geometry overwriting newer geometry", () => {
    // Result captured at geometrySeq 40; a newer probe advanced current to 41.
    expect(ownershipCurrent(token({ geometrySeq: 40 }), token({ geometrySeq: 41 }))).toBe(false);
  });

  it("rejects an old OCR result publishing after a reroll", () => {
    // Reroll bumped slotGeneration + fingerprint + ocrRunId; the stale run is stale.
    const stale = token({ slotGeneration: 7, ocrRunId: 11, fingerprint: "111100001111000011110000" });
    const current = token({ slotGeneration: 8, ocrRunId: 12, fingerprint: "000011110000111100001111" });
    expect(ownershipCurrent(stale, current)).toBe(false);
  });

  it("rejects old champion data publishing after a champion change", () => {
    const old = token({ championGeneration: 3, championId: "56", championRequestId: 5 });
    const now = token({ championGeneration: 4, championId: "103", championRequestId: 6 });
    expect(ownershipCurrent(old, now)).toBe(false);
  });

  it("rejects a late result trying to resurrect output after no-offer / occlusion", () => {
    // Clearing to no-offer / occlusion advances the offer generation.
    expect(ownershipCurrent(token({ offerGeneration: 2 }), token({ offerGeneration: 3 }))).toBe(false);
  });

  it("rejects a chained offer reusing a previous generation", () => {
    // R2 result (offerGeneration 2) cannot publish once R3 owns generation 3.
    expect(ownershipCurrent(token({ offerGeneration: 2 }), token({ offerGeneration: 3 }))).toBe(false);
  });

  it("rejects a result from a superseded foreground or game epoch", () => {
    expect(ownershipCurrent(token({ foregroundEpoch: 1 }), token({ foregroundEpoch: 2 }))).toBe(false);
    expect(ownershipCurrent(token({ gameEpoch: 1 }), token({ gameEpoch: 2 }))).toBe(false);
  });

  it("tolerates sparkle-level fingerprint drift within the Hamming band", () => {
    // One bit of animated-background drift is the same card, not a stale result.
    const a = token({ fingerprint: "111100001111000011110000" });
    const b = token({ fingerprint: "111100001111000011110001" });
    expect(ownershipCurrent(a, b)).toBe(true);
  });
});

describe("reconcileSlotIdentity — immutable within a champion generation", () => {
  it("adopts an incoming identity when the slot has no verified identity yet", () => {
    const r = reconcileSlotIdentity(null, identity());
    expect(r.action).toBe("adopt");
    expect(r.identity.augmentId).toBe("1006");
  });

  it("keeps the verified identity — unchanged fingerprint + champion cannot change canonical identity", () => {
    // A conflicting OCR read resolves the SAME visible card to a different augment.
    const prev = identity({ augmentId: "1006", resolution: "S+/48.0096" });
    const conflicting = identity({ augmentId: "1204", resolution: "C/45.3" });
    const r = reconcileSlotIdentity(prev, conflicting);
    expect(r.action).toBe("keep");
    if (r.action !== "keep") throw new Error("unreachable");
    expect(r.reason).toBe("identity-conflict");
    expect(r.identity.augmentId).toBe("1006"); // verified identity retained
    expect(r.identity.resolution).toBe("S+/48.0096");
  });

  it("recomputes only the derived statistic for the same canonical identity", () => {
    const prev = identity({ augmentId: "1006", resolution: "GLOBAL/C/45.3" });
    const recomputed = identity({ augmentId: "1006", resolution: "CHAMP/S/57.4", ocrRunId: 12 });
    const r = reconcileSlotIdentity(prev, recomputed);
    expect(r.action).toBe("recompute-stat");
    expect(r.identity.augmentId).toBe("1006");
    expect(r.identity.resolution).toBe("CHAMP/S/57.4");
  });

  it("bounds repeated conflicting OCR without changing canonical identity", () => {
    let current = identity({ augmentId: "1006" });
    for (let i = 0; i < 20; i += 1) {
      const r = reconcileSlotIdentity(current, identity({ augmentId: "1204", ocrRunId: 12 + i }));
      expect(r.action).toBe("keep");
      current = r.identity;
    }
    expect(current.augmentId).toBe("1006");
    expect(current.conflictCount).toBe(3);
  });

  it("replaces on a genuine reroll (fingerprint changed past the Hamming band)", () => {
    const prev = identity({ fingerprint: "111100001111000011110000", augmentId: "1006" });
    const rerolled = identity({ fingerprint: "000011110000111100001111", augmentId: "1204", resolution: "A/50" });
    const r = reconcileSlotIdentity(prev, rerolled);
    expect(r.action).toBe("replace");
    expect(r.identity.augmentId).toBe("1204");
  });

  it("replaces (recomputes) when the champion generation changed", () => {
    const prev = identity({ championGeneration: 3, augmentId: "1006", resolution: "S+/48.0096" });
    const recomputed = identity({ championGeneration: 4, augmentId: "1006", resolution: "A/51.6" });
    const r = reconcileSlotIdentity(prev, recomputed);
    expect(r.action).toBe("replace");
    expect(r.identity.resolution).toBe("A/51.6"); // new champion's own value
  });
});
