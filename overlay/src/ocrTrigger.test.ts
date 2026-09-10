import { describe, expect, it } from "vitest";
import { decideOcrTrigger } from "./ocrTrigger";
import {
  IDENTITY_RETRY_MS,
  type GeometryCard,
  type GeometryObservation,
  type IdentityRecord,
} from "./surfaceGeometry";

// Distinct 144-bit patterns with large mutual Hamming distance.
const FP0 = "10".repeat(72);
const FP1 = "1100".repeat(36);
const FP2 = "1110".repeat(36);
const FP1_REROLL = "0011".repeat(36); // hamming 144 from FP1 (a real reroll)

function card(i: number, fingerprint: string, present = true): GeometryCard {
  return {
    regionIndex: i,
    present,
    cardRect: present ? { x: i, y: 0, width: 1, height: 1 } : null,
    interiorLuma: 13,
    interiorStd: 1,
    frameContrast: 109,
    edgeEnergy: 13,
    structuralScore: 0.9,
    fingerprint,
  };
}

function obs(cards: GeometryCard[], over: Partial<GeometryObservation> = {}): GeometryObservation {
  return {
    probeSeq: 1,
    capturedAt: 1000,
    captureWidth: 1280,
    captureHeight: 720,
    present: true,
    occluded: false,
    confidence: 0.9,
    cards,
    rejectionReasons: [],
    preCaptureMs: 5,
    captureMs: 30,
    analysisMs: 1,
    elapsedMs: 40,
    ...over,
  };
}

const rec = (
  fingerprint: string,
  resolution: string | null,
  resolvedAt = 0,
  slotGeneration = 0,
): IdentityRecord<string> => ({
  fingerprint,
  resolution,
  resolvedAt,
  slotGeneration,
});

const PRESENT = [card(0, FP0), card(1, FP1), card(2, FP2)];
/** Steady state: every record was read under the generation still in force. */
const GEN = [0, 0, 0];

describe("decideOcrTrigger", () => {
  it("triggers all three slots on a freshly appeared offer (no records)", () => {
    const d = decideOcrTrigger({ observation: obs(PRESENT), identities: [null, null, null], slotGenerations: GEN, now: 0, retryMs: IDENTITY_RETRY_MS });
    expect(d.trigger).toBe(true);
    expect(d.slots).toEqual([0, 1, 2]);
  });

  it("does NOT trigger when every slot is resolved and unchanged (no OCR churn)", () => {
    const d = decideOcrTrigger({
      observation: obs(PRESENT),
      identities: [rec(FP0, "a"), rec(FP1, "b"), rec(FP2, "c")],
      slotGenerations: GEN,
      now: 100,
      retryMs: IDENTITY_RETRY_MS,
    });
    expect(d.trigger).toBe(false);
    expect(d.slots).toEqual([]);
    expect(d.reason).toBe("up-to-date");
  });

  it("a rerolled slot re-reads ONLY that slot; others keep their identities", () => {
    // A reroll is the CONFIRMED-REROLL path advancing slot 1's generation. The
    // new pixels come with it, but they are not what makes it a reroll.
    const rerolled = obs([card(0, FP0), card(1, FP1_REROLL), card(2, FP2)]);
    const d = decideOcrTrigger({
      observation: rerolled,
      identities: [rec(FP0, "a"), rec(FP1, "b"), rec(FP2, "c")],
      slotGenerations: [0, 1, 0],
      now: 100,
      retryMs: IDENTITY_RETRY_MS,
    });
    expect(d.slots).toEqual([1]);
    expect(d.reason).toContain("reroll:1");
  });

  it("new pixels WITHOUT a generation advance are hover/animation, not a reroll", () => {
    // The 2026-07-27 regression in one assertion: 144 bits of movement on slot 1
    // and the trigger stays silent, because no authority confirmed a change.
    const d = decideOcrTrigger({
      observation: obs([card(0, FP0), card(1, FP1_REROLL), card(2, FP2)]),
      identities: [rec(FP0, "a"), rec(FP1, "b"), rec(FP2, "c")],
      slotGenerations: GEN,
      now: 100,
      retryMs: IDENTITY_RETRY_MS,
    });
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe("up-to-date");
  });

  it.each([0, 1, 2])(
    "re-reads only changed slot %d",
    (changedSlot) => {
      const rerolledCards = [...PRESENT];
      rerolledCards[changedSlot] = card(changedSlot, FP1_REROLL);
      const identities = [rec(FP0, "left"), rec(FP1, "middle"), rec(FP2, "right")];
      const slotGenerations = [0, 0, 0];
      slotGenerations[changedSlot] = 1;
      const d = decideOcrTrigger({
        observation: obs(rerolledCards),
        identities,
        slotGenerations,
        now: 100,
        retryMs: IDENTITY_RETRY_MS,
      });
      expect(d.slots).toEqual([changedSlot]);
      for (const slot of [0, 1, 2]) {
        if (slot === changedSlot) continue;
        expect(d.slots).not.toContain(slot);
      }
    },
  );

  it("re-triggers an unresolved slot only after the retry deadline", () => {
    const identities = [rec(FP0, null, 0), rec(FP1, "b"), rec(FP2, "c")];
    const before = decideOcrTrigger({ observation: obs(PRESENT), identities, slotGenerations: GEN, now: IDENTITY_RETRY_MS - 1, retryMs: IDENTITY_RETRY_MS });
    expect(before.trigger).toBe(false);
    const after = decideOcrTrigger({ observation: obs(PRESENT), identities, slotGenerations: GEN, now: IDENTITY_RETRY_MS, retryMs: IDENTITY_RETRY_MS });
    expect(after.slots).toEqual([0]);
    expect(after.reason).toContain("retry:0");
  });

  it("never triggers OCR while occluded (identities retained, not re-read)", () => {
    const d = decideOcrTrigger({
      observation: obs(PRESENT, { occluded: true }),
      identities: [null, null, null],
      slotGenerations: GEN,
      now: 0,
      retryMs: IDENTITY_RETRY_MS,
    });
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe("occluded");
  });

  it("never triggers OCR when the surface is absent", () => {
    const d = decideOcrTrigger({
      observation: obs([card(0, "", false), card(1, "", false), card(2, "", false)], { present: false }),
      identities: [null, null, null],
      slotGenerations: GEN,
      now: 0,
      retryMs: IDENTITY_RETRY_MS,
    });
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe("absent");
  });

  it("force-refresh re-reads named slots regardless of state", () => {
    const d = decideOcrTrigger({
      observation: obs(PRESENT),
      identities: [rec(FP0, "a"), rec(FP1, "b"), rec(FP2, "c")],
      slotGenerations: GEN,
      now: 100,
      retryMs: IDENTITY_RETRY_MS,
      forceSlots: [2],
    });
    expect(d.slots).toEqual([2]);
    expect(d.reason).toContain("force:2");
  });
});
