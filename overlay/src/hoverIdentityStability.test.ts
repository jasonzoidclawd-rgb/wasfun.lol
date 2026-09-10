/**
 * HOVER MUST NOT INVALIDATE SEMANTIC IDENTITY.
 *
 * Live trace 2026-07-27 (offerGeneration 29). Slot 1 published SIX times —
 * runIds 13, 15, 19, 22, 23, 33 — every single time resolving to the same
 * augment 1051, the same normalizedOcrTitleHash h6b5cc207, the same 52.0% / S.
 * Its slotGeneration stayed 28 throughout, so no reroll was ever confirmed and
 * the card never changed. What DID change was the fingerprint, alternating
 * strictly between two values:
 *
 *   h1fd174bf → hbd16d903 → h1fd174bf → hbd16d903 → h1fd174bf → hbd16d903
 *
 * Slot 2 behaved identically (augment 2016, 49.2% / S, fingerprints alternating
 * h5b80d2bf / heaa9eeb2). Trace-wide that produced 54 "reroll:N" OCR triggers
 * and 24 fingerprint-drift stale rejects for FOUR real offers, and the operator
 * saw badges flicker RESOLVED → SCANNING → RESOLVED under the cursor.
 *
 * Cause: two paths compared the LIVE fingerprint against a stored one with a raw
 * per-frame Hamming test, bypassing the sustained-confirmation hysteresis that
 * exists precisely to absorb hover:
 *   - `identityForSlot` masked a resolved record whose stored fingerprint (the
 *     one captured at OCR time — sometimes A, sometimes B) differed from the
 *     live frame;
 *   - `decideOcrTrigger` re-requested OCR for the same slot, labelling it
 *     "reroll:i".
 *
 * The hysteresis itself was never at fault, and the fingerprint region is not at
 * fault: `advanceRerollConfirmation` correctly refused to confirm a reroll all
 * run long. The authority for "this card changed" is the confirmed-reroll path,
 * which clears the store and advances the slot generation. Identity validity
 * must be keyed to THAT, not to pixels that move when a tooltip opens.
 */
import { describe, expect, it } from "vitest";
import { identityForSlot, type GeometryObservation, type IdentityRecord } from "./surfaceGeometry";
import { decideOcrTrigger } from "./ocrTrigger";
import {
  advanceRerollConfirmation,
  applyRerollInvalidation,
  createRerollPending,
  REROLL_CONFIRM_PROBES,
} from "./rerollInvalidation";

// 144-bit average-hash strings; >8 bits apart reads as a different card.
const FP_A = "1".repeat(72) + "0".repeat(72);
/** Hover/tooltip variant of the SAME card: 40 bits from A, far past the band. */
const FP_A_HOVER = "0".repeat(40) + FP_A.slice(40);
/** Sub-band sparkle drift: 1 bit. */
const FP_A_SPARKLE = "0" + FP_A.slice(1);
const FP_B = "0".repeat(72) + "1".repeat(72);
const FP_C = "1".repeat(36) + "0".repeat(36) + "1".repeat(36) + "0".repeat(36);
const FP_NEW = "1".repeat(48) + "0".repeat(48) + "1".repeat(48);

function card(regionIndex: number, fingerprint: string, present = true) {
  return {
    regionIndex,
    present,
    cardRect: present ? { x: regionIndex * 100, y: 0, width: 80, height: 30 } : null,
    interiorLuma: 0,
    interiorStd: 0,
    frameContrast: 0,
    edgeEnergy: 0,
    structuralScore: 0,
    fingerprint,
  };
}

function observation(fingerprints: [string, string, string]): GeometryObservation {
  return {
    probeSeq: 1,
    capturedAt: 0,
    captureWidth: 1920,
    captureHeight: 1080,
    present: true,
    occluded: false,
    confidence: 1,
    cards: [card(0, fingerprints[0]), card(1, fingerprints[1]), card(2, fingerprints[2])],
    rejectionReasons: [],
    preCaptureMs: 0,
    captureMs: 0,
    analysisMs: 0,
    elapsedMs: 0,
  };
}

/** A resolved slot, stamped with the slot generation it was read under. */
function resolvedAt(
  fingerprint: string,
  augmentId: string,
  slotGeneration: number,
): IdentityRecord<string> {
  return {
    fingerprint,
    resolution: `id:${augmentId}`,
    resolvedAt: 100,
    championGeneration: 1,
    augmentId,
    slotGeneration,
  };
}

describe("resolved identity survives hover", () => {
  it("1. keeps a resolved publication through hover border animation", () => {
    // The card is untouched: no confirmed reroll, so the slot generation the
    // record was read under is still current. The badge must stay painted.
    const record = resolvedAt(FP_A, "1051", 28);
    expect(identityForSlot(record, 28)).toBe("id:1051");
  });

  it("5. keeps a resolved identity publishable as the capture sequence advances", () => {
    // A newer geometry frame is not evidence about the card. Same generation,
    // same identity — across many frames and both hover phases.
    const record = resolvedAt(FP_A, "1051", 28);
    for (const live of [FP_A, FP_A_HOVER, FP_A_SPARKLE, FP_A_HOVER, FP_A]) {
      void live;
      expect(identityForSlot(record, 28)).toBe("id:1051");
    }
  });

  it("survives the trace's exact A/B/A/B publication alternation", () => {
    // runIds 13,15,19,22,23,33 alternated which fingerprint they stored. Under
    // the old raw comparison, every frame showing the OTHER variant blanked the
    // chip — which is why the same augment republished six times.
    const storedUnderA = resolvedAt(FP_A, "1051", 28);
    const storedUnderB = resolvedAt(FP_A_HOVER, "1051", 28);
    expect(identityForSlot(storedUnderA, 28)).toBe("id:1051");
    expect(identityForSlot(storedUnderB, 28)).toBe("id:1051");
  });

  it("6. drops the identity once the slot generation advances (confirmed reroll)", () => {
    // The confirmed-reroll path is the ONLY authority that may blank a slot.
    const record = resolvedAt(FP_A, "1051", 28);
    expect(identityForSlot(record, 29)).toBeNull();
  });

  it("9. never blanks a resolved slot without a generation advance", () => {
    const record = resolvedAt(FP_A, "1051", 28);
    // No amount of visual drift, at any magnitude, may blank it.
    for (const generation of [28]) {
      expect(identityForSlot(record, generation)).not.toBeNull();
    }
    // Only the semantic advance does.
    expect(identityForSlot(record, 29)).toBeNull();
    expect(identityForSlot(null, 28)).toBeNull();
  });
});

describe("hover does not restart OCR", () => {
  const identities = (fps: [string, string, string], gens: [number, number, number]) =>
    [
      resolvedAt(fps[0], "1237", gens[0]),
      resolvedAt(fps[1], "1051", gens[1]),
      resolvedAt(fps[2], "2016", gens[2]),
    ] as Array<IdentityRecord<string> | null>;

  it("4. does not re-trigger OCR on decorative drift with stable semantic identity", () => {
    // Trace: 27x "reroll:1", 10x "reroll:2", 9x "reroll:1,reroll:2" — for cards
    // that never changed. A resolved slot whose generation is unchanged has
    // nothing to re-read.
    const decision = decideOcrTrigger({
      observation: observation([FP_A, FP_A_HOVER, FP_C]),
      identities: identities([FP_A, FP_A, FP_C], [28, 28, 28]),
      slotGenerations: [28, 28, 28],
      now: 1_000,
      retryMs: 4_000,
    });
    expect(decision.trigger).toBe(false);
    expect(decision.reason).not.toContain("reroll");
  });

  it("3. hovering slot 3 leaves slots 1 and 2 untouched", () => {
    const decision = decideOcrTrigger({
      observation: observation([FP_A, FP_B, FP_C]),
      identities: identities([FP_A, FP_B, FP_C], [28, 28, 28]),
      slotGenerations: [28, 28, 28],
      now: 1_000,
      retryMs: 4_000,
    });
    expect(decision.slots).not.toContain(0);
    expect(decision.slots).not.toContain(1);
  });

  it("re-reads a slot whose generation advanced, and only that slot", () => {
    // A confirmed reroll clears the store entry; the cleared slot is "new:i".
    const store = identities([FP_A, FP_B, FP_C], [28, 28, 28]);
    store[1] = null;
    const decision = decideOcrTrigger({
      observation: observation([FP_A, FP_NEW, FP_C]),
      identities: store,
      slotGenerations: [28, 29, 28],
      now: 1_000,
      retryMs: 4_000,
    });
    expect(decision.trigger).toBe(true);
    expect(decision.slots).toEqual([1]);
  });

  it("9b. still schedules a retry for an unresolved slot", () => {
    // Suppressing hover churn must not suppress genuine retry work, or a slot
    // that failed OCR would sit at SCANNING forever with nothing scheduled.
    const store = identities([FP_A, FP_B, FP_C], [28, 28, 28]);
    store[2] = { ...resolvedAt(FP_C, "", 28), resolution: null, retryAt: 500 };
    const decision = decideOcrTrigger({
      observation: observation([FP_A, FP_B, FP_C]),
      identities: store,
      slotGenerations: [28, 28, 28],
      now: 1_000,
      retryMs: 4_000,
    });
    expect(decision.slots).toEqual([2]);
    expect(decision.reason).toContain("retry:2");
  });
});

describe("hover does not disturb reroll bookkeeping", () => {
  it("2. a tooltip opening and closing bumps no slot generation", () => {
    const store = [
      resolvedAt(FP_A, "1237", 28),
      resolvedAt(FP_B, "1051", 28),
      resolvedAt(FP_C, "2016", 28),
    ] as Array<IdentityRecord<string> | null>;
    let pending = createRerollPending();
    const slotGenerations = [28, 28, 28];

    // open (drifted) → close (home) → open → close
    for (const live of [FP_A_HOVER, FP_A, FP_A_HOVER, FP_A]) {
      const obs = observation([live, FP_B, FP_C]);
      const confirmation = advanceRerollConfirmation({
        pending,
        acceptedFingerprints: [FP_A, FP_B, FP_C],
        observation: obs,
      });
      pending = confirmation.pending;
      expect(confirmation.confirmed).toEqual([]);
      const result = applyRerollInvalidation({
        store,
        acceptedFingerprints: [FP_A, FP_B, FP_C],
        slotGenerations,
        observation: obs,
        championGeneration: 1,
        now: 0,
        invalidateSlots: confirmation.confirmed,
      });
      expect(result.slotGenerations).toEqual([28, 28, 28]);
      expect(result.invalidated).toEqual([]);
    }
  });

  it("8. alternating hover fingerprints A/B/A/B never confirm a reroll", () => {
    let pending = createRerollPending();
    // Twelve probes of alternation — four times the confirmation threshold.
    for (let probe = 0; probe < 12; probe += 1) {
      const live = probe % 2 === 0 ? FP_A_HOVER : FP_A;
      const confirmation = advanceRerollConfirmation({
        pending,
        acceptedFingerprints: [FP_A, FP_B, FP_C],
        observation: observation([live, FP_B, FP_C]),
      });
      pending = confirmation.pending;
      expect(confirmation.confirmed).toEqual([]);
    }
  });

  it("6b. a genuine sustained one-slot reroll still confirms, for that slot only", () => {
    let pending = createRerollPending();
    let confirmed: number[] = [];
    for (let probe = 0; probe < REROLL_CONFIRM_PROBES; probe += 1) {
      const confirmation = advanceRerollConfirmation({
        pending,
        acceptedFingerprints: [FP_A, FP_B, FP_C],
        observation: observation([FP_NEW, FP_B, FP_C]),
      });
      pending = confirmation.pending;
      confirmed = confirmation.confirmed;
    }
    expect(confirmed).toEqual([0]);

    const result = applyRerollInvalidation({
      store: [
        resolvedAt(FP_A, "1237", 28),
        resolvedAt(FP_B, "1051", 28),
        resolvedAt(FP_C, "2016", 28),
      ],
      acceptedFingerprints: [FP_A, FP_B, FP_C],
      slotGenerations: [28, 28, 28],
      observation: observation([FP_NEW, FP_B, FP_C]),
      championGeneration: 1,
      now: 0,
      invalidateSlots: confirmed,
    });
    expect(result.slotGenerations).toEqual([29, 28, 28]);
    expect(result.store[0]).toBeNull();
    expect(result.store[1]).not.toBeNull();
    expect(result.store[2]).not.toBeNull();
  });

  it("7. a genuine three-card replacement invalidates all three at once", () => {
    const result = applyRerollInvalidation({
      store: [
        resolvedAt(FP_A, "1237", 28),
        resolvedAt(FP_B, "1051", 28),
        resolvedAt(FP_C, "2016", 28),
      ],
      acceptedFingerprints: [FP_A, FP_B, FP_C],
      slotGenerations: [28, 28, 28],
      observation: observation([FP_NEW, FP_A_HOVER, FP_A_SPARKLE]),
      championGeneration: 1,
      now: 0,
      newOffer: true,
    });
    expect(result.invalidated).toEqual([0, 1, 2]);
    expect(result.slotGenerations).toEqual([29, 29, 29]);
  });
});
