import { describe, expect, it } from "vitest";
import {
  advanceOfferSurface,
  createOfferSurfaceState,
  renderPublicationAllowed,
  type OfferSurfaceEvidence,
} from "./offerSurfaceState";

const visible = (overrides: Partial<OfferSurfaceEvidence> = {}): OfferSurfaceEvidence => ({
  now: 100,
  captureValid: true,
  blueControlPresent: true,
  blueControlConfidence: 0.9,
  validCardCount: 3,
  occlusionReason: null,
  hiddenEvidence: false,
  newOfferEvidence: false,
  ...overrides,
});

describe("offer surface state machine", () => {
  it("blue control plus valid cards is OFFER_VISIBLE", () => {
    const next = advanceOfferSurface(createOfferSurfaceState(), visible());
    expect(next.state).toBe("OFFER_VISIBLE");
    expect(next.render).toBe(true);
  });

  it("cards and control absent is NO_OFFER and renders nothing", () => {
    const prior = advanceOfferSurface(createOfferSurfaceState(), visible());
    const next = advanceOfferSurface(prior, visible({ now: 200, validCardCount: 0, blueControlPresent: false }));
    expect(next.state).toBe("NO_OFFER");
    expect(next.render).toBe(false);
    expect(next.offerGeneration).toBeGreaterThan(prior.offerGeneration);
  });

  it.each(["shop", "afk-modal", "scoreboard", "settings"])(
    "%s is OCCLUDED and immediately renders zero",
    (reason) => {
      const prior = advanceOfferSurface(createOfferSurfaceState(), visible());
      const next = advanceOfferSurface(prior, visible({ now: 200, occlusionReason: reason }));
      expect(next.state).toBe("OCCLUDED");
      expect(next.render).toBe(false);
    },
  );

  it("valid combat evidence is NO_OFFER", () => {
    const next = advanceOfferSurface(createOfferSurfaceState(), visible({
      validCardCount: 0,
      blueControlPresent: false,
    }));
    expect(next.state).toBe("NO_OFFER");
  });

  it("capture failure is UNCERTAIN and continuity expires at the health bound", () => {
    const prior = advanceOfferSurface(createOfferSurfaceState(), visible({ now: 100 }));
    const within = advanceOfferSurface(prior, visible({ now: 1_000, captureValid: false }));
    const expired = advanceOfferSurface(within, visible({ now: 1_500, captureValid: false }));
    expect(within.state).toBe("UNCERTAIN");
    expect(within.render).toBe(true);
    expect(expired.state).toBe("UNCERTAIN");
    expect(expired.render).toBe(false);
  });

  it("late publication after NO_OFFER or OCCLUDED cannot restore output", () => {
    const visibleState = advanceOfferSurface(createOfferSurfaceState(), visible());
    const noOffer = advanceOfferSurface(visibleState, visible({ validCardCount: 0, blueControlPresent: false }));
    const occluded = advanceOfferSurface(visibleState, visible({ occlusionReason: "shop" }));
    expect(renderPublicationAllowed(visibleState.offerGeneration, noOffer)).toBe(false);
    expect(renderPublicationAllowed(visibleState.offerGeneration, occluded)).toBe(false);
  });

  it("does not classify OFFER_HIDDEN without genuine hidden evidence", () => {
    const uncertain = advanceOfferSurface(createOfferSurfaceState(), visible({ validCardCount: 0 }));
    expect(uncertain.state).toBe("UNCERTAIN");
    const hidden = advanceOfferSurface(createOfferSurfaceState(), visible({
      validCardCount: 0,
      hiddenEvidence: true,
    }));
    expect(hidden.state).toBe("OFFER_HIDDEN");
    expect(hidden.render).toBe(false);
  });

  it("explicit negative evidence overrides uncertainty continuity", () => {
    const prior = advanceOfferSurface(createOfferSurfaceState(), visible());
    const noOffer = advanceOfferSurface(prior, visible({
      now: 101,
      validCardCount: 0,
      blueControlPresent: false,
    }));
    expect(noOffer.state).toBe("NO_OFFER");
    expect(noOffer.render).toBe(false);
  });

  // 6. Sustained-confirmation companion guard: transient OCCLUDED (hover
  // tooltip) and UNCERTAIN (dropped frame) noise between two visible frames of
  // the SAME offer must not churn the offer generation — a generation bump
  // would re-arm all slots (SCANNING) and reset the coach. Only a genuine close
  // (NO_OFFER) or a confirmed new offer may advance it.
  it("6. brief OCCLUDED / UNCERTAIN noise between visible frames does not churn offer generation", () => {
    let s = advanceOfferSurface(createOfferSurfaceState(), visible({ now: 100 }));
    const gen = s.offerGeneration;
    s = advanceOfferSurface(s, visible({ now: 200, occlusionReason: "shop" }));       // hover tooltip → OCCLUDED
    s = advanceOfferSurface(s, visible({ now: 300, captureValid: false }));           // dropped frame → UNCERTAIN
    s = advanceOfferSurface(s, visible({ now: 400, occlusionReason: "scoreboard" })); // OCCLUDED
    s = advanceOfferSurface(s, visible({ now: 500 }));                                // same offer visible again
    expect(s.state).toBe("OFFER_VISIBLE");
    expect(s.offerGeneration).toBe(gen); // retained identities, no re-arm
  });
});

// Failures A + E: the blue central control is supportive evidence, never
// mandatory for OFFER_VISIBLE. Two structurally valid cards with no card-area
// occlusion is a visible offer regardless of the control, so a tooltip covering
// the control (or a control false-negative) can never blank the badges.
describe("blue control is supportive, not mandatory", () => {
  it("two or more visible cards are OFFER_VISIBLE even with no detected control", () => {
    const next = advanceOfferSurface(
      createOfferSurfaceState(),
      visible({ blueControlPresent: false, blueControlConfidence: 0, validCardCount: 3 }),
    );
    expect(next.state).toBe("OFFER_VISIBLE");
    expect(next.render).toBe(true);
  });

  it("two visible cards (one mid-reroll) stay OFFER_VISIBLE without the control", () => {
    const prior = advanceOfferSurface(createOfferSurfaceState(), visible());
    const next = advanceOfferSurface(
      prior,
      visible({ now: 200, validCardCount: 2, blueControlPresent: false }),
    );
    expect(next.state).toBe("OFFER_VISIBLE");
    expect(next.render).toBe(true);
  });

  it("a tooltip hiding the control keeps OFFER_VISIBLE and does not advance the generation", () => {
    const withControl = advanceOfferSurface(createOfferSurfaceState(), visible());
    const tooltipOpen = advanceOfferSurface(
      withControl,
      visible({ now: 200, blueControlPresent: false, blueControlConfidence: 0 }),
    );
    const tooltipClosed = advanceOfferSurface(tooltipOpen, visible({ now: 300 }));
    expect(tooltipOpen.state).toBe("OFFER_VISIBLE");
    expect(tooltipOpen.render).toBe(true);
    expect(tooltipClosed.state).toBe("OFFER_VISIBLE");
    // No generation churn: the same offer stayed visible throughout.
    expect(tooltipOpen.offerGeneration).toBe(withControl.offerGeneration);
    expect(tooltipClosed.offerGeneration).toBe(withControl.offerGeneration);
  });

  it("keeps the control decisive only when cards are absent (OFFER_HIDDEN vs NO_OFFER)", () => {
    const hidden = advanceOfferSurface(
      createOfferSurfaceState(),
      visible({ validCardCount: 0, hiddenEvidence: true, blueControlPresent: true }),
    );
    expect(hidden.state).toBe("OFFER_HIDDEN");
    const noOffer = advanceOfferSurface(
      createOfferSurfaceState(),
      visible({ validCardCount: 0, blueControlPresent: false }),
    );
    expect(noOffer.state).toBe("NO_OFFER");
  });
});
