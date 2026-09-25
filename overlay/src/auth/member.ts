import { invoke } from "@tauri-apps/api/core";
import type { DecisionModelConfig } from "../decision/model-config";

export interface MemberSnapshot {
  enabled: boolean;
  accessKind?: "member" | "trial" | "trial-lease";
  manifest?: {
    modelVersion: string;
    engineVersion: string;
    dataVersion: string;
    createdAt: string;
    configSha256: string;
    signature: string;
  };
  modelConfig?: DecisionModelConfig;
  lease?: {
    kind: string;
    gameHash: string;
    expiresAt: string;
  };
  error?: string;
}

export function memberRecommendationsVisible(
  collectorEnabled: boolean,
  member: Pick<MemberSnapshot, "enabled"> | null,
): boolean {
  return collectorEnabled && member?.enabled === true;
}

export function shouldVerifyGameStart(
  previousGameHash: string | null,
  currentGameHash: string | null,
): boolean {
  return currentGameHash !== null && previousGameHash !== currentGameHash;
}

export interface MemberVerificationRequest {
  epoch: number;
  gameHash: string;
  token: number;
}

export interface MemberVerificationOwnership {
  epoch: number;
  gameHash: string | null;
  token: number;
}

// A verifyMemberGameStart request is only safe to publish (success OR
// failure) if the epoch, authoritative game hash, and request token it
// captured before its await are all still current afterward. Any confirmed
// game boundary (new hash, backward game_time, confirmed close) bumps both
// epoch and token; a newer overlapping verification request bumps token
// alone — either invalidates an older in-flight request regardless of which
// promise settles first.
export function isMemberVerificationCurrent(
  request: MemberVerificationRequest,
  ownership: MemberVerificationOwnership,
): boolean {
  return (
    request.epoch === ownership.epoch &&
    request.gameHash === ownership.gameHash &&
    request.token === ownership.token
  );
}

export function disabledMember(error: string): MemberSnapshot {
  return { enabled: false, error };
}

// Explicit per-game member-verification lifecycle, separate from
// `activeGameHashRef` (authoritative game identity). `activeGameHashRef` must
// never be cleared just to force a retry — a hash change means a NEW game,
// which is a different concept from "this same game's verification needs
// another attempt". "verified" covers both a definitive grant AND a
// definitive denial: either way the recheck settled the hash, so this hash
// is never retried again — the actual grant/denial content lives entirely in
// the published `MemberSnapshot`, never in this state.
export type MemberVerificationState =
  | { status: "idle"; gameHash: null }
  | { status: "pending"; gameHash: string; epoch: number; token: number }
  | { status: "verified"; gameHash: string; epoch: number }
  | {
      status: "retryable";
      gameHash: string;
      epoch: number;
      nextAttemptAtMs: number;
      attempts: number;
    };

export const IDLE_MEMBER_VERIFICATION_STATE: MemberVerificationState = {
  status: "idle",
  gameHash: null,
};

// Deterministic bounded backoff: ~1.5s first retry, doubling thereafter,
// capped at 20s so one transient recheck failure can never silently disable
// member badges/coach for the rest of a valid match, while also never
// hammering a request every polling tick.
const MEMBER_VERIFICATION_RETRY_BASE_MS = 1500;
const MEMBER_VERIFICATION_RETRY_MAX_MS = 20_000;

export function memberVerificationRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    MEMBER_VERIFICATION_RETRY_BASE_MS * 2 ** exponent,
    MEMBER_VERIFICATION_RETRY_MAX_MS,
  );
}

export interface ShouldStartMemberVerificationInput {
  currentGameHash: string | null;
  verificationState: MemberVerificationState;
  nowMs: number;
  gameEpoch: number;
  runtimeEligible: boolean;
}

// Pure retry-eligibility gate. A hash/epoch this state was never captured
// for is always eligible (either genuinely idle, or a fresh identity the
// state doesn't know about yet) — poll() already handles the "hash actually
// changed" case itself via `shouldVerifyGameStart`, so in practice this is
// consulted for "hash unchanged, is a retry due" decisions, but it stays
// correct regardless of how it's called.
export function shouldStartMemberVerification(
  input: ShouldStartMemberVerificationInput,
): boolean {
  const { currentGameHash, verificationState, nowMs, gameEpoch, runtimeEligible } = input;
  if (!runtimeEligible || currentGameHash === null) return false;
  if (verificationState.status === "idle" || verificationState.gameHash !== currentGameHash) {
    return true;
  }
  // Same hash string, but this bookkeeping is from a game identity that has
  // since moved on (confirmed close, changed hash, or backward game_time all
  // bump the epoch) — superseded, never worth retrying under the old epoch.
  if (verificationState.epoch !== gameEpoch) return false;
  if (verificationState.status === "retryable") {
    return nowMs >= verificationState.nextAttemptAtMs;
  }
  return false; // pending or verified
}

export function bootstrapMember(): Promise<MemberSnapshot> {
  return invoke<MemberSnapshot>("member_bootstrap");
}

export function verifyMemberGameStart(gameHash: string): Promise<MemberSnapshot> {
  return invoke<MemberSnapshot>("member_game_start", { gameHash });
}

export interface MemberVerificationOwnershipReader {
  epoch: () => number;
  gameHash: () => string | null;
  token: () => number;
  // The coarse "is a game currently active" gate — false while runtime
  // capture/rendering is suspended for either a confirmed close or an
  // unconfirmed telemetry outage. Required in addition to epoch/hash/token
  // so a result that resolves mid-outage cannot make stale authorization
  // visible while capture is suspended.
  gameActive: () => boolean;
  // Current retry lifecycle for this hash, read fresh each call — never
  // cached across the awaits below.
  verificationState: () => MemberVerificationState;
  // Injected clock so retry deadlines are deterministic and testable without
  // sleeping; production passes `performance.now`.
  now: () => number;
}

export interface MemberVerificationEffects {
  setMemberSnapshot: (snapshot: MemberSnapshot) => void;
  verifyMemberGameStart: (gameHash: string) => Promise<MemberSnapshot>;
  // Must resolve to null rather than reject on failure — the recheck is a
  // fail-closed signal, not a control-flow exception. Also defensively
  // wrapped below in case an implementation violates that contract.
  recheckGameHash: () => Promise<string | null>;
  setVerificationState: (state: MemberVerificationState) => void;
}

// The detached, non-blocking member-verification worker: started via `void`
// from poll() and never awaited by it, so the single-flight poll lock
// releases immediately and a later poll stays free to detect a confirmed
// non-live close, a changed game hash, or backward game_time while this is
// still in flight — any of which invalidates `request` before it can
// publish. Safe to call directly in tests with injected effects/ownership,
// no React or Tauri runtime required.
export async function runMemberVerification(
  request: MemberVerificationRequest,
  ownership: MemberVerificationOwnershipReader,
  effects: MemberVerificationEffects,
): Promise<void> {
  const currentOwnership = (): MemberVerificationOwnership => ({
    epoch: ownership.epoch(),
    gameHash: ownership.gameHash(),
    token: ownership.token(),
  });
  if (!isMemberVerificationCurrent(request, currentOwnership())) return;
  const priorState = ownership.verificationState();
  const priorAttempts =
    priorState.status === "retryable" &&
    priorState.gameHash === request.gameHash &&
    priorState.epoch === request.epoch
      ? priorState.attempts
      : 0;
  effects.setMemberSnapshot(disabledMember("game-session-verification-pending"));
  effects.setVerificationState({
    status: "pending",
    gameHash: request.gameHash,
    epoch: request.epoch,
    token: request.token,
  });
  const snapshot = await effects.verifyMemberGameStart(request.gameHash).catch((error) =>
    disabledMember(error instanceof Error ? error.message : "game-session-verification-failed"),
  );
  // Second, independent fail-closed check: re-query the authoritative game
  // hash directly instead of trusting only the in-memory refs.
  const recheckedHash = await effects.recheckGameHash().catch(() => null);
  if (!isMemberVerificationCurrent(request, currentOwnership())) return;
  if (recheckedHash === request.gameHash && ownership.gameActive()) {
    effects.setVerificationState({
      status: "verified",
      gameHash: request.gameHash,
      epoch: request.epoch,
    });
    effects.setMemberSnapshot(snapshot);
    return;
  }
  if (recheckedHash !== null && recheckedHash !== request.gameHash) {
    // A different, non-null hash supersedes this request entirely. The
    // normal game-boundary path (poll's own hash comparison) owns
    // processing the new hash next tick; never mark the superseded hash
    // retryable.
    return;
  }
  // Inconclusive: a null recheck (including a caught throw or a timeout the
  // effect maps to null), or the recheck confirmed the same hash but runtime
  // ownership dropped mid-flight (an unconfirmed telemetry outage). Retry
  // the SAME hash later on a bounded backoff instead of leaving the UI stuck
  // pending — never grant authorization and never touch activeGameHashRef
  // or the game epoch.
  const attempts = priorAttempts + 1;
  effects.setMemberSnapshot(disabledMember("game-session-verification-retry"));
  effects.setVerificationState({
    status: "retryable",
    gameHash: request.gameHash,
    epoch: request.epoch,
    nextAttemptAtMs: ownership.now() + memberVerificationRetryDelayMs(attempts),
    attempts,
  });
}
