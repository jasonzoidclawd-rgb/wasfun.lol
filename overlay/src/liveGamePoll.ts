/**
 * A short Live Client Data outage is not proof that the active match ended.
 * Death/respawn transitions can briefly make port 2999 unavailable even while
 * LCU still considers the game live. Preserve the last confirmed game state for
 * a bounded interval so geometry/OCR ownership survives that transient, then
 * fail closed if no usable player snapshot returns.
 */
// `get_live_player_data` performs three sequential requests with a 3 s native
// timeout each. Thirty seconds covers three worst-case poll attempts (27 s)
// without allowing an unavailable data source to retain game state indefinitely.
export const LIVE_DATA_FAILURE_GRACE_MS = 30_000;

export type LiveDataPollAction = "accept" | "preserve" | "clear";

export interface LiveDataPollDecision {
  action: LiveDataPollAction;
  failureStartedAt: number | null;
  failureAgeMs: number;
}

export interface ConfirmedGameOwnershipState {
  ownsGame: boolean;
  gameEpoch: number;
}

export interface ConfirmedGameOwnershipTransition {
  state: ConfirmedGameOwnershipState;
  closeOwnedGame: boolean;
}

export type GameOwnershipObservation =
  | "confirmed-live"
  | "confirmed-non-live"
  | "unconfirmed";

export function transitionConfirmedGameOwnership(
  state: ConfirmedGameOwnershipState,
  confirmedLive: boolean,
): ConfirmedGameOwnershipTransition {
  if (confirmedLive) {
    return {
      state: state.ownsGame ? state : { ...state, ownsGame: true },
      closeOwnedGame: false,
    };
  }

  if (!state.ownsGame) {
    return { state, closeOwnedGame: false };
  }

  return {
    state: { ownsGame: false, gameEpoch: state.gameEpoch + 1 },
    closeOwnedGame: true,
  };
}

export function applyGameOwnershipObservation(input: {
  ownershipRef: { current: ConfirmedGameOwnershipState };
  observation: GameOwnershipObservation;
  closeOwnedGame: () => void;
}): void {
  if (input.observation === "unconfirmed") return;

  const transition = transitionConfirmedGameOwnership(
    input.ownershipRef.current,
    input.observation === "confirmed-live",
  );
  input.ownershipRef.current = transition.state;
  if (transition.closeOwnedGame) input.closeOwnedGame();
}

export function resolveLiveDataPoll(input: {
  now: number;
  captureAllowed: boolean;
  liveDataAvailable: boolean;
  failureStartedAt: number | null;
  /**
   * The LCU gameflow FRESHLY confirmed a live match this poll (a non-null
   * sample reporting an in-progress game), as opposed to `captureAllowed` being
   * carried forward across a missing LCU read. When the LCU independently
   * confirms the match is live, a Live Client Data (port 2999) outage — even one
   * far longer than the grace window, as a death/respawn can cause — is never
   * proof the match ended, so the game is preserved indefinitely. The bounded
   * fail-closed below applies only when liveness is UNCONFIRMED (LCU also
   * unavailable), where retaining state forever would be unsafe.
   */
  gameflowConfirmedLive?: boolean;
  graceMs?: number;
}): LiveDataPollDecision {
  if (!input.captureAllowed) {
    return { action: "clear", failureStartedAt: null, failureAgeMs: 0 };
  }

  if (input.liveDataAvailable) {
    return { action: "accept", failureStartedAt: null, failureAgeMs: 0 };
  }

  if (input.gameflowConfirmedLive) {
    return { action: "preserve", failureStartedAt: null, failureAgeMs: 0 };
  }

  const failureStartedAt = input.failureStartedAt ?? input.now;
  const failureAgeMs = Math.max(0, input.now - failureStartedAt);
  const graceMs = input.graceMs ?? LIVE_DATA_FAILURE_GRACE_MS;
  return {
    action: failureAgeMs <= graceMs ? "preserve" : "clear",
    failureStartedAt,
    failureAgeMs,
  };
}

/**
 * The healthy live path returns early, so no `[game-poll]` record would ever
 * carry `gameflowPhase: "inProgress"` in a session with no Live Client Data
 * outage — a correct run then reads as incomplete lifecycle coverage. Announce
 * live ownership exactly once per span, and only when the poll holds EVERY
 * independent authority at the same time:
 *
 * - `liveDataReady`: port 2999 returned a real player snapshot, which no
 *   fixture, replay, lobby, or pre-game state can produce;
 * - `gameflowConfirmed`: a FRESH LCU sample this poll (a confirmed non-live
 *   phase has already cleared and returned, so a fresh sample here is
 *   `inProgress`) — a carried-forward `captureAllowed` alone never announces;
 * - `captureAllowed`: the compliance gate is open.
 *
 * Development-only: the record is a diagnostic, never product behavior.
 */
/**
 * A `game_time` that dropped means the previous game ended and a new one
 * started under the same live-ownership span (no confirmed non-live poll
 * necessarily lands in between). `lastGameTime` is null before the first
 * sample, which is continuity, not a regression. A non-finite `gameTime`
 * (missing/malformed) is never a comparison basis, so it can never manufacture
 * an epoch boundary on its own.
 */
export function isBackwardGameTime(input: {
  lastGameTime: number | null;
  gameTime: number;
}): boolean {
  return (
    input.lastGameTime !== null &&
    Number.isFinite(input.gameTime) &&
    input.gameTime + 5 < input.lastGameTime
  );
}

export function shouldAnnounceLiveActivation(input: {
  devBuild: boolean;
  liveDataReady: boolean;
  gameflowConfirmed: boolean;
  captureAllowed: boolean;
  alreadyAnnounced: boolean;
}): boolean {
  return (
    input.devBuild &&
    input.liveDataReady &&
    input.gameflowConfirmed &&
    input.captureAllowed &&
    !input.alreadyAnnounced
  );
}
