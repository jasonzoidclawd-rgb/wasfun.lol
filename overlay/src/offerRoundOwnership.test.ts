import { describe, expect, it } from "vitest";

import {
  createOfferRoundOwnership,
  reduceOfferRoundOwnership,
  type OfferRoundOwnership,
} from "./offerRoundOwnership";
import {
  advanceOfferSurface,
  createOfferSurfaceState,
  type OfferSurfaceEvidence,
} from "./offerSurfaceState";

function surfaceEvidence(
  overrides: Partial<OfferSurfaceEvidence> = {},
): OfferSurfaceEvidence {
  return {
    now: 100,
    captureValid: true,
    blueControlPresent: true,
    blueControlConfidence: 1,
    validCardCount: 3,
    occlusionReason: null,
    hiddenEvidence: false,
    newOfferEvidence: false,
    ...overrides,
  };
}

function accept(state: OfferRoundOwnership, offerGeneration: number) {
  return reduceOfferRoundOwnership(state, {
    type: "accepted-offer",
    offerGeneration,
  });
}

function close(state: OfferRoundOwnership, offerGeneration: number) {
  return reduceOfferRoundOwnership(state, {
    type: "offer-closed",
    offerGeneration,
  });
}

function clearPresentation(state: OfferRoundOwnership, offerGeneration: number) {
  return reduceOfferRoundOwnership(state, {
    type: "presentation-cleared",
    offerGeneration,
  });
}

function pick(state: OfferRoundOwnership, offerGeneration: number) {
  return reduceOfferRoundOwnership(state, {
    type: "pick-confirmed",
    offerGeneration,
  });
}

describe("accepted offer round ownership", () => {
  it("owns four sequential accepted offers independently across close-then-next transitions", () => {
    let state = createOfferRoundOwnership();

    for (const [index, generation] of [11, 18, 27, 42].entries()) {
      state = accept(state, generation);
      expect(state.activeOwner).toEqual({
        offerGeneration: generation,
        round: index + 1,
      });

      if (index < 3) {
        state = close(state, generation);
        expect(state.activeOwner).toBeNull();
      }
    }

    expect(state.completedOwners).toEqual([
      { offerGeneration: 11, round: 1 },
      { offerGeneration: 18, round: 2 },
      { offerGeneration: 27, round: 3 },
    ]);
  });

  it("completes an in-place owner when a distinct accepted successor owns the next round", () => {
    let state = accept(createOfferRoundOwnership(), 3);
    state = accept(state, 4);

    expect(state.completedOwners).toEqual([{ offerGeneration: 3, round: 1 }]);
    expect(state.activeOwner).toEqual({ offerGeneration: 4, round: 2 });
  });

  it("closes the prior visible generation before the next visible generation owns round 2 once", () => {
    let surface = advanceOfferSurface(
      createOfferSurfaceState(),
      surfaceEvidence(),
    );
    let ownership = accept(createOfferRoundOwnership(), surface.offerGeneration);
    const priorVisibleGeneration = surface.offerGeneration;

    expect(ownership.activeOwner).toEqual({
      offerGeneration: priorVisibleGeneration,
      round: 1,
    });

    surface = advanceOfferSurface(surface, surfaceEvidence({
      now: 200,
      blueControlPresent: false,
      blueControlConfidence: 0,
      validCardCount: 0,
    }));
    expect(surface.offerGeneration).toBe(priorVisibleGeneration + 1);

    ownership = close(ownership, priorVisibleGeneration);
    expect(ownership.activeOwner).toBeNull();
    expect(ownership.pendingClosedOwner).toEqual({
      offerGeneration: priorVisibleGeneration,
      round: 1,
    });

    surface = advanceOfferSurface(surface, surfaceEvidence({ now: 300 }));
    ownership = accept(ownership, surface.offerGeneration);
    ownership = accept(ownership, surface.offerGeneration);

    expect(ownership.completedOwners).toEqual([{
      offerGeneration: priorVisibleGeneration,
      round: 1,
    }]);
    expect(ownership.activeOwner).toEqual({
      offerGeneration: surface.offerGeneration,
      round: 2,
    });
  });

  it("never advances when the same accepted generation is observed again, including a one-slot reroll", () => {
    let state = accept(createOfferRoundOwnership(), 9);

    // A one-slot reroll remains part of the already accepted offer generation.
    state = accept(state, 9);
    state = accept(state, 9);

    expect(state.activeOwner).toEqual({ offerGeneration: 9, round: 1 });
    expect(state.completedOwners).toEqual([]);
  });

  it("rebinds an operationally cleared still-open offer to the same round until a genuine close", () => {
    let state = accept(createOfferRoundOwnership(), 50);

    state = clearPresentation(state, 50);
    expect(state.activeOwner).toBeNull();
    expect(state.completedOwners).toEqual([]);

    state = accept(state, 51);
    expect(state.activeOwner).toEqual({ offerGeneration: 51, round: 1 });
    expect(state.completedOwners).toEqual([]);

    state = clearPresentation(state, 51);
    state = accept(state, 52);
    expect(state.activeOwner).toEqual({ offerGeneration: 52, round: 1 });
    expect(state.completedOwners).toEqual([]);

    state = close(state, 52);
    state = accept(state, 53);
    expect(state.completedOwners).toEqual([{
      offerGeneration: 52,
      round: 1,
    }]);
    expect(state.activeOwner).toEqual({ offerGeneration: 53, round: 2 });
  });

  it("a confirmed pick completes and clears the prior owner, so the next accepted generation owns the next round", () => {
    let state = accept(createOfferRoundOwnership(), 20);
    state = pick(state, 20);

    expect(state.activeOwner).toBeNull();
    expect(state.completedOwners).toEqual([{ offerGeneration: 20, round: 1 }]);

    state = accept(state, 21);
    expect(state.activeOwner).toEqual({ offerGeneration: 21, round: 2 });
    expect(state.activeOwner?.offerGeneration).not.toBe(20);
  });

  it("ignores stale close and pick events for an older generation", () => {
    let state = accept(createOfferRoundOwnership(), 31);
    state = accept(state, 32);

    state = close(state, 31);
    state = pick(state, 31);

    expect(state.activeOwner).toEqual({ offerGeneration: 32, round: 2 });
    expect(state.completedOwners).toEqual([{ offerGeneration: 31, round: 1 }]);
  });

  it("caps ownership at four product rounds and never invents a fifth", () => {
    let state = createOfferRoundOwnership();
    for (const generation of [1, 2, 3, 4, 5]) {
      state = accept(state, generation);
    }

    expect(state.completedOwners).toEqual([
      { offerGeneration: 1, round: 1 },
      { offerGeneration: 2, round: 2 },
      { offerGeneration: 3, round: 3 },
      { offerGeneration: 4, round: 4 },
    ]);
    expect(state.activeOwner).toBeNull();
    expect(state.completedOwners.some((owner) => owner.round === 5)).toBe(false);
  });
});
