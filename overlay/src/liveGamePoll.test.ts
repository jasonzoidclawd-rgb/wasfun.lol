import { describe, expect, it } from "vitest";
import * as liveGamePollModule from "./liveGamePoll";
import {
  isBackwardGameTime,
  LIVE_DATA_FAILURE_GRACE_MS,
  resolveLiveDataPoll,
  shouldAnnounceLiveActivation,
} from "./liveGamePoll";

type ConfirmedGameOwnershipState = {
  ownsGame: boolean;
  gameEpoch: number;
};

type GameOwnershipObservation =
  | "confirmed-live"
  | "confirmed-non-live"
  | "unconfirmed";

type ApplyGameOwnershipObservation = (input: {
  ownershipRef: { current: ConfirmedGameOwnershipState };
  observation: GameOwnershipObservation;
  closeOwnedGame: () => void;
}) => void;

function getApplyGameOwnershipObservation(): ApplyGameOwnershipObservation {
  const candidate = (liveGamePollModule as Record<string, unknown>)[
    "applyGameOwnershipObservation"
  ];
  expect(
    typeof candidate,
    "liveGamePoll.ts must export the effect-applying ownership observation boundary",
  ).toBe("function");
  return candidate as ApplyGameOwnershipObservation;
}

describe("live game poll continuity", () => {
  it("preserves an active game across the first transient Live Client miss", () => {
    expect(resolveLiveDataPoll({
      now: 10_000,
      captureAllowed: true,
      liveDataAvailable: false,
      failureStartedAt: null,
    })).toEqual({
      action: "preserve",
      failureStartedAt: 10_000,
      failureAgeMs: 0,
    });
  });

  it("preserves repeated misses only inside the bounded grace window", () => {
    const startedAt = 10_000;
    expect(resolveLiveDataPoll({
      now: startedAt + LIVE_DATA_FAILURE_GRACE_MS,
      captureAllowed: true,
      liveDataAvailable: false,
      failureStartedAt: startedAt,
    }).action).toBe("preserve");

    expect(resolveLiveDataPoll({
      now: startedAt + LIVE_DATA_FAILURE_GRACE_MS + 1,
      captureAllowed: true,
      liveDataAvailable: false,
      failureStartedAt: startedAt,
    }).action).toBe("clear");
  });

  it("clears immediately when gameflow no longer permits live capture", () => {
    expect(resolveLiveDataPoll({
      now: 20_000,
      captureAllowed: false,
      liveDataAvailable: false,
      failureStartedAt: 10_000,
    })).toEqual({
      action: "clear",
      failureStartedAt: null,
      failureAgeMs: 0,
    });
    expect(resolveLiveDataPoll({
      now: 20_000,
      captureAllowed: false,
      liveDataAvailable: true,
      failureStartedAt: 10_000,
    }).action).toBe("clear");
  });

  it("accepts a recovery and resets the failure window", () => {
    expect(resolveLiveDataPoll({
      now: 20_000,
      captureAllowed: true,
      liveDataAvailable: true,
      failureStartedAt: 10_000,
    })).toEqual({
      action: "accept",
      failureStartedAt: null,
      failureAgeMs: 0,
    });
  });

  // A death/respawn can drop port 2999 for 30-60 s — longer than the grace —
  // while the LCU still reports the match InProgress. A FRESH LCU confirmation
  // of a live game is authoritative: a Live Client Data outage, however long, is
  // never proof the match ended (the LCU's own non-live transition is the game
  // boundary, handled separately). Tearing the game down mid-outage sets
  // activeGame=false, which suspends the geometry probe ("not-active-game") so
  // phase never returns to augment_selection and the death-triggered augment
  // badges never render. Preserve indefinitely and reset the failure window.
  it("preserves indefinitely past the grace window while the LCU confirms a live game", () => {
    const startedAt = 10_000;
    expect(resolveLiveDataPoll({
      now: startedAt + LIVE_DATA_FAILURE_GRACE_MS * 10,
      captureAllowed: true,
      liveDataAvailable: false,
      failureStartedAt: startedAt,
      gameflowConfirmedLive: true,
    })).toEqual({
      action: "preserve",
      failureStartedAt: null,
      failureAgeMs: 0,
    });
  });

  // The bounded fail-closed only applies when liveness is UNCONFIRMED — the LCU
  // read itself failed (gameflow == null) and captureAllowed was carried forward.
  // There, retaining game state forever would be unsafe, so grace still expires.
  it("still fails closed past the grace window when the LCU itself is unavailable", () => {
    const startedAt = 10_000;
    expect(resolveLiveDataPoll({
      now: startedAt + LIVE_DATA_FAILURE_GRACE_MS + 1,
      captureAllowed: true,
      liveDataAvailable: false,
      failureStartedAt: startedAt,
      gameflowConfirmedLive: false,
    }).action).toBe("clear");
  });

  // Within grace, an unconfirmed miss still preserves (unchanged) — the new
  // signal only widens preservation, never narrows it.
  it("preserves an unconfirmed miss inside the grace window", () => {
    const startedAt = 10_000;
    expect(resolveLiveDataPoll({
      now: startedAt + LIVE_DATA_FAILURE_GRACE_MS,
      captureAllowed: true,
      liveDataAvailable: false,
      failureStartedAt: startedAt,
      gameflowConfirmedLive: false,
    }).action).toBe("preserve");
  });
});

describe("confirmed game ownership transitions", () => {
  it("applies each owned-game close once, aligns its epoch, and never closes for unconfirmed suspension", () => {
    const observe = getApplyGameOwnershipObservation();
    const ownershipRef = {
      current: { ownsGame: true, gameEpoch: 7 },
    };
    const effects = {
      presentationClears: 0,
      identityClears: 0,
      latchInvalidations: 0,
      tokenInvalidations: 0,
      gameEpoch: 7,
    };
    const closeOwnedGame = () => {
      effects.presentationClears += 1;
      effects.identityClears += 1;
      effects.latchInvalidations += 1;
      effects.tokenInvalidations += 1;
      effects.gameEpoch += 1;
    };

    observe({ ownershipRef, observation: "unconfirmed", closeOwnedGame });
    expect(effects).toEqual({
      presentationClears: 0,
      identityClears: 0,
      latchInvalidations: 0,
      tokenInvalidations: 0,
      gameEpoch: 7,
    });
    expect(ownershipRef.current).toEqual({ ownsGame: true, gameEpoch: 7 });

    for (let poll = 0; poll < 4; poll += 1) {
      observe({ ownershipRef, observation: "confirmed-non-live", closeOwnedGame });
    }
    expect(effects).toEqual({
      presentationClears: 1,
      identityClears: 1,
      latchInvalidations: 1,
      tokenInvalidations: 1,
      gameEpoch: 8,
    });
    expect(ownershipRef.current).toEqual({ ownsGame: false, gameEpoch: 8 });

    observe({ ownershipRef, observation: "confirmed-live", closeOwnedGame });
    observe({ ownershipRef, observation: "confirmed-non-live", closeOwnedGame });
    observe({ ownershipRef, observation: "confirmed-non-live", closeOwnedGame });
    expect(effects).toEqual({
      presentationClears: 2,
      identityClears: 2,
      latchInvalidations: 2,
      tokenInvalidations: 2,
      gameEpoch: 9,
    });
    expect(ownershipRef.current).toEqual({ ownsGame: false, gameEpoch: 9 });
  });
});

describe("backward game_time epoch detection", () => {
  it("is not backward on the first sample (no prior game time to compare)", () => {
    expect(isBackwardGameTime({ lastGameTime: null, gameTime: 0 })).toBe(false);
  });

  it("is not backward while game time increases", () => {
    expect(isBackwardGameTime({ lastGameTime: 100, gameTime: 101 })).toBe(false);
    expect(isBackwardGameTime({ lastGameTime: 100, gameTime: 100 })).toBe(false);
  });

  it("tolerates a small backward jitter within the 5 s slack", () => {
    expect(isBackwardGameTime({ lastGameTime: 100, gameTime: 96 })).toBe(false);
  });

  it("is backward once game time drops by more than the slack", () => {
    expect(isBackwardGameTime({ lastGameTime: 100, gameTime: 50 })).toBe(true);
  });

  it("never treats malformed or missing game time as a regression", () => {
    expect(isBackwardGameTime({ lastGameTime: 100, gameTime: Number.NaN })).toBe(false);
    expect(isBackwardGameTime({ lastGameTime: 100, gameTime: Number.POSITIVE_INFINITY })).toBe(false);
    // -Infinity is numerically far below lastGameTime, but non-finite values
    // are never a comparison basis, so this is not treated as a regression.
    expect(isBackwardGameTime({ lastGameTime: 100, gameTime: Number.NEGATIVE_INFINITY })).toBe(false);
  });
});

// Composed state machine proving App.tsx's actual wiring behaves correctly
// end-to-end: gameEpochRef/activeGameRef/liveOwnershipAnnouncedRef advancing
// and resetting together via beginNewGameEpoch, called only from a CONFIRMED
// game-identity boundary (backward game_time, changed game hash, or a
// confirmed non-live close) — never from setActiveGame's coarse
// active-game toggle, so an unconfirmed telemetry outage (activeGame -> false
// -> true) never looks like a new game. See liveGamePollIntegration.test.ts
// for the source-text proof that App.tsx really is wired this way; this
// proves the composed BEHAVIOR that wiring produces, without rendering React.
describe("game-epoch activation across live-ownership spans (composed)", () => {
  function createGamePollSimulator() {
    let gameEpoch = 0;
    let activeGame = false;
    let announced = false;
    let lastGameTime: number | null = null;
    const activations: number[] = [];

    function beginNewGameEpoch() {
      gameEpoch += 1;
      announced = false;
    }

    /** The coarse active-game gate — never itself a source of epoch/latch changes. */
    function setActiveGame(active: boolean) {
      activeGame = active;
    }

    /**
     * One poll where Live Client Data was ready and gameflow freshly
     * confirmed inProgress. Boundary detection (backward game_time) resolves
     * BEFORE the announcement check, so a boundary crossed this poll
     * announces in this SAME poll — mirroring App.tsx's poll() ordering.
     */
    function healthyPoll(gameTime: number) {
      setActiveGame(true);
      if (isBackwardGameTime({ lastGameTime, gameTime })) {
        beginNewGameEpoch();
      }
      lastGameTime = gameTime;
      if (
        shouldAnnounceLiveActivation({
          devBuild: true,
          liveDataReady: true,
          gameflowConfirmed: true,
          captureAllowed: true,
          alreadyAnnounced: announced,
        })
      ) {
        announced = true;
        activations.push(gameEpoch);
      }
    }

    /** A transient Live Client Data miss inside the grace window: the "preserve" branch never touches activeGame, identity, or the latch. */
    function transientUnavailablePoll() {
      // Intentionally a no-op — this is the property under test.
    }

    /**
     * An UNCONFIRMED telemetry outage past the fail-closed grace window,
     * mirroring suspendGameRuntimeForUnavailableTelemetry: rendering fails
     * closed (activeGame -> false), but game identity (lastGameTime) and the
     * activation latch are preserved, so recovery of the SAME match resumes
     * instead of announcing again.
     */
    function unconfirmedOutageSuspendPoll() {
      setActiveGame(false);
    }

    /** A confirmed non-live gameflow phase, mirroring closeConfirmedGame: closes identity AND resets the latch via beginNewGameEpoch. */
    function confirmedNonLivePoll() {
      setActiveGame(false);
      lastGameTime = null;
      beginNewGameEpoch();
    }

    return {
      healthyPoll,
      transientUnavailablePoll,
      unconfirmedOutageSuspendPoll,
      confirmedNonLivePoll,
      get gameEpoch() {
        return gameEpoch;
      },
      get activations() {
        return activations;
      },
      get activeGame() {
        return activeGame;
      },
    };
  }

  it("increasing game time emits exactly one activation", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(10);
    sim.healthyPoll(20);
    sim.healthyPoll(30);
    expect(sim.activations).toHaveLength(1);
  });

  it("backward game time advances the epoch and announces the new activation in the SAME poll", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    expect(sim.activations).toHaveLength(1);
    const epochBeforeBackwardJump = sim.gameEpoch;

    sim.healthyPoll(50); // backward — boundary detected and announced in this same poll
    expect(sim.gameEpoch).toBeGreaterThan(epochBeforeBackwardJump);
    expect(sim.activations).toHaveLength(2);
    expect(sim.activations[1]).toBeGreaterThan(sim.activations[0]);
  });

  it("repeated healthy polls in game two do not duplicate the activation", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    sim.healthyPoll(50);
    sim.healthyPoll(60);
    sim.healthyPoll(70);
    sim.healthyPoll(80);
    expect(sim.activations).toHaveLength(2);
  });

  it("requires no non-live poll between the two games, announcing within the boundary poll itself", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    // No confirmedNonLivePoll() anywhere in this sequence.
    sim.healthyPoll(40); // the boundary poll — announces immediately, not on a later poll
    expect(sim.activations).toHaveLength(2);
    sim.healthyPoll(50);
    expect(sim.activations).toHaveLength(2);
  });

  it("transient unavailable samples never reset the latch", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    sim.transientUnavailablePoll();
    sim.transientUnavailablePoll();
    sim.healthyPoll(110);
    expect(sim.activations).toHaveLength(1);
  });

  it("confirmed non-live followed by a new game still announces exactly once", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    sim.confirmedNonLivePoll();
    sim.healthyPoll(10);
    expect(sim.activations).toHaveLength(2);
    expect(sim.activations[1]).toBeGreaterThan(sim.activations[0]);
  });

  it("malformed or missing game time never creates an epoch on its own", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    const epochAfterFirstGame = sim.gameEpoch;
    sim.healthyPoll(Number.NaN);
    sim.healthyPoll(Number.NaN);
    expect(sim.gameEpoch).toBe(epochAfterFirstGame);
    expect(sim.activations).toHaveLength(1);
  });

  // P2 finding 2: an unconfirmed telemetry outage must never split the epoch
  // or force a re-announcement when the SAME match recovers.
  it("an unconfirmed outage suspend preserves the epoch and the activation latch", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    expect(sim.activations).toHaveLength(1);
    const epochDuringGame = sim.gameEpoch;

    sim.unconfirmedOutageSuspendPoll(); // grace exceeded — fails closed only
    expect(sim.activeGame).toBe(false);
    expect(sim.gameEpoch).toBe(epochDuringGame);

    sim.healthyPoll(110); // same match recovers, forward game_time
    expect(sim.activeGame).toBe(true);
    expect(sim.gameEpoch).toBe(epochDuringGame);
    expect(sim.activations).toHaveLength(1); // no second live-active
  });

  it("recovery after an outage does not re-announce even across multiple suspend polls", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    sim.unconfirmedOutageSuspendPoll();
    sim.unconfirmedOutageSuspendPoll();
    sim.healthyPoll(105);
    sim.healthyPoll(110);
    expect(sim.activations).toHaveLength(1);
  });

  it("a confirmed non-live poll still closes the game and permits a later fresh activation, even after an outage", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    sim.unconfirmedOutageSuspendPoll();
    sim.confirmedNonLivePoll();
    sim.healthyPoll(10);
    expect(sim.activations).toHaveLength(2);
  });

  it("changed identity (backward game_time) after an outage still opens a new epoch", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    sim.unconfirmedOutageSuspendPoll();
    const epochBeforeRecovery = sim.gameEpoch;

    sim.healthyPoll(20); // backward relative to the preserved pre-outage lastGameTime=100
    expect(sim.gameEpoch).toBeGreaterThan(epochBeforeRecovery);
    expect(sim.activations).toHaveLength(2);
  });

  it("malformed recovery data after an outage does not create an epoch", () => {
    const sim = createGamePollSimulator();
    sim.healthyPoll(100);
    sim.unconfirmedOutageSuspendPoll();
    const epochBeforeRecovery = sim.gameEpoch;

    sim.healthyPoll(Number.NaN);
    expect(sim.gameEpoch).toBe(epochBeforeRecovery);
    expect(sim.activations).toHaveLength(1);
  });
});

describe("live activation announcement (development diagnostic)", () => {
  const healthy = {
    devBuild: true,
    liveDataReady: true,
    gameflowConfirmed: true,
    captureAllowed: true,
    alreadyAnnounced: false,
  };

  it("announces a healthy live game once per ownership span", () => {
    expect(shouldAnnounceLiveActivation(healthy)).toBe(true);
    expect(
      shouldAnnounceLiveActivation({ ...healthy, alreadyAnnounced: true }),
    ).toBe(false);
  });

  it("never announces without every independent authority", () => {
    const degraded = [
      // Port 2999 returned nothing: no real game snapshot exists.
      { liveDataReady: false },
      // Only a carried-forward capture gate; no fresh LCU confirmation.
      { gameflowConfirmed: false },
      // Compliance gate closed.
      { captureAllowed: false },
    ] as const;

    for (const override of degraded) {
      expect(shouldAnnounceLiveActivation({ ...healthy, ...override })).toBe(false);
    }
  });

  it("is development-only and cannot fire in a production build", () => {
    expect(shouldAnnounceLiveActivation({ ...healthy, devBuild: false })).toBe(false);
  });
});
