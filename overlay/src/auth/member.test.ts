import { describe, expect, it } from "vitest";
import {
  disabledMember,
  IDLE_MEMBER_VERIFICATION_STATE,
  isMemberVerificationCurrent,
  memberVerificationRetryDelayMs,
  runMemberVerification,
  shouldStartMemberVerification,
  type MemberSnapshot,
  type MemberVerificationState,
} from "./member";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A minimal, mutable stand-in for the refs App.tsx passes into
// runMemberVerification, so tests can mutate "ownership" mid-flight the same
// way a later poll's boundary detection (beginNewGameEpoch, a superseding
// verification request, or a suspend) would.
function createOwnership(initial: {
  epoch: number;
  gameHash: string | null;
  token: number;
  gameActive: boolean;
  verificationState?: MemberVerificationState;
  nowMs?: number;
}) {
  const state = {
    ...initial,
    verificationState: initial.verificationState ?? IDLE_MEMBER_VERIFICATION_STATE,
    nowMs: initial.nowMs ?? 0,
  };
  return {
    state,
    reader: {
      epoch: () => state.epoch,
      gameHash: () => state.gameHash,
      token: () => state.token,
      gameActive: () => state.gameActive,
      verificationState: () => state.verificationState,
      now: () => state.nowMs,
    },
    // Mirrors how App.tsx's setVerificationState effect writes back into
    // memberVerificationStateRef.current — mutating the same `state` object
    // the reader above reads from, so a test can drive a request through
    // pending -> retryable -> pending again exactly like production.
    setVerificationState: (next: MemberVerificationState) => {
      state.verificationState = next;
    },
  };
}

// verifyMemberGameStart is awaited in-poll for the boundary that triggered
// it. Its result (success OR failure) must only publish if the epoch,
// authoritative game hash, and request token it captured before the await
// are all still current afterward — otherwise a slow request for one game
// can resolve after the runtime has moved on and publish a stale snapshot
// into a game it no longer owns.
describe("isMemberVerificationCurrent", () => {
  it("discards a game-one verification that resolves successfully after game two begins", () => {
    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    // game two's boundary ran beginNewGameEpoch, bumping both epoch and token.
    const ownership = { epoch: 1, gameHash: "game-two", token: 2 };
    expect(isMemberVerificationCurrent(request, ownership)).toBe(false);
  });

  it("only the newest of two same-epoch requests publishes, regardless of settlement order", () => {
    const older = { epoch: 0, gameHash: "game-one", token: 1 };
    const newer = { epoch: 0, gameHash: "game-one", token: 2 };
    // Both requests were kicked off; the newer one is the last to capture the
    // token, so current ownership reflects token 2 no matter which promise
    // settles first.
    const ownership = { epoch: 0, gameHash: "game-one", token: 2 };
    expect(isMemberVerificationCurrent(older, ownership)).toBe(false);
    expect(isMemberVerificationCurrent(newer, ownership)).toBe(true);
  });

  it("publishes when epoch, hash, and token are all still current", () => {
    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const ownership = { epoch: 0, gameHash: "game-one", token: 1 };
    expect(isMemberVerificationCurrent(request, ownership)).toBe(true);
  });

  it("discards when the epoch is unchanged but the authoritative hash changed", () => {
    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const ownership = { epoch: 0, gameHash: "game-two", token: 1 };
    expect(isMemberVerificationCurrent(request, ownership)).toBe(false);
  });

  it("discards when the epoch changed even if the hash coincidentally matches", () => {
    const request = { epoch: 0, gameHash: "rematch-hash", token: 1 };
    // A confirmed boundary bumped epoch and token even though a rematch
    // happened to reuse the same lobby hash string.
    const ownership = { epoch: 1, gameHash: "rematch-hash", token: 2 };
    expect(isMemberVerificationCurrent(request, ownership)).toBe(false);
  });

  it("an unconfirmed telemetry outage and recovery within the same game does not invalidate an in-flight request", () => {
    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    // suspendGameRuntimeForUnavailableTelemetry never calls beginNewGameEpoch
    // and never touches the verification token, so ownership is unchanged
    // across an outage/recovery cycle.
    const ownership = { epoch: 0, gameHash: "game-one", token: 1 };
    expect(isMemberVerificationCurrent(request, ownership)).toBe(true);
  });
});

// P1 fix (member verification must not block game-boundary invalidation):
// runMemberVerification is the REAL function App.tsx's detached
// startMemberVerification delegates to — these are behavioral tests against
// the actual production logic (dependency-injected refs/effects), not
// source-text assertions, per the requirement to avoid source-text-only
// proof for this finding.
describe("runMemberVerification (behavioral, non-blocking)", () => {
  it("a later poll detecting confirmed non-live runs and invalidates ownership while verification is still pending; the eventual SUCCESS is discarded", async () => {
    const order: string[] = [];
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const verify = deferred<MemberSnapshot>();

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    // Fire the verification — NOT awaited here, exactly like poll()'s
    // `void startMemberVerification(request)`.
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => {
        snapshots.push(s);
        order.push(`publish:${s.enabled}`);
      },
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    // The caller (poll()) continues synchronously without waiting for
    // verification — proves polling is not blocked by the in-flight request.
    order.push("poll-one-completed");

    // A LATER poll runs here — while verification is still pending — and
    // detects confirmed non-live gameflow: closeConfirmedGame bumps both
    // gameEpochRef and (via beginNewGameEpoch) memberVerificationTokenRef,
    // and clears activeGameHashRef.
    order.push("poll-two-detects-confirmed-non-live");
    ownership.state.epoch += 1;
    ownership.state.token += 1;
    ownership.state.gameHash = null;
    ownership.state.gameActive = false;

    // Only now does the slow verification resolve successfully.
    verify.resolve({ enabled: true, accessKind: "member" });
    await verificationDone;

    // The pending-state publish happens synchronously (before the first
    // await), so it lands before poll() even continues past the fire-and-
    // forget call — proving the kickoff itself never blocks the caller.
    expect(order).toEqual([
      "publish:false",
      "poll-one-completed",
      "poll-two-detects-confirmed-non-live",
    ]);
    // Only the initial pending snapshot was published — never the stale
    // success.
    expect(snapshots).toEqual([disabledMember("game-session-verification-pending")]);
  });

  it("the same case with a FAILED verification result is discarded", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const verify = deferred<MemberSnapshot>();

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    // A later poll detects confirmed non-live while this is pending.
    ownership.state.epoch += 1;
    ownership.state.token += 1;
    ownership.state.gameHash = null;

    verify.reject(new Error("member_game_start unavailable"));
    await verificationDone;

    expect(snapshots).toEqual([disabledMember("game-session-verification-pending")]);
  });

  it("a later poll detects a changed game hash while the old request is pending; the old result is discarded", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const verify = deferred<MemberSnapshot>();

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    // A later poll observed a new game/session identity: an explicit
    // boundary — activeGameHashRef changes and the token bumps for the new
    // verification it kicks off.
    ownership.state.gameHash = "game-two";
    ownership.state.token += 1;

    verify.resolve({ enabled: true });
    await verificationDone;

    expect(snapshots).toEqual([disabledMember("game-session-verification-pending")]);
  });

  it("a later poll detects backward game_time while the old request is pending; the old result is discarded", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const verify = deferred<MemberSnapshot>();

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    // A backward valid game_time is its own confirmed boundary — it also
    // routes through beginNewGameEpoch, bumping epoch and token exactly like
    // the confirmed-non-live and changed-hash cases above.
    ownership.state.epoch += 1;
    ownership.state.token += 1;

    verify.resolve({ enabled: true });
    await verificationDone;

    expect(snapshots).toEqual([disabledMember("game-session-verification-pending")]);
  });

  it("a newer verification request supersedes an older one, regardless of settlement order", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const olderVerify = deferred<MemberSnapshot>();
    const newerVerify = deferred<MemberSnapshot>();

    const olderRequest = { epoch: 0, gameHash: "game-one", token: 1 };
    const olderDone = runMemberVerification(olderRequest, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push({ ...s, from: "older" } as MemberSnapshot),
      verifyMemberGameStart: () => olderVerify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    // A superseding verification request for the same epoch/hash bumps the
    // token before the older request's await resolves.
    ownership.state.token = 2;
    const newerRequest = { epoch: 0, gameHash: "game-one", token: 2 };
    const newerDone = runMemberVerification(newerRequest, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push({ ...s, from: "newer" } as MemberSnapshot),
      verifyMemberGameStart: () => newerVerify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    // Resolve OUT OF ORDER: the newer request settles first, the older
    // request settles last — the older must still lose.
    newerVerify.resolve({ enabled: true, accessKind: "member" });
    await newerDone;
    olderVerify.resolve({ enabled: true, accessKind: "trial" });
    await olderDone;

    const published = snapshots.filter((s) => s.error === undefined);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ from: "newer", accessKind: "member" });
  });

  it("same epoch, same hash, latest token: the result publishes", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const verify = deferred<MemberSnapshot>();

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    verify.resolve({ enabled: true, accessKind: "member" });
    await verificationDone;

    expect(snapshots.at(-1)).toEqual({ enabled: true, accessKind: "member" });
  });

  it("a discarded stale result cannot authorize member recommendations", async () => {
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const verify = deferred<MemberSnapshot>();
    let published: MemberSnapshot | null = null;

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => {
        published = s;
      },
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    ownership.state.token += 1; // superseded before it can resolve
    verify.resolve({ enabled: true, accessKind: "member" });
    await verificationDone;

    // published still holds only the pending/disabled snapshot — never the
    // stale enabled:true result, so nothing downstream (memberRecommendationsVisible,
    // badge rendering, offer publication) can read authorization from it.
    expect(published).toEqual(disabledMember("game-session-verification-pending"));
  });

  it("component teardown (token bump) prevents late publication", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const verify = deferred<MemberSnapshot>();

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    // Component teardown: the cleanup effect bumps memberVerificationTokenRef
    // exactly like a confirmed boundary would.
    ownership.state.token += 1;

    verify.resolve({ enabled: true });
    await verificationDone;

    expect(snapshots).toEqual([disabledMember("game-session-verification-pending")]);
    // Teardown leaves the verification state exactly where the synchronous
    // pending write left it — the stale-token guard prevents the late
    // resolution from ever reaching the retry/verified transition, so
    // nothing is left dangling that a (nonexistent, post-unmount) later poll
    // could act on.
    expect(ownership.state.verificationState).toEqual({
      status: "pending",
      gameHash: "game-one",
      epoch: 0,
      token: 1,
    });
  });

  it("an outage suspension does not publish stale authorization while rendering is disabled, even with epoch/hash/token unchanged", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const verify = deferred<MemberSnapshot>();

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve(ownership.state.gameHash),
      setVerificationState: ownership.setVerificationState,
    });

    // suspendGameRuntimeForUnavailableTelemetry: epoch/hash/token all stay
    // put (it never calls beginNewGameEpoch), but activeGameRef flips false
    // while capture/rendering is suspended.
    ownership.state.gameActive = false;

    verify.resolve({ enabled: true, accessKind: "member" });
    await verificationDone;

    // The recheck confirms the SAME hash, but the outage means ownership
    // cannot prove the game is still active — inconclusive, not a denial:
    // marked retryable (same game, same hash) rather than left stuck
    // pending or, worse, granted.
    expect(snapshots).toEqual([
      disabledMember("game-session-verification-pending"),
      disabledMember("game-session-verification-retry"),
    ]);
    expect(ownership.state.verificationState).toMatchObject({
      status: "retryable",
      gameHash: "game-one",
      epoch: 0,
    });
  });

  it("fails closed when the independent game-hash recheck returns a different hash than the captured request, even if refs still match", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const verify = deferred<MemberSnapshot>();

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => verify.promise,
      // Refs (ownership.state) never change, but the independent recheck
      // disagrees — the second fail-closed check must still block.
      recheckGameHash: () => Promise.resolve("a-different-hash"),
      setVerificationState: ownership.setVerificationState,
    });

    verify.resolve({ enabled: true });
    await verificationDone;

    expect(snapshots).toEqual([disabledMember("game-session-verification-pending")]);
    // A DIFFERENT non-null hash supersedes this request entirely — the
    // normal game-boundary path owns the new hash next tick, so the old
    // hash must never be marked retryable.
    expect(ownership.state.verificationState).toEqual({
      status: "pending",
      gameHash: "game-one",
      epoch: 0,
      token: 1,
    });
  });

  it("fails closed when the independent game-hash recheck itself fails (resolves null), and marks the hash retryable instead of leaving it stuck pending", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true, nowMs: 1000 });
    const verify = deferred<MemberSnapshot>();

    const request = { epoch: 0, gameHash: "game-one", token: 1 };
    const verificationDone = runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve(null),
      setVerificationState: ownership.setVerificationState,
    });

    verify.resolve({ enabled: true });
    await verificationDone;

    expect(snapshots).toEqual([
      disabledMember("game-session-verification-pending"),
      disabledMember("game-session-verification-retry"),
    ]);
    expect(ownership.state.verificationState).toEqual({
      status: "retryable",
      gameHash: "game-one",
      epoch: 0,
      nextAttemptAtMs: 1000 + memberVerificationRetryDelayMs(1),
      attempts: 1,
    });
  });

  it("does not even set the pending snapshot if the request is already stale at kickoff", async () => {
    const snapshots: MemberSnapshot[] = [];
    // Ownership already reflects a different game by the time this request
    // is (hypothetically) started — e.g. a delayed microtask race.
    const ownership = createOwnership({ epoch: 1, gameHash: "game-two", token: 2, gameActive: true });
    const request = { epoch: 0, gameHash: "game-one", token: 1 };

    await runMemberVerification(request, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => Promise.resolve({ enabled: true }),
      recheckGameHash: () => Promise.resolve("game-two"),
      setVerificationState: ownership.setVerificationState,
    });

    expect(snapshots).toEqual([]);
  });
});

// P1 fix (requeue verification after an inconclusive authoritative hash
// recheck): a bounded, deterministic backoff so one transient recheck
// failure never silently disables member badges/coach for the rest of a
// valid match, while also never firing a new request every polling tick.
describe("memberVerificationRetryDelayMs", () => {
  it("doubles per attempt starting at 1.5s and caps at 20s", () => {
    expect(memberVerificationRetryDelayMs(1)).toBe(1500);
    expect(memberVerificationRetryDelayMs(2)).toBe(3000);
    expect(memberVerificationRetryDelayMs(3)).toBe(6000);
    expect(memberVerificationRetryDelayMs(4)).toBe(12000);
    expect(memberVerificationRetryDelayMs(5)).toBe(20000);
    expect(memberVerificationRetryDelayMs(6)).toBe(20000);
    expect(memberVerificationRetryDelayMs(50)).toBe(20000);
  });
});

// P1 fix: the pure retry-eligibility gate. Behavioral unit tests per the
// requirement to avoid relying exclusively on source-text assertions for
// this finding's core decision logic.
describe("shouldStartMemberVerification", () => {
  const baseInput = {
    currentGameHash: "game-one",
    verificationState: IDLE_MEMBER_VERIFICATION_STATE,
    nowMs: 0,
    gameEpoch: 0,
    runtimeEligible: true,
  };

  it("is false when the runtime is not eligible (e.g. capture suspended for an outage)", () => {
    expect(shouldStartMemberVerification({ ...baseInput, runtimeEligible: false })).toBe(false);
  });

  it("is false when there is no current authoritative game hash", () => {
    expect(shouldStartMemberVerification({ ...baseInput, currentGameHash: null })).toBe(false);
  });

  it("is true for a genuinely idle state", () => {
    expect(shouldStartMemberVerification(baseInput)).toBe(true);
  });

  it("is true when the state belongs to a different (superseded) hash than the current one", () => {
    const verificationState: MemberVerificationState = {
      status: "retryable",
      gameHash: "game-zero",
      epoch: 0,
      nextAttemptAtMs: 0,
      attempts: 3,
    };
    expect(shouldStartMemberVerification({ ...baseInput, verificationState })).toBe(true);
  });

  it("is false while a request for the current hash/epoch is pending, regardless of how much time has passed", () => {
    const verificationState: MemberVerificationState = {
      status: "pending",
      gameHash: "game-one",
      epoch: 0,
      token: 3,
    };
    expect(shouldStartMemberVerification({ ...baseInput, verificationState, nowMs: 999_999 })).toBe(false);
  });

  it("is false once the current hash has settled to verified", () => {
    const verificationState: MemberVerificationState = {
      status: "verified",
      gameHash: "game-one",
      epoch: 0,
    };
    expect(shouldStartMemberVerification({ ...baseInput, verificationState, nowMs: 999_999 })).toBe(false);
  });

  it("is false for a retryable hash/epoch before its deadline", () => {
    const verificationState: MemberVerificationState = {
      status: "retryable",
      gameHash: "game-one",
      epoch: 0,
      nextAttemptAtMs: 5000,
      attempts: 1,
    };
    expect(shouldStartMemberVerification({ ...baseInput, verificationState, nowMs: 4999 })).toBe(false);
  });

  it("is true for a retryable hash/epoch once its deadline has elapsed (boundary inclusive)", () => {
    const verificationState: MemberVerificationState = {
      status: "retryable",
      gameHash: "game-one",
      epoch: 0,
      nextAttemptAtMs: 5000,
      attempts: 1,
    };
    expect(shouldStartMemberVerification({ ...baseInput, verificationState, nowMs: 5000 })).toBe(true);
    expect(shouldStartMemberVerification({ ...baseInput, verificationState, nowMs: 6000 })).toBe(true);
  });

  it("is false for a retryable state whose epoch no longer matches — superseded by a confirmed boundary (non-live close, changed hash, or backward game_time) even though the hash string coincidentally matches", () => {
    const verificationState: MemberVerificationState = {
      status: "retryable",
      gameHash: "game-one",
      epoch: 0,
      nextAttemptAtMs: 0,
      attempts: 5,
    };
    expect(shouldStartMemberVerification({ ...baseInput, verificationState, gameEpoch: 1, nowMs: 999_999 })).toBe(
      false,
    );
  });
});

// P1 fix: runMemberVerification's retry-lifecycle transitions. Each test
// drives the real, directly-callable implementation with injected
// ownership/effects — no React or Tauri runtime, no sleeping (the clock is
// the injected `nowMs`, exactly like the requirement demands.
describe("runMemberVerification retry lifecycle", () => {
  it("a first verification that reaches the final recheck and succeeds transitions idle -> pending -> verified and publishes the real snapshot", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });

    await runMemberVerification({ epoch: 0, gameHash: "game-one", token: 1 }, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => Promise.resolve({ enabled: true, accessKind: "member" }),
      recheckGameHash: () => Promise.resolve("game-one"),
      setVerificationState: ownership.setVerificationState,
    });

    expect(snapshots).toEqual([
      disabledMember("game-session-verification-pending"),
      { enabled: true, accessKind: "member" },
    ]);
    expect(ownership.state.verificationState).toEqual({
      status: "verified",
      gameHash: "game-one",
      epoch: 0,
    });
  });

  it("a rejected recheck promise is treated the same as a null recheck: retryable, not permanently pending, no unhandled rejection", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true, nowMs: 0 });

    await runMemberVerification({ epoch: 0, gameHash: "game-one", token: 1 }, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => Promise.resolve({ enabled: true, accessKind: "member" }),
      recheckGameHash: () => Promise.reject(new Error("transport failure")),
      setVerificationState: ownership.setVerificationState,
    });

    expect(snapshots).toEqual([
      disabledMember("game-session-verification-pending"),
      disabledMember("game-session-verification-retry"),
    ]);
    expect(ownership.state.verificationState).toMatchObject({
      status: "retryable",
      gameHash: "game-one",
      epoch: 0,
      attempts: 1,
    });
  });

  it("an unconfirmed telemetry outage (recheck confirms the hash but gameActive is false) is inconclusive: retryable, never verified, never authorizes rendering", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: false, nowMs: 500 });

    await runMemberVerification({ epoch: 0, gameHash: "game-one", token: 1 }, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => Promise.resolve({ enabled: true, accessKind: "member" }),
      recheckGameHash: () => Promise.resolve("game-one"),
      setVerificationState: ownership.setVerificationState,
    });

    expect(snapshots).toEqual([
      disabledMember("game-session-verification-pending"),
      disabledMember("game-session-verification-retry"),
    ]);
    expect(ownership.state.verificationState).toMatchObject({ status: "retryable", attempts: 1 });
  });

  it("a definitive denial (recheck confirms the hash, gameActive true, snapshot.enabled false) settles to verified and is never retried again", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });

    await runMemberVerification({ epoch: 0, gameHash: "game-one", token: 1 }, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => Promise.resolve(disabledMember("not-a-member")),
      recheckGameHash: () => Promise.resolve("game-one"),
      setVerificationState: ownership.setVerificationState,
    });

    expect(snapshots.at(-1)).toEqual(disabledMember("not-a-member"));
    expect(ownership.state.verificationState).toEqual({ status: "verified", gameHash: "game-one", epoch: 0 });
    // Never retried: a "verified" status (settled, regardless of grant vs
    // denial) is ineligible for another attempt at the same hash/epoch, no
    // matter how much time passes — no infinite retry loop on denial.
    expect(
      shouldStartMemberVerification({
        currentGameHash: "game-one",
        verificationState: ownership.state.verificationState,
        nowMs: 999_999,
        gameEpoch: 0,
        runtimeEligible: true,
      }),
    ).toBe(false);
  });

  it("consecutive inconclusive attempts for the same hash/epoch accumulate attempts and widen the backoff, bounded at the max", async () => {
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true, nowMs: 0 });

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await runMemberVerification(
        { epoch: 0, gameHash: "game-one", token: ownership.state.token },
        ownership.reader,
        {
          setMemberSnapshot: () => {},
          verifyMemberGameStart: () => Promise.resolve({ enabled: true }),
          recheckGameHash: () => Promise.resolve(null),
          setVerificationState: ownership.setVerificationState,
        },
      );

      const state = ownership.state.verificationState;
      if (state.status !== "retryable") throw new Error("expected retryable");
      expect(state.attempts).toBe(attempt);
      expect(state.nextAttemptAtMs - ownership.state.nowMs).toBe(memberVerificationRetryDelayMs(attempt));

      // Advance the clock to exactly the deadline and bump the token BEFORE
      // the next call, as poll() would for the next retry attempt.
      ownership.state.nowMs = state.nextAttemptAtMs;
      ownership.state.token += 1;
    }

    const final = ownership.state.verificationState;
    if (final.status !== "retryable") throw new Error("expected retryable");
    expect(final.attempts).toBe(6);
    expect(memberVerificationRetryDelayMs(final.attempts)).toBe(20_000);
  });

  it("attempts reset to 1 when the prior retryable state belonged to a different epoch (superseded by a confirmed boundary)", async () => {
    const ownership = createOwnership({
      epoch: 1,
      gameHash: "game-one",
      token: 5,
      gameActive: true,
      nowMs: 0,
      verificationState: { status: "retryable", gameHash: "game-one", epoch: 0, nextAttemptAtMs: 0, attempts: 4 },
    });

    await runMemberVerification({ epoch: 1, gameHash: "game-one", token: 5 }, ownership.reader, {
      setMemberSnapshot: () => {},
      verifyMemberGameStart: () => Promise.resolve({ enabled: true }),
      recheckGameHash: () => Promise.resolve(null),
      setVerificationState: ownership.setVerificationState,
    });

    const state = ownership.state.verificationState;
    if (state.status !== "retryable") throw new Error("expected retryable");
    expect(state.attempts).toBe(1);
  });

  it("only one retry is launched when multiple polls occur after the deadline — the kickoff synchronously flips status to pending before any await", async () => {
    const ownership = createOwnership({
      epoch: 0,
      gameHash: "game-one",
      token: 1,
      gameActive: true,
      nowMs: 10_000,
      verificationState: { status: "retryable", gameHash: "game-one", epoch: 0, nextAttemptAtMs: 5_000, attempts: 1 },
    });

    expect(
      shouldStartMemberVerification({
        currentGameHash: "game-one",
        verificationState: ownership.state.verificationState,
        nowMs: ownership.state.nowMs,
        gameEpoch: ownership.state.epoch,
        runtimeEligible: true,
      }),
    ).toBe(true);

    // As poll() does: capture the new token synchronously BEFORE kicking off
    // the request, so the request's own ownership check sees it as current.
    ownership.state.token = 2;
    const verify = deferred<MemberSnapshot>();
    const inFlight = runMemberVerification({ epoch: 0, gameHash: "game-one", token: 2 }, ownership.reader, {
      setMemberSnapshot: () => {},
      verifyMemberGameStart: () => verify.promise,
      recheckGameHash: () => Promise.resolve("game-one"),
      setVerificationState: ownership.setVerificationState,
    });

    // A second poll landing before the in-flight retry settles must see
    // "pending" and decline to start a third request for the same hash.
    expect(
      shouldStartMemberVerification({
        currentGameHash: "game-one",
        verificationState: ownership.state.verificationState,
        nowMs: ownership.state.nowMs,
        gameEpoch: ownership.state.epoch,
        runtimeEligible: true,
      }),
    ).toBe(false);

    verify.resolve({ enabled: true });
    await inFlight;
  });

  it("an older in-flight request's late recheck cannot overwrite the state a newer request already settled, nor publish", async () => {
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true });
    const snapshots: MemberSnapshot[] = [];
    const olderRecheck = deferred<string | null>();

    const olderDone = runMemberVerification({ epoch: 0, gameHash: "game-one", token: 1 }, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push({ ...s, from: "older" } as MemberSnapshot),
      verifyMemberGameStart: () => Promise.resolve({ enabled: true, accessKind: "trial" }),
      recheckGameHash: () => olderRecheck.promise,
      setVerificationState: ownership.setVerificationState,
    });

    // A superseding request for the same hash/epoch (e.g. the retry kickoff)
    // captures a new token before the older request's slow recheck resolves.
    ownership.state.token = 2;
    const newerDone = runMemberVerification({ epoch: 0, gameHash: "game-one", token: 2 }, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push({ ...s, from: "newer" } as MemberSnapshot),
      verifyMemberGameStart: () => Promise.resolve({ enabled: true, accessKind: "member" }),
      recheckGameHash: () => Promise.resolve("game-one"),
      setVerificationState: ownership.setVerificationState,
    });
    await newerDone;
    expect(ownership.state.verificationState).toEqual({ status: "verified", gameHash: "game-one", epoch: 0 });

    // Only now does the older request's recheck resolve.
    olderRecheck.resolve("game-one");
    await olderDone;

    const published = snapshots.filter((s) => s.error === undefined);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ from: "newer", accessKind: "member" });
    expect(ownership.state.verificationState).toEqual({ status: "verified", gameHash: "game-one", epoch: 0 });
  });

  it("end-to-end: an inconclusive first attempt followed by a successful retry after the deadline publishes normally and settles to verified", async () => {
    const snapshots: MemberSnapshot[] = [];
    const ownership = createOwnership({ epoch: 0, gameHash: "game-one", token: 1, gameActive: true, nowMs: 0 });

    await runMemberVerification({ epoch: 0, gameHash: "game-one", token: 1 }, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => Promise.resolve({ enabled: true, accessKind: "member" }),
      recheckGameHash: () => Promise.resolve(null),
      setVerificationState: ownership.setVerificationState,
    });

    const retryState = ownership.state.verificationState;
    if (retryState.status !== "retryable") throw new Error("expected retryable");

    // Before the deadline: no retry.
    expect(
      shouldStartMemberVerification({
        currentGameHash: "game-one",
        verificationState: ownership.state.verificationState,
        nowMs: retryState.nextAttemptAtMs - 1,
        gameEpoch: 0,
        runtimeEligible: true,
      }),
    ).toBe(false);

    // At/after the deadline: eligible.
    ownership.state.nowMs = retryState.nextAttemptAtMs;
    expect(
      shouldStartMemberVerification({
        currentGameHash: "game-one",
        verificationState: ownership.state.verificationState,
        nowMs: ownership.state.nowMs,
        gameEpoch: 0,
        runtimeEligible: true,
      }),
    ).toBe(true);

    ownership.state.token += 1;
    await runMemberVerification({ epoch: 0, gameHash: "game-one", token: ownership.state.token }, ownership.reader, {
      setMemberSnapshot: (s) => snapshots.push(s),
      verifyMemberGameStart: () => Promise.resolve({ enabled: true, accessKind: "member" }),
      recheckGameHash: () => Promise.resolve("game-one"),
      setVerificationState: ownership.setVerificationState,
    });

    expect(snapshots).toEqual([
      disabledMember("game-session-verification-pending"),
      disabledMember("game-session-verification-retry"),
      disabledMember("game-session-verification-pending"),
      { enabled: true, accessKind: "member" },
    ]);
    expect(ownership.state.verificationState).toEqual({ status: "verified", gameHash: "game-one", epoch: 0 });
  });
});
