export interface OfferRoundOwner {
  offerGeneration: number;
  round: number;
}

export interface OfferRoundOwnership {
  activeOwner: OfferRoundOwner | null;
  pendingClosedOwner: OfferRoundOwner | null;
  completedOwners: OfferRoundOwner[];
}

type OfferRoundOwnershipEvent = {
  type: "accepted-offer" | "offer-closed" | "pick-confirmed" | "presentation-cleared";
  offerGeneration: number;
};

const TOTAL_ROUNDS = 4;

export function createOfferRoundOwnership(): OfferRoundOwnership {
  return {
    activeOwner: null,
    pendingClosedOwner: null,
    completedOwners: [],
  };
}

export function reduceOfferRoundOwnership(
  state: OfferRoundOwnership,
  event: OfferRoundOwnershipEvent,
): OfferRoundOwnership {
  if (event.type === "accepted-offer") {
    if (state.activeOwner?.offerGeneration === event.offerGeneration) return state;
    if (state.pendingClosedOwner?.offerGeneration === event.offerGeneration) {
      return {
        ...state,
        activeOwner: state.pendingClosedOwner,
        pendingClosedOwner: null,
      };
    }

    const priorOwner = state.activeOwner ?? state.pendingClosedOwner;
    const completedOwners = priorOwner == null
      ? state.completedOwners
      : [...state.completedOwners, priorOwner];
    const nextRound = completedOwners.length + 1;
    return {
      activeOwner: nextRound <= TOTAL_ROUNDS
        ? { offerGeneration: event.offerGeneration, round: nextRound }
        : null,
      pendingClosedOwner: null,
      completedOwners,
    };
  }

  if (event.type === "offer-closed") {
    if (state.activeOwner?.offerGeneration !== event.offerGeneration) return state;
    return {
      ...state,
      activeOwner: null,
      pendingClosedOwner: state.activeOwner,
    };
  }

  if (event.type === "presentation-cleared") {
    if (state.activeOwner?.offerGeneration !== event.offerGeneration) return state;
    return {
      ...state,
      activeOwner: null,
      pendingClosedOwner: null,
    };
  }

  if (state.activeOwner?.offerGeneration !== event.offerGeneration) return state;
  return {
    activeOwner: null,
    pendingClosedOwner: null,
    completedOwners: [...state.completedOwners, state.activeOwner],
  };
}
