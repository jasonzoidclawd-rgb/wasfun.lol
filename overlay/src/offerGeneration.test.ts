import { describe, expect, it } from "vitest";
import { OcrOwnerRegistry, ownerCurrent, type OcrOwnerContext } from "./ocrOwner";
import {
  advanceOfferSurface,
  createOfferSurfaceState,
  renderPublicationAllowed,
  type OfferSurfaceEvidence,
  type OfferSurfaceState,
} from "./offerSurfaceState";
import { resolveRoundDelivery } from "./roundDelivery";

const evidence = (overrides: Partial<OfferSurfaceEvidence> = {}): OfferSurfaceEvidence => ({
  now: 0,
  captureValid: true,
  blueControlPresent: true,
  blueControlConfidence: 0.9,
  validCardCount: 3,
  occlusionReason: null,
  hiddenEvidence: false,
  newOfferEvidence: false,
  ...overrides,
});

function close(state: OfferSurfaceState, now: number): OfferSurfaceState {
  return advanceOfferSurface(state, evidence({
    now,
    blueControlPresent: false,
    validCardCount: 0,
  }));
}

function open(
  state: OfferSurfaceState,
  now: number,
  newOfferEvidence = false,
): OfferSurfaceState {
  return advanceOfferSurface(state, evidence({ now, newOfferEvidence }));
}

describe("R1-R4 offer generations", () => {
  it("gives R1, R2, R3 and R4 distinct generations across closes", () => {
    let state = createOfferSurfaceState();
    const generations: number[] = [];
    for (let round = 1; round <= 4; round += 1) {
      state = open(state, round * 100);
      generations.push(state.offerGeneration);
      state = close(state, round * 100 + 10);
      expect(state.state).toBe("NO_OFFER");
    }
    expect(new Set(generations).size).toBe(4);
    expect(generations).toEqual([...generations].sort((a, b) => a - b));
  });

  it.each([
    ["R2 to R3", 2],
    ["R3 to R4", 2],
    ["R2 to R3 to R4", 3],
  ])("advances every immediate %s chained offer", (_label, count) => {
    let state = open(createOfferSurfaceState(), 100);
    const generations = [state.offerGeneration];
    for (let index = 1; index < count; index += 1) {
      state = open(state, 100 + index, true);
      generations.push(state.offerGeneration);
    }
    expect(new Set(generations).size).toBe(count);
  });

  it("same-looking cards still receive a fresh generation after close", () => {
    const first = open(createOfferSurfaceState(), 100);
    const closed = close(first, 110);
    const sameLooking = open(closed, 120);
    expect(sameLooking.offerGeneration).toBeGreaterThan(first.offerGeneration);
  });

  it("old OCR and champion-stat publications from the prior generation reject", () => {
    const first = open(createOfferSurfaceState(), 100);
    const next = open(first, 110, true);
    const owners = new OcrOwnerRegistry();
    const oldContext: OcrOwnerContext = {
      foregroundEpoch: 1,
      gameEpoch: 1,
      championGeneration: 1,
      championId: "56",
      offerGeneration: first.offerGeneration,
      round: 1,
      requestedSlots: [0, 1, 2],
      slotGenerations: [1, 1, 1],
      fingerprints: ["10".repeat(72), "1100".repeat(36), "1110".repeat(36)],
    };
    const owner = owners.start(oldContext, 100);
    expect(ownerCurrent(owner, owners.current, {
      ...oldContext,
      offerGeneration: next.offerGeneration,
    })).toBe(false);
    expect(renderPublicationAllowed(first.offerGeneration, next)).toBe(false);
  });

  it("stale level bookkeeping cannot suppress a visually valid offer", () => {
    const staleBookkeeping = resolveRoundDelivery({
      playerLevel: 15,
      isDead: false,
      completedRounds: 4,
      offerLatched: false,
    });
    expect(staleBookkeeping.pendingRounds).toBe(0);
    const visual = open(createOfferSurfaceState(), 100);
    expect(visual.state).toBe("OFFER_VISIBLE");
    expect(visual.render).toBe(true);
  });
});
