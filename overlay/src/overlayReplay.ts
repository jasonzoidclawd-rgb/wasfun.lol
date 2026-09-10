import {
  evaluateRoundContentCompletion,
  reduceRoundContentEmission,
  type DomAcknowledgement,
  type RoundContentResult,
  type SemanticPublication,
} from "./badgeLayerDiagnostic";
import {
  createOfferRoundOwnership,
  reduceOfferRoundOwnership,
  type OfferRoundOwner,
  type OfferRoundOwnership,
} from "./offerRoundOwnership";

interface ReplayFixture {
  schemaVersion: "overlay-replay/v1";
  sourceSessionId: string;
  initialState: { gameEpoch: number };
  actions: ReplayAction[];
}

type ReplayAction =
  | { atMs: number; type: "game-start"; championId: number }
  | { atMs: number; type: "offer-accepted"; offerGeneration: number }
  | { atMs: number; type: "publish"; publications: SemanticPublication[] }
  | { atMs: number; type: "clear"; offerGeneration: number }
  | { atMs: number; type: "confirmed-game-end" };

interface ReplayTimelineEntry {
  atMs: number;
  type: string;
  round?: number;
  offerGeneration?: number;
  acknowledgements?: DomAcknowledgement[];
  ownershipBeforeCleanup?: OfferRoundOwnership;
  ownershipAfterCleanup?: OfferRoundOwnership;
}

interface ReplayOutput {
  schemaVersion: "overlay-replay/v1";
  sourceSessionId: string;
  timeline: ReplayTimelineEntry[];
  publications: DomAcknowledgement[];
  roundResults: Array<{ round: number; result: RoundContentResult }>;
  gameResult: RoundContentResult;
  cleanupCount: number;
  finalState: {
    cards: DomAcknowledgement[];
    currentGame: number | null;
    currentChampion: number | null;
    currentOffer: OfferRoundOwner | null;
    ownership: OfferRoundOwnership;
  };
}

interface ReplayAdapters {
  render(publications: readonly SemanticPublication[]): DomAcknowledgement[];
}

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid overlay replay ${label}`);
  }
}

function immutableOwnershipSnapshot(ownership: OfferRoundOwnership): OfferRoundOwnership {
  const snapshot: OfferRoundOwnership = {
    activeOwner: ownership.activeOwner === null ? null : { ...ownership.activeOwner },
    pendingClosedOwner: ownership.pendingClosedOwner === null
      ? null
      : { ...ownership.pendingClosedOwner },
    completedOwners: ownership.completedOwners.map((owner) => ({ ...owner })),
  };
  if (snapshot.activeOwner !== null) Object.freeze(snapshot.activeOwner);
  if (snapshot.pendingClosedOwner !== null) Object.freeze(snapshot.pendingClosedOwner);
  snapshot.completedOwners.forEach(Object.freeze);
  Object.freeze(snapshot.completedOwners);
  return Object.freeze(snapshot);
}

/** Replay an owner-authored fixture without consulting any live overlay dependency. */
export function runOverlayReplay(
  fixture: ReplayFixture,
  adapters: ReplayAdapters,
): ReplayOutput {
  if (fixture.schemaVersion !== "overlay-replay/v1") {
    throw new Error("Unsupported overlay replay schema");
  }
  if (typeof fixture.sourceSessionId !== "string" || fixture.sourceSessionId.length === 0) {
    throw new Error("Invalid overlay replay sourceSessionId");
  }
  requireSafeInteger(fixture.initialState.gameEpoch, "gameEpoch");
  if (!Array.isArray(fixture.actions) || typeof adapters.render !== "function") {
    throw new Error("Invalid overlay replay fixture or adapters");
  }

  let ownership = createOfferRoundOwnership();
  let emittedOwnerKey: string | null = null;
  let lastAtMs = -1;
  let gameStarted = false;
  let gameEnded = false;
  let cleanupCount = 0;
  let currentGame: number | null = null;
  let currentChampion: number | null = null;
  let currentOffer: OfferRoundOwner | null = null;
  let cards: DomAcknowledgement[] = [];
  const acceptedOfferGenerations = new Set<number>();
  const timeline: ReplayTimelineEntry[] = [];
  const publications: DomAcknowledgement[] = [];
  const roundResults: Array<{ round: number; result: RoundContentResult }> = [];

  for (const action of fixture.actions) {
    requireSafeInteger(action.atMs, "action timestamp");
    if (action.atMs < lastAtMs) throw new Error("Overlay replay actions are out of order");
    lastAtMs = action.atMs;

    if (action.type === "game-start") {
      requireSafeInteger(action.championId, "championId");
      if (gameStarted || gameEnded) throw new Error("Overlay replay contains an invalid game start");
      gameStarted = true;
      currentGame = fixture.initialState.gameEpoch;
      currentChampion = action.championId;
      timeline.push({ atMs: action.atMs, type: "game-started" });
      continue;
    }

    if (!gameStarted) throw new Error("Overlay replay action precedes game start");
    if (gameEnded) {
      if (action.type === "confirmed-game-end") continue;
      throw new Error("Overlay replay action follows confirmed game end");
    }

    if (action.type === "offer-accepted") {
      requireSafeInteger(action.offerGeneration, "offerGeneration");
      if (acceptedOfferGenerations.has(action.offerGeneration)) {
        throw new Error("Overlay replay reused an offer generation");
      }
      if (ownership.activeOwner !== null) {
        throw new Error("Overlay replay accepted an offer before clearing the active owner");
      }
      ownership = reduceOfferRoundOwnership(ownership, {
        type: "accepted-offer",
        offerGeneration: action.offerGeneration,
      });
      if (ownership.activeOwner?.offerGeneration !== action.offerGeneration) {
        throw new Error("Overlay replay could not assign offer ownership");
      }
      currentOffer = { ...ownership.activeOwner };
      acceptedOfferGenerations.add(action.offerGeneration);
      timeline.push({
        atMs: action.atMs,
        type: "offer-accepted",
        round: ownership.activeOwner.round,
        offerGeneration: action.offerGeneration,
      });
      continue;
    }

    if (action.type === "publish") {
      const owner = ownership.activeOwner;
      if (owner === null) throw new Error("Overlay replay publication has no active owner");
      if (!Array.isArray(action.publications) || action.publications.some((publication) =>
        publication.gameEpoch !== fixture.initialState.gameEpoch ||
        publication.round !== owner.round ||
        publication.offerGeneration !== owner.offerGeneration
      )) {
        throw new Error("Overlay replay publication does not match the active owner");
      }

      const acknowledgements = adapters.render(action.publications);
      if (!Array.isArray(acknowledgements)) {
        throw new Error("Overlay replay renderer returned invalid acknowledgements");
      }
      cards = [...acknowledgements];
      const completionOwner = {
        gameEpoch: fixture.initialState.gameEpoch,
        round: owner.round,
        offerGeneration: owner.offerGeneration,
      };
      const decision = evaluateRoundContentCompletion({
        owner: completionOwner,
        expectedPublications: action.publications,
        domAcknowledgements: acknowledgements,
        renderedContainerCount: acknowledgements.length,
        schedulerHealthy: true,
      });
      const emission = reduceRoundContentEmission(emittedOwnerKey, completionOwner, decision);
      emittedOwnerKey = emission.emittedOwnerKey;
      if (emission.emit) {
        publications.push(...acknowledgements);
        roundResults.push({ round: owner.round, result: decision.result });
        timeline.push({
          atMs: action.atMs,
          type: "round-content-complete",
          round: owner.round,
          offerGeneration: owner.offerGeneration,
          acknowledgements,
        });
      }
      continue;
    }

    if (action.type === "clear") {
      requireSafeInteger(action.offerGeneration, "offerGeneration");
      const owner = ownership.activeOwner;
      if (owner?.offerGeneration !== action.offerGeneration) {
        throw new Error("Overlay replay clear does not match the active owner");
      }
      ownership = reduceOfferRoundOwnership(ownership, {
        type: "offer-closed",
        offerGeneration: action.offerGeneration,
      });
      currentOffer = null;
      cards = [];
      timeline.push({
        atMs: action.atMs,
        type: "offer-cleared",
        round: owner.round,
        offerGeneration: action.offerGeneration,
      });
      continue;
    }

    if (action.type !== "confirmed-game-end") {
      throw new Error("Overlay replay contains an unknown action");
    }
    const ownershipBeforeCleanup = immutableOwnershipSnapshot(ownership);
    ownership = createOfferRoundOwnership();
    const ownershipAfterCleanup = immutableOwnershipSnapshot(ownership);
    currentGame = null;
    currentChampion = null;
    currentOffer = null;
    cards = [];
    gameEnded = true;
    cleanupCount += 1;
    timeline.push({
      atMs: action.atMs,
      type: "game-ended",
      ownershipBeforeCleanup,
      ownershipAfterCleanup,
    });
  }

  if (!gameEnded) throw new Error("Overlay replay is missing confirmed game end");
  const gameResult = roundResults.length === 4 && roundResults.every(({ result }) => result === "PASS")
    ? "PASS"
    : roundResults.find(({ result }) => result !== "PASS")?.result ?? "FAIL_RENDER";

  return {
    schemaVersion: fixture.schemaVersion,
    sourceSessionId: fixture.sourceSessionId,
    timeline,
    publications,
    roundResults,
    gameResult,
    cleanupCount,
    finalState: {
      cards,
      currentGame,
      currentChampion,
      currentOffer,
      ownership,
    },
  };
}
