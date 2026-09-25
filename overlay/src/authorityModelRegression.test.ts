/**
 * ONE AUTHORITY FOR "THIS CARD CHANGED".
 *
 * The 2026-07-27 four-phase trace showed a resolved badge blanking to SCANNING
 * while the identity store was intact and the slot generation had never moved.
 * Three separate comparisons were each allowed to act as identity authority:
 *
 *   1. `identityForSlot` compared the live fingerprint against `record.fingerprint`
 *      (the value captured at OCR TRIGGER time);
 *   2. `decideOcrTrigger` compared the same pair again and re-requested OCR;
 *   3. `advanceRerollConfirmation` compared the live fingerprint against
 *      `acceptedSlotFingerprintsRef` — the ONLY one with hysteresis.
 *
 * (1) and (2) read a different baseline from (3), so they could disagree
 * permanently: the baseline re-latch (App.tsx:1784-1787) rewrites the accepted
 * array without touching the store, after which `accepted[i] === live[i]` (so a
 * reroll is never confirmed and the slot is never "held") while
 * `record.fingerprint` still holds the pre-drift value (so the render path blanks
 * the slot on every frame). Store intact, generation unchanged, SCANNING forever.
 *
 * These tests pin the post-fix contract: the CONFIRMED-REROLL path — which clears
 * the store and advances the slot generation — is the sole authority. Fingerprint
 * evidence is not disabled and no threshold is widened; it simply feeds the
 * hysteresis instead of being consulted raw by two other readers.
 *
 * Covers the operator's required regression areas: transient occlusion,
 * unreadable OCR, safe re-latching, genuine replacement, and no OCR restart churn
 * inside one offerGeneration.
 */
import { describe, expect, it } from "vitest";
import { identityForSlot, type GeometryObservation, type IdentityRecord } from "./surfaceGeometry";
import { decideOcrTrigger } from "./ocrTrigger";
import {
  advanceBaselineSettlement,
  advanceRerollConfirmation,
  applyRerollInvalidation,
  beginBaselineSettlement,
  createRerollPending,
  REROLL_CONFIRM_PROBES,
} from "./rerollInvalidation";

const FP_A = "1".repeat(72) + "0".repeat(72);
/** A tooltip covering ~5% of the fingerprint window measures 12 bits (see the
 *  empirical audit in the recovered fingerprint report) — well past the band. */
const FP_A_OCCLUDED = "0".repeat(40) + FP_A.slice(40);
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

function observation(
  fingerprints: [string, string, string],
  present: [boolean, boolean, boolean] = [true, true, true],
): GeometryObservation {
  return {
    probeSeq: 1,
    capturedAt: 0,
    captureWidth: 1920,
    captureHeight: 1080,
    present: true,
    occluded: false,
    confidence: 1,
    cards: [
      card(0, fingerprints[0], present[0]),
      card(1, fingerprints[1], present[1]),
      card(2, fingerprints[2], present[2]),
    ],
    rejectionReasons: [],
    preCaptureMs: 0,
    captureMs: 0,
    analysisMs: 0,
    elapsedMs: 0,
  };
}

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

describe("transient occlusion never invalidates identity", () => {
  it("a single occluded frame leaves every resolved slot's generation untouched", () => {
    // The cursor passes over card 1: geometry reports it absent for one frame.
    // Absence is the presence hysteresis's business, not the reroll path's.
    const store = [
      resolvedAt(FP_A, "1237", 28),
      resolvedAt(FP_B, "1051", 28),
      resolvedAt(FP_C, "2016", 28),
    ] as Array<IdentityRecord<string> | null>;
    const result = applyRerollInvalidation({
      store,
      acceptedFingerprints: [FP_A, FP_B, FP_C],
      slotGenerations: [28, 28, 28],
      observation: observation([FP_A, FP_B, FP_C], [true, false, true]),
      championGeneration: 1,
      now: 0,
      invalidateSlots: [],
    });
    expect(result.invalidated).toEqual([]);
    expect(result.slotGenerations).toEqual([28, 28, 28]);
    // And the neighbours keep publishing, because generation is the authority.
    expect(identityForSlot(result.store[0], 28)).toBe("id:1237");
    expect(identityForSlot(result.store[2], 28)).toBe("id:2016");
  });

  it("a settled offer stays settled through occlusion and hover drift", () => {
    // Settlement answers "has the entry animation finished?", and that cannot
    // become unanswered while the same offer is on screen. It used to: line 171
    // unlatched on ANY absent card and line 175 recomputed drift over ALL THREE
    // cards, so one oscillating slot re-armed `settling` for the whole offer
    // every 1-2 s. `settling` makes App.tsx skip advanceRerollConfirmation and
    // wipe both the pending streak and the held set, so with a 3-probe threshold
    // no streak could ever complete — in the trace the confirmed-reroll authority
    // fired ZERO times, including for two genuine card replacements.
    let settlement = beginBaselineSettlement(observation([FP_A, FP_B, FP_C]), 0);
    settlement = advanceBaselineSettlement({
      settlement,
      observation: observation([FP_A, FP_B, FP_C]),
      now: 400,
    });
    expect(settlement.latched).toBe(true);
    const latchedBaseline = settlement.provisional.slice();

    // A cursor covering a card, then 40-bit hover drift, then a return home.
    const disturbances: Array<GeometryObservation> = [
      observation([FP_A, FP_B, FP_C], [true, false, true]),
      observation([FP_A_OCCLUDED, FP_B, FP_C]),
      observation([FP_A, FP_B, FP_C]),
    ];
    for (const [index, obs] of disturbances.entries()) {
      settlement = advanceBaselineSettlement({
        settlement,
        observation: obs,
        now: 550 + index * 150,
      });
      expect(settlement.latched).toBe(true);
      // The accepted baseline never chases the disturbance either.
      expect(settlement.provisional).toEqual(latchedBaseline);
    }

    // And identity validity never depended on settlement state to begin with.
    const record = resolvedAt(FP_A, "1237", 28);
    expect(identityForSlot(record, 28)).toBe("id:1237");
  });

  it("a fresh offer settles again from scratch", () => {
    // Terminal latching is per OFFER, not per session: a genuinely new offer
    // calls beginBaselineSettlement and must re-run both floors, or the entry
    // animation could confirm itself as a three-slot reroll again.
    const fresh = beginBaselineSettlement(observation([FP_NEW, FP_A, FP_B]), 10_000);
    expect(fresh.latched).toBe(false);
    expect(
      advanceBaselineSettlement({
        settlement: fresh,
        observation: observation([FP_NEW, FP_A, FP_B]),
        now: 10_100,
      }).latched,
    ).toBe(false); // 100 ms < BASELINE_STABLE_MS
    expect(
      advanceBaselineSettlement({
        settlement: fresh,
        observation: observation([FP_NEW, FP_A, FP_B]),
        now: 10_400,
      }).latched,
    ).toBe(true);
  });

  it("occlusion-magnitude drift on one slot triggers no OCR while the generation holds", () => {
    const decision = decideOcrTrigger({
      observation: observation([FP_A_OCCLUDED, FP_B, FP_C]),
      identities: [
        resolvedAt(FP_A, "1237", 28),
        resolvedAt(FP_B, "1051", 28),
        resolvedAt(FP_C, "2016", 28),
      ],
      slotGenerations: [28, 28, 28],
      now: 1_000,
      retryMs: 4_000,
    });
    expect(decision.trigger).toBe(false);
  });
});

describe("safe re-latching", () => {
  it("re-latching the accepted baseline cannot orphan a stored record", () => {
    // THE SPLIT-BRAIN. The re-latch writes `settlement.provisional` into the
    // accepted array while the store keeps the fingerprint from OCR-trigger
    // time. Post-fix nothing reads `record.fingerprint` as authority, so the two
    // arrays can differ without any user-visible consequence.
    const record = resolvedAt(FP_A, "1051", 28);
    const relatchedAccepted = [FP_A_OCCLUDED, FP_B, FP_C];

    // accepted[0] now disagrees with record.fingerprint by 40 bits...
    expect(relatchedAccepted[0]).not.toBe(record.fingerprint);
    // ...and the slot still publishes, because generation is the authority.
    expect(identityForSlot(record, 28)).toBe("id:1051");

    // The confirmation path measures from the re-latched baseline and, seeing the
    // live frame agree with it, confirms nothing — so no generation ever moves.
    const confirmation = advanceRerollConfirmation({
      pending: createRerollPending(),
      acceptedFingerprints: relatchedAccepted,
      observation: observation([FP_A_OCCLUDED, FP_B, FP_C]),
    });
    expect(confirmation.confirmed).toEqual([]);
    expect(identityForSlot(record, 28)).toBe("id:1051");
  });

  it("a re-latch followed by a genuine reroll still invalidates exactly one slot", () => {
    // Re-latching must not disarm real replacement detection.
    const accepted = [FP_A_OCCLUDED, FP_B, FP_C];
    let pending = createRerollPending();
    let confirmed: number[] = [];
    for (let probe = 0; probe < REROLL_CONFIRM_PROBES; probe += 1) {
      const confirmation = advanceRerollConfirmation({
        pending,
        acceptedFingerprints: accepted,
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
      acceptedFingerprints: accepted,
      slotGenerations: [28, 28, 28],
      observation: observation([FP_NEW, FP_B, FP_C]),
      championGeneration: 1,
      now: 0,
      invalidateSlots: confirmed,
    });
    expect(result.slotGenerations).toEqual([29, 28, 28]);
    expect(result.store[0]).toBeNull();
    // The two untouched slots keep publishing at their unchanged generation.
    expect(identityForSlot(result.store[1], 28)).toBe("id:1051");
    expect(identityForSlot(result.store[2], 28)).toBe("id:2016");
  });
});

describe("genuine replacement is still detected", () => {
  /**
   * Drives the caller's real sequence (App.tsx:1790-1828) for one frame:
   * settlement first, then confirmation — but ONLY when settled, because a
   * settling frame wipes the pending streak and the held set.
   */
  function frame(
    state: { settlement: ReturnType<typeof beginBaselineSettlement>; pending: ReturnType<typeof createRerollPending>; accepted: string[] },
    obs: GeometryObservation,
    now: number,
  ): { confirmed: number[]; held: number[] } {
    const wasLatched = state.settlement.latched;
    state.settlement = advanceBaselineSettlement({ settlement: state.settlement, observation: obs, now });
    if (state.settlement.latched && !wasLatched) {
      state.accepted = state.settlement.provisional.slice();
      state.pending = createRerollPending();
    }
    if (!state.settlement.latched) {
      state.pending = createRerollPending();
      return { confirmed: [], held: [] };
    }
    const confirmation = advanceRerollConfirmation({
      pending: state.pending,
      acceptedFingerprints: state.accepted,
      observation: obs,
    });
    state.pending = confirmation.pending;
    return { confirmed: confirmation.confirmed, held: confirmation.held };
  }

  it("confirms a real reroll even while a NEIGHBOUR slot oscillates every frame", () => {
    // THE TRACE SHAPE, and the reason F1 exists. Slot 1 alternates between two
    // poles ~17 bits apart on every probe. `drifted` in advanceBaselineSettlement
    // is computed over ALL THREE cards, so before the fix that unlatched the
    // whole offer every frame; `settling` then wiped the pending streak, and with
    // REROLL_CONFIRM_PROBES = 3 no streak could ever complete. Across the entire
    // 2026-07-27 offer the confirmed-reroll authority fired ZERO times — for the
    // two genuine replacements as well (slot 0: 2018 -> 1051 at Hamming 22).
    const state = {
      settlement: beginBaselineSettlement(observation([FP_A, FP_B, FP_C]), 0),
      pending: createRerollPending(),
      accepted: [FP_A, FP_B, FP_C],
    };
    // Settle the offer (two observations, past BASELINE_STABLE_MS).
    frame(state, observation([FP_A, FP_B, FP_C]), 400);
    expect(state.settlement.latched).toBe(true);

    // Now slot 0 is genuinely replaced while slot 1 oscillates on every frame.
    let confirmed: number[] = [];
    for (let probe = 0; probe < REROLL_CONFIRM_PROBES; probe += 1) {
      const noisyNeighbour = probe % 2 === 0 ? FP_A_OCCLUDED : FP_B;
      confirmed = frame(
        state,
        observation([FP_NEW, noisyNeighbour, FP_C]),
        550 + probe * 150,
      ).confirmed;
    }
    expect(confirmed).toEqual([0]);
    expect(state.settlement.latched).toBe(true);
  });

  it("an oscillating REPLACEMENT does not confirm — the accepted trade-off", () => {
    // Pinning the known boundary rather than leaving it accidental. The streak
    // requires a single stable candidate, so a replacement card whose own art
    // swings past the band between consecutive probes never confirms, and the
    // slot keeps its previous badge instead of blanking. This is a property of
    // `advanceRerollConfirmation`, which the authority change did not touch, and
    // it is the price of absorbing a stationary cursor: nothing in the
    // fingerprint alone separates "cursor parked on this card" from "new card".
    // In practice a reroll is operator-initiated with the cursor on the reroll
    // button, so the replacement's first frames are unhovered and stable.
    const state = {
      settlement: beginBaselineSettlement(observation([FP_A, FP_B, FP_C]), 0),
      pending: createRerollPending(),
      accepted: [FP_A, FP_B, FP_C],
    };
    frame(state, observation([FP_A, FP_B, FP_C]), 400);
    for (let probe = 0; probe < 12; probe += 1) {
      const swinging = probe % 2 === 0 ? FP_NEW : FP_A_OCCLUDED;
      expect(frame(state, observation([swinging, FP_B, FP_C]), 550 + probe * 150).confirmed)
        .toEqual([]);
    }
  });

  it("a confirmed reroll makes the cleared slot — and only it — re-read", () => {
    const store = [
      resolvedAt(FP_A, "1237", 28),
      resolvedAt(FP_B, "1051", 28),
      resolvedAt(FP_C, "2016", 28),
    ] as Array<IdentityRecord<string> | null>;
    const invalidation = applyRerollInvalidation({
      store,
      acceptedFingerprints: [FP_A, FP_B, FP_C],
      slotGenerations: [28, 28, 28],
      observation: observation([FP_NEW, FP_B, FP_C]),
      championGeneration: 1,
      now: 0,
      invalidateSlots: [0],
    });
    const decision = decideOcrTrigger({
      observation: observation([FP_NEW, FP_B, FP_C]),
      identities: invalidation.store,
      slotGenerations: invalidation.slotGenerations,
      now: 1_000,
      retryMs: 4_000,
    });
    expect(decision.slots).toEqual([0]);
  });

  it("a stored record left behind at an old generation is re-read, not published", () => {
    // Defence in depth: if any path advances a generation without clearing the
    // store, the record must be treated as stale rather than painted.
    const stale = resolvedAt(FP_A, "1237", 28);
    expect(identityForSlot(stale, 29)).toBeNull();
    const decision = decideOcrTrigger({
      observation: observation([FP_NEW, FP_B, FP_C]),
      identities: [stale, resolvedAt(FP_B, "1051", 28), resolvedAt(FP_C, "2016", 28)],
      slotGenerations: [29, 28, 28],
      now: 1_000,
      retryMs: 4_000,
    });
    expect(decision.slots).toEqual([0]);
    expect(decision.reason).toContain("reroll:0");
  });

  it("a three-card replacement invalidates all three and re-reads all three", () => {
    const invalidation = applyRerollInvalidation({
      store: [
        resolvedAt(FP_A, "1237", 28),
        resolvedAt(FP_B, "1051", 28),
        resolvedAt(FP_C, "2016", 28),
      ],
      acceptedFingerprints: [FP_A, FP_B, FP_C],
      slotGenerations: [28, 28, 28],
      observation: observation([FP_NEW, FP_A_OCCLUDED, FP_A]),
      championGeneration: 1,
      now: 0,
      newOffer: true,
    });
    expect(invalidation.invalidated).toEqual([0, 1, 2]);
    const decision = decideOcrTrigger({
      observation: observation([FP_NEW, FP_A_OCCLUDED, FP_A]),
      identities: invalidation.store,
      slotGenerations: invalidation.slotGenerations,
      now: 1_000,
      retryMs: 4_000,
    });
    expect(decision.slots).toEqual([0, 1, 2]);
  });
});

describe("no OCR restart churn inside one offerGeneration", () => {
  it("a stable resolved offer requests zero OCR runs across 200 probes", () => {
    // R3 ran 24 OCR runs for ONE offer because every geometry frame re-fired
    // "reroll:i" off raw drift. With generation as the authority the steady
    // state is silent.
    const identities = [
      resolvedAt(FP_A, "1237", 28),
      resolvedAt(FP_B, "1051", 28),
      resolvedAt(FP_C, "2016", 28),
    ];
    const slotGenerations = [28, 28, 28];
    let triggers = 0;
    for (let probe = 0; probe < 200; probe += 1) {
      // Alternate hover phases exactly as the trace did (A/B/A/B on slots 1-2).
      const live: [string, string, string] = probe % 2 === 0
        ? [FP_A, FP_B, FP_C]
        : [FP_A_OCCLUDED, FP_B, FP_C];
      const decision = decideOcrTrigger({
        observation: observation(live),
        identities,
        slotGenerations,
        now: 1_000 + probe * 150,
        retryMs: 4_000,
      });
      if (decision.trigger) triggers += 1;
    }
    expect(triggers).toBe(0);
  });

  it("exactly one re-read is requested per confirmed reroll, not one per frame", () => {
    let store = [
      resolvedAt(FP_A, "1237", 28),
      resolvedAt(FP_B, "1051", 28),
      resolvedAt(FP_C, "2016", 28),
    ] as Array<IdentityRecord<string> | null>;
    let slotGenerations = [28, 28, 28];

    const invalidation = applyRerollInvalidation({
      store,
      acceptedFingerprints: [FP_A, FP_B, FP_C],
      slotGenerations,
      observation: observation([FP_NEW, FP_B, FP_C]),
      championGeneration: 1,
      now: 0,
      invalidateSlots: [0],
    });
    store = invalidation.store;
    slotGenerations = invalidation.slotGenerations;

    // Frame 1 after the reroll: slot 0 is null → one "new:0" request.
    const first = decideOcrTrigger({
      observation: observation([FP_NEW, FP_B, FP_C]),
      identities: store,
      slotGenerations,
      now: 1_000,
      retryMs: 4_000,
    });
    expect(first.slots).toEqual([0]);

    // OCR lands and writes the record at the CURRENT generation.
    store[0] = resolvedAt(FP_NEW, "3001", slotGenerations[0]);

    // Every subsequent frame — including hover drift — asks for nothing.
    for (let probe = 0; probe < 50; probe += 1) {
      const live: [string, string, string] = probe % 2 === 0
        ? [FP_NEW, FP_B, FP_C]
        : [FP_A_OCCLUDED, FP_B, FP_C];
      const decision = decideOcrTrigger({
        observation: observation(live),
        identities: store,
        slotGenerations,
        now: 2_000 + probe * 150,
        retryMs: 4_000,
      });
      expect(decision.trigger).toBe(false);
    }
  });

  it("an unresolved slot still retries on its backoff deadline", () => {
    // Suppressing churn must never leave a slot on SCANNING with no scheduled
    // work — that is one of the operator's explicit invariants.
    const store = [
      resolvedAt(FP_A, "1237", 28),
      resolvedAt(FP_B, "1051", 28),
      { ...resolvedAt(FP_C, "", 28), resolution: null, retryAt: 5_000 },
    ] as Array<IdentityRecord<string> | null>;
    const before = decideOcrTrigger({
      observation: observation([FP_A, FP_B, FP_C]),
      identities: store,
      slotGenerations: [28, 28, 28],
      now: 4_999,
      retryMs: 4_000,
    });
    expect(before.trigger).toBe(false);
    const after = decideOcrTrigger({
      observation: observation([FP_A, FP_B, FP_C]),
      identities: store,
      slotGenerations: [28, 28, 28],
      now: 5_000,
      retryMs: 4_000,
    });
    expect(after.slots).toEqual([2]);
    expect(after.reason).toContain("retry:2");
  });
});

describe("unreadable OCR does not wipe a resolved slot", () => {
  const app = new URL("./App.tsx", import.meta.url);

  it("routes the identity-failure path through the reconciliation guard", async () => {
    // App.tsx:2641-2660 built a fresh `resolution: null` record for every
    // requested slot on any OCR timeout, bypassing `reconcileIdentityRecord`
    // entirely. During the R4 duplicate-OCR storm (runIds 36-42, all timing out)
    // that wiped already-resolved identities with no generation bump — the
    // 01:12:29 "publications disappeared" frame. The failure path must reuse the
    // one guard that refuses to downgrade a resolved record.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(app, "utf8");
    const failureBlock = src.slice(
      src.indexOf("// Identity-only failure:"),
      src.indexOf("ocrPendingSlotsRef.current = [];", src.indexOf("// Identity-only failure:")),
    );
    expect(failureBlock.length).toBeGreaterThan(0);
    expect(failureBlock).toContain("reconcileIdentityRecord(");
  });

  it("keeps rendering the resolved tier while a re-read is unresolved", () => {
    // Whatever the OCR track is doing, a record that still carries a resolution
    // at the current generation renders its tier — never SCANNING.
    const record = resolvedAt(FP_A, "1051", 28);
    expect(identityForSlot(record, 28)).toBe("id:1051");
    // A record whose resolution really was cleared renders SCANNING.
    expect(identityForSlot({ ...record, resolution: null }, 28)).toBeNull();
  });
});
