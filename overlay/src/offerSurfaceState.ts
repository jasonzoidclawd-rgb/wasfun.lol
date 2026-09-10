import { GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS } from "./surfaceGeometry";

export type OfferSurfaceKind =
  | "OFFER_VISIBLE"
  | "OFFER_HIDDEN"
  | "NO_OFFER"
  | "OCCLUDED"
  | "UNCERTAIN";

export interface OfferSurfaceEvidence {
  now: number;
  captureValid: boolean;
  blueControlPresent: boolean;
  blueControlConfidence: number;
  validCardCount: number;
  occlusionReason: string | null;
  /** True only after a genuine manually collapsed fixture validates the shape. */
  hiddenEvidence: boolean;
  /** Geometry proves a queued/new offer rather than a one-slot reroll. */
  newOfferEvidence: boolean;
}

export interface OfferSurfaceState {
  state: OfferSurfaceKind;
  offerGeneration: number;
  lastVisibleAt: number | null;
  render: boolean;
  retainIdentities: boolean;
  blueControlConfidence: number;
  validCardCount: number;
  occlusionReason: string | null;
  captureValid: boolean;
}

export function createOfferSurfaceState(): OfferSurfaceState {
  return {
    state: "NO_OFFER",
    offerGeneration: 0,
    lastVisibleAt: null,
    render: false,
    retainIdentities: false,
    blueControlConfidence: 0,
    validCardCount: 0,
    occlusionReason: null,
    captureValid: false,
  };
}

export function advanceOfferSurface(
  previous: OfferSurfaceState,
  evidence: OfferSurfaceEvidence,
): OfferSurfaceState {
  const common = {
    blueControlConfidence: evidence.blueControlConfidence,
    validCardCount: evidence.validCardCount,
    occlusionReason: evidence.occlusionReason,
    captureValid: evidence.captureValid,
  };

  if (evidence.occlusionReason !== null) {
    return {
      ...previous,
      ...common,
      state: "OCCLUDED",
      render: false,
      retainIdentities: previous.offerGeneration > 0,
    };
  }

  if (!evidence.captureValid) {
    const withinHealth = previous.render && previous.lastVisibleAt !== null &&
      evidence.now - previous.lastVisibleAt <= GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS;
    return {
      ...previous,
      ...common,
      state: "UNCERTAIN",
      render: withinHealth,
      retainIdentities: previous.offerGeneration > 0,
    };
  }

  // Authority: at least two structurally valid usable cards with no card-area
  // occlusion IS a visible offer. The blue central control is SUPPORTIVE
  // evidence only while cards are visible — never mandatory — so a tooltip
  // covering the control, or a control false-negative, can never leave
  // OFFER_VISIBLE or blank the resolved badges (failures A + E).
  if (evidence.validCardCount >= 2) {
    const freshGeneration = evidence.newOfferEvidence || previous.state === "NO_OFFER";
    return {
      ...common,
      state: "OFFER_VISIBLE",
      offerGeneration: previous.offerGeneration + (freshGeneration ? 1 : 0),
      lastVisibleAt: evidence.now,
      render: true,
      retainIdentities: true,
    };
  }

  // Cards absent: NOW the control is decisive. Control + genuine hidden evidence
  // is a collapsed offer; control alone (no hidden evidence) stays UNCERTAIN.
  if (
    evidence.hiddenEvidence &&
    evidence.blueControlPresent &&
    evidence.validCardCount === 0
  ) {
    return {
      ...common,
      state: "OFFER_HIDDEN",
      offerGeneration: previous.offerGeneration || 1,
      lastVisibleAt: previous.lastVisibleAt,
      render: false,
      retainIdentities: true,
    };
  }

  if (!evidence.blueControlPresent && evidence.validCardCount === 0) {
    return {
      ...common,
      state: "NO_OFFER",
      offerGeneration:
        previous.state === "NO_OFFER"
          ? previous.offerGeneration
          : previous.offerGeneration + 1,
      lastVisibleAt: null,
      render: false,
      retainIdentities: false,
    };
  }

  const withinHealth = previous.render && previous.lastVisibleAt !== null &&
    evidence.now - previous.lastVisibleAt <= GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS;
  return {
    ...previous,
    ...common,
    state: "UNCERTAIN",
    render: withinHealth,
    retainIdentities: previous.offerGeneration > 0,
  };
}

export function renderPublicationAllowed(
  resultOfferGeneration: number,
  current: OfferSurfaceState,
): boolean {
  return current.render && current.offerGeneration === resultOfferGeneration;
}
