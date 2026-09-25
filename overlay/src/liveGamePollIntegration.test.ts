import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  disabledMember,
  IDLE_MEMBER_VERIFICATION_STATE,
  runMemberVerification,
  shouldStartMemberVerification,
  shouldVerifyGameStart,
  type MemberSnapshot,
  type MemberVerificationState,
} from "./auth/member";

describe("live game poll integration", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  it("preserves current game ownership when the bounded policy accepts a transient miss", () => {
    expect(app).toContain("resolveLiveDataPoll({");
    expect(app).toContain('if (liveDataDecision.action === "preserve") return;');
    expect(app).toContain('emitNativeDiagnostic("[game-poll]"');
    expect(app.indexOf("if (data && gameflowCaptureAllowedRef.current) {")).toBeLessThan(
      app.indexOf("setActiveGame(true);"),
    );
  });

  // REGRESSION GUARD (death-triggered augment badges): a non-null gameflow at the
  // resolveLiveDataPoll call site is a FRESH live-match confirmation (a confirmed
  // non-live phase already returned via shouldClearOcrStateForGameflow). Feeding
  // it to gameflowConfirmedLive is what preserves the game through an arbitrarily
  // long port-2999 outage (death/respawn) instead of clearing after grace —
  // clearing sets activeGame=false, which skips the geometry probe
  // ("not-active-game") so phase never returns to augment_selection and the R2/R3/R4
  // badges never render. Do not drop this signal.
  it("feeds fresh LCU gameflow confirmation into the live-data policy", () => {
    expect(app).toContain("gameflowConfirmedLive: gameflow != null,");
  });
});

// REGRESSION GUARD (cross-game analyzer merge): gameEpochRef and the
// liveOwnershipAnnouncedRef announcement latch must advance and reset
// together at every CONFIRMED game-epoch boundary. A raw
// `gameEpochRef.current += 1` outside beginNewGameEpoch's own definition
// would bump the epoch counter without clearing the latch, silently
// reintroducing the bug where a second live game emits no fresh
// `live-active` diagnostic.
describe("centralized game-epoch advancement", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  it("defines a single beginNewGameEpoch callback that bumps the epoch, clears the announcement latch, and resets per-game latches", () => {
    expect(app).toContain(
      "const beginNewGameEpoch = useCallback(() => {\n" +
        "    gameEpochRef.current += 1;\n" +
        "    liveOwnershipAnnouncedRef.current = false;\n" +
        "    ocrSelectionCompletedRef.current = true;\n" +
        "    completedRoundsRef.current = 0;\n" +
        "    offerRoundOwnershipRef.current = createOfferRoundOwnership();\n" +
        "    setPickedAugments([]);\n" +
        "    lastRecordedRoundRef.current = \"\";\n" +
        "    memberVerificationTokenRef.current += 1;\n" +
        "    memberVerificationStateRef.current = IDLE_MEMBER_VERIFICATION_STATE;\n" +
        "  }, []);",
    );
  });

  it("never advances the epoch counter anywhere outside beginNewGameEpoch's own definition", () => {
    const rawIncrements = app.match(/gameEpochRef\.current \+= 1/g) ?? [];
    expect(rawIncrements).toHaveLength(1);
  });

  // REGRESSION GUARD (P2 finding 2): setActiveGame toggling activeGameRef must
  // never itself bump the epoch or reset the latch — a telemetry outage fails
  // this closed (activeGame -> false) without proving the match ended, and
  // recovery (activeGame -> true) must not look like a new game.
  it("setActiveGame is a plain ref assignment with no epoch side effect", () => {
    expect(app).toContain(
      "const setActiveGame = useCallback((active: boolean) => {\n" +
        "    activeGameRef.current = active;\n" +
        "  }, []);",
    );
    expect(app).not.toMatch(/const setActiveGame[\s\S]{0,200}beginNewGameEpoch/);
  });

  it("routes a backward game_time regression through isBackwardGameTime + beginNewGameEpoch, before the live-active check", () => {
    const boundaryCheck = app.indexOf(
      "if (isBackwardGameTime({ lastGameTime, gameTime: data.game_time })) {",
    );
    expect(boundaryCheck).toBeGreaterThan(-1);
    const activationCheck = app.indexOf("shouldAnnounceLiveActivation({", boundaryCheck);
    expect(activationCheck).toBeGreaterThan(boundaryCheck);
    expect(app.indexOf("beginNewGameEpoch();", boundaryCheck)).toBeLessThan(activationCheck);
  });

  it("routes a changed game hash (explicit session identity change) through beginNewGameEpoch, before the live-active check", () => {
    expect(app).toContain("shouldVerifyGameStart(activeGameHashRef.current, gameHash)");
    const hashBranch = app.indexOf(
      "shouldVerifyGameStart(activeGameHashRef.current, gameHash)",
    );
    const nextHashAssignment = app.indexOf(
      "activeGameHashRef.current = gameHash;",
      hashBranch,
    );
    const activationCheck = app.indexOf("shouldAnnounceLiveActivation({", hashBranch);
    expect(nextHashAssignment).toBeGreaterThan(hashBranch);
    expect(nextHashAssignment).toBeLessThan(activationCheck);
    expect(app.indexOf("beginNewGameEpoch();", hashBranch)).toBeLessThan(activationCheck);
  });

  // REGRESSION GUARD (P2 finding 1): both boundary checks — and their
  // beginNewGameEpoch call, if a boundary fired — must resolve before the
  // live-active activation check, so a boundary detected mid-poll announces
  // in that SAME poll rather than the next one.
  it("resolves both boundary signals into a single guarded beginNewGameEpoch call before the activation check", () => {
    const gameHashFetch = app.indexOf('await invoke<string | null>("get_game_hash")');
    const activationCheck = app.indexOf("shouldAnnounceLiveActivation({", gameHashFetch);
    const guardedCall = app.indexOf(
      "if (newGameBoundaryDetected) {\n" +
        "            beginNewGameEpoch();\n" +
        "            stopOcr();\n" +
        "          }",
      gameHashFetch,
    );
    expect(gameHashFetch).toBeGreaterThan(-1);
    expect(guardedCall).toBeGreaterThan(gameHashFetch);
    expect(guardedCall).toBeLessThan(activationCheck);
  });

  // REGRESSION GUARD (P2 finding 1): member verification is downstream
  // game-two work — it must not run before the activation record for a
  // boundary detected this poll.
  it("defers member verification until after the live-active activation emission", () => {
    const activationEmission = app.indexOf('action: "live-active",');
    const memberVerification = app.indexOf("if (verifyGameHash) {", activationEmission);
    expect(activationEmission).toBeGreaterThan(-1);
    expect(memberVerification).toBeGreaterThan(activationEmission);
  });

  it("beginNewGameEpoch is invoked at exactly the two known confirmed-boundary call sites", () => {
    const invocations = app.match(/beginNewGameEpoch\(\);/g) ?? [];
    expect(invocations).toHaveLength(2);
  });

  // REGRESSION GUARD (P2 finding 2): the confirmed non-live close and the
  // unconfirmed grace-exceeded suspend must route through structurally
  // distinct operations — only the confirmed close may reach
  // beginNewGameEpoch.
  it("routes confirmed non-live gameflow through closeConfirmedGame", () => {
    expect(app).toContain('closeConfirmedGame(clientFound ? "client_found" : "idle");');
  });

  it("routes an unconfirmed grace-exceeded outage through suspendGameRuntimeForUnavailableTelemetry, never closeConfirmedGame", () => {
    expect(app).toContain(
      'suspendGameRuntimeForUnavailableTelemetry(clientFound ? "client_found" : "idle");',
    );
    expect(app).toContain('suspendGameRuntimeForUnavailableTelemetry("idle");');
    const suspendDefinition = app.indexOf(
      "const suspendGameRuntimeForUnavailableTelemetry = useCallback((nextPhase: Phase) => {",
    );
    const suspendBodyEnd = app.indexOf("}, [clearGameRenderState]);", suspendDefinition);
    expect(suspendDefinition).toBeGreaterThan(-1);
    expect(app.slice(suspendDefinition, suspendBodyEnd)).not.toContain("beginNewGameEpoch");
  });

  it("closeConfirmedGame resets game identity and routes through beginNewGameEpoch", () => {
    expect(app).toContain(
      "const closeConfirmedGame = useCallback((nextPhase: Phase) => {\n" +
        "    clearGameRenderState(nextPhase);\n" +
        "    lastGameTimeRef.current = null;\n" +
        "    lastRecordedRoundRef.current = \"\";\n" +
        "    activeGameHashRef.current = null;\n" +
        "    beginNewGameEpoch();\n" +
        "  }, [clearGameRenderState, beginNewGameEpoch]);",
    );
  });

  it("routes the concrete confirmed-non-live branch through the effect-applying boundary with the real ownership ref and close callback", () => {
    const nonLiveBranchStart = app.indexOf("if (shouldClearOcrStateForGameflow(gameflow)) {");
    const nonLiveBranchEnd = app.indexOf("let data: LivePlayerData | null = null;", nonLiveBranchStart);
    expect(nonLiveBranchStart).toBeGreaterThan(-1);
    expect(nonLiveBranchEnd).toBeGreaterThan(nonLiveBranchStart);
    const nonLiveBranch = app.slice(nonLiveBranchStart, nonLiveBranchEnd);
    expect(nonLiveBranch).toContain("applyGameOwnershipObservation({");
    expect(nonLiveBranch).toContain("ownershipRef: confirmedGameOwnershipRef,");
    expect(nonLiveBranch).toContain('observation: "confirmed-non-live",');
    expect(nonLiveBranch).toContain(
      'closeOwnedGame: () => closeConfirmedGame(clientFound ? "client_found" : "idle"),',
    );
  });

  it("routes the concrete confirmed-live branch through the same boundary with the real ownership ref and close callback", () => {
    const liveBranchStart = app.indexOf("if (data && gameflowCaptureAllowedRef.current) {");
    const liveBranchEnd = app.indexOf("const priorFailureStartedAt", liveBranchStart);
    expect(liveBranchStart).toBeGreaterThan(-1);
    expect(liveBranchEnd).toBeGreaterThan(liveBranchStart);
    const liveBranch = app.slice(liveBranchStart, liveBranchEnd);
    expect(liveBranch).toContain("applyGameOwnershipObservation({");
    expect(liveBranch).toContain("ownershipRef: confirmedGameOwnershipRef,");
    expect(liveBranch).toContain('observation: "confirmed-live",');
    expect(liveBranch).toContain('closeOwnedGame: () => closeConfirmedGame("idle"),');
  });

  it("imports and invokes the effect-applying boundary only at the two confirmed observation branches", () => {
    expect(app).toContain("applyGameOwnershipObservation,");
    expect(app.match(/applyGameOwnershipObservation\(\{/g) ?? []).toHaveLength(2);
  });

  it("imports isBackwardGameTime from the shared pure-function module", () => {
    expect(app).toContain("isBackwardGameTime,");
    expect(app).toContain('} from "./liveGamePoll";');
  });

  // REGRESSION GUARD (async stale-result rejection): runIdentityProbe must
  // capture gameEpochRef before its first await, and reject publication in
  // BOTH its success and failure paths if the epoch advanced while the probe
  // was in flight — otherwise a game-one OCR/identity result can publish
  // into game two after a boundary fires mid-probe.
  it("runIdentityProbe captures gameEpoch before awaiting and rejects stale publication on both its success and failure paths", () => {
    const probeStart = app.indexOf("const runIdentityProbe = useCallback(async (");
    expect(probeStart).toBeGreaterThan(-1);
    const epochCapture = app.indexOf("const gameEpoch = gameEpochRef.current;", probeStart);
    const firstAwait = app.indexOf("await invoke", probeStart);
    expect(epochCapture).toBeGreaterThan(probeStart);
    expect(epochCapture).toBeLessThan(firstAwait);

    const staleChecks = app
      .slice(probeStart)
      .match(/if \(gameEpoch !== gameEpochRef\.current\) return;/g) ?? [];
    expect(staleChecks).toHaveLength(2);
  });

  // REGRESSION GUARD (member-verification must not block the single-flight
  // poll): verifyMemberGameStart's stale-rejection semantics themselves are
  // now proven behaviorally against the real runMemberVerification function
  // in ./auth/member.test.ts (dependency-injected, no regex needed). What
  // remains to prove here is the WIRING — that poll() never awaits the
  // detached helper, so pollInFlightRef cannot be held hostage by a pending
  // verification.
  describe("member-verification is detached from the single-flight poll", () => {
    const verifyBranchStart = app.indexOf("if (verifyGameHash) {");

    it("captures the verification request synchronously and fires startMemberVerification without awaiting it", () => {
      expect(verifyBranchStart).toBeGreaterThan(-1);
      const branchEnd = app.indexOf("setPlayerData(data);", verifyBranchStart);
      const branchText = app.slice(verifyBranchStart, branchEnd);
      expect(branchText).toContain("const verificationRequest: MemberVerificationRequest = {");
      expect(branchText).toContain("token: ++memberVerificationTokenRef.current,");
      expect(branchText).toContain("void startMemberVerification(verificationRequest);");
      // No await anywhere in the branch — the kickoff must be fire-and-forget.
      expect(branchText).not.toMatch(/\bawait\b/);
    });

    it("startMemberVerification delegates to the real runMemberVerification with live refs, not an inline await chain", () => {
      const def = app.indexOf("const startMemberVerification = useCallback(");
      const defEnd = app.indexOf("[],\n  );", def);
      expect(def).toBeGreaterThan(-1);
      const body = app.slice(def, defEnd);
      expect(body).toContain("runMemberVerification(");
      expect(body).toContain("epoch: () => gameEpochRef.current,");
      expect(body).toContain("gameHash: () => activeGameHashRef.current,");
      expect(body).toContain("token: () => memberVerificationTokenRef.current,");
      expect(body).toContain("gameActive: () => activeGameRef.current,");
      expect(body).toContain(
        'recheckGameHash: () => invoke<string | null>("get_game_hash").catch(() => null),',
      );
      // The useCallback itself must not be `async` / must not await the
      // promise it returns — it hands the promise straight back to the
      // fire-and-forget `void startMemberVerification(...)` call site.
      expect(app.slice(def, def + 40)).not.toContain("async");
    });

    it("imports runMemberVerification from the shared, dependency-injected auth/member module", () => {
      expect(app).toContain("runMemberVerification,");
      expect(app).toContain('} from "./auth/member";');
    });

    // Scenario: a confirmed non-live close invalidates an in-flight
    // verification. closeConfirmedGame routes through beginNewGameEpoch
    // (proven above), and beginNewGameEpoch bumps memberVerificationTokenRef
    // — composing the two proves a confirmed close invalidates any in-flight
    // member-verification token.
    it("beginNewGameEpoch bumps memberVerificationTokenRef, invalidating any in-flight verification", () => {
      expect(app).toContain("memberVerificationTokenRef.current += 1;");
      const beginDef = app.indexOf("const beginNewGameEpoch = useCallback(() => {");
      const beginBody = app.indexOf("}, []);", beginDef);
      expect(beginDef).toBeGreaterThan(-1);
      expect(app.slice(beginDef, beginBody)).toContain("memberVerificationTokenRef.current += 1;");
    });

    // Scenario: an unconfirmed telemetry outage/recovery within the same
    // game must not invalidate an in-flight member-verification request —
    // suspendGameRuntimeForUnavailableTelemetry must never touch
    // memberVerificationTokenRef (it already never calls beginNewGameEpoch,
    // proven above). Instead, the outage is caught by the gameActive() check
    // inside runMemberVerification, proven behaviorally in member.test.ts.
    it("suspendGameRuntimeForUnavailableTelemetry never touches memberVerificationTokenRef", () => {
      const suspendDefinition = app.indexOf(
        "const suspendGameRuntimeForUnavailableTelemetry = useCallback((nextPhase: Phase) => {",
      );
      const suspendBodyEnd = app.indexOf("}, [clearGameRenderState]);", suspendDefinition);
      expect(suspendDefinition).toBeGreaterThan(-1);
      expect(app.slice(suspendDefinition, suspendBodyEnd)).not.toContain(
        "memberVerificationTokenRef",
      );
    });

    // Scenario: component teardown invalidates any in-flight verification —
    // bumping the token makes runMemberVerification's post-recheck
    // isMemberVerificationCurrent check fail, so it never calls
    // setMemberSnapshot after unmount.
    it("component teardown bumps memberVerificationTokenRef alongside the other in-flight-work invalidations", () => {
      const teardownStart = app.indexOf("// Component teardown: invalidate any in-flight probe");
      const teardownEnd = app.indexOf("}, [bumpScanSeq]);", teardownStart);
      expect(teardownStart).toBeGreaterThan(-1);
      expect(app.slice(teardownStart, teardownEnd)).toContain(
        "memberVerificationTokenRef.current += 1;",
      );
    });
  });

  // P1 fix (requeue verification after an inconclusive authoritative hash
  // recheck): the retry-kickoff branch sits ALONGSIDE the changed-hash
  // boundary branch, not inside beginNewGameEpoch's territory. A retry of
  // the SAME game must never look like a new game boundary — it must not
  // reset the live-active announcement latch (which only beginNewGameEpoch
  // clears) and must not reassign activeGameHashRef (already correct).
  describe("member-verification retry-kickoff branch", () => {
    const retryBranchStart = app.indexOf("shouldStartMemberVerification({");
    const retryBranchEnd = app.indexOf(
      "verifyGameHash = gameHash;\n          }",
      retryBranchStart,
    );

    it("is wired as its own else-if branch alongside shouldVerifyGameStart, gated on memberBootstrapCompleteRef", () => {
      expect(retryBranchStart).toBeGreaterThan(-1);
      expect(retryBranchEnd).toBeGreaterThan(retryBranchStart);
      const branchText = app.slice(retryBranchStart, retryBranchEnd);
      expect(branchText).toContain("verificationState: memberVerificationStateRef.current,");
      expect(branchText).toContain("gameEpoch: gameEpochRef.current,");
      expect(branchText).toContain("runtimeEligible: gameflowCaptureAllowedRef.current,");
    });

    it("never calls beginNewGameEpoch or reassigns activeGameHashRef — a retry is never a new game boundary", () => {
      const branchText = app.slice(retryBranchStart, retryBranchEnd);
      expect(branchText).not.toContain("beginNewGameEpoch");
      expect(branchText).not.toContain("activeGameHashRef.current =");
    });

    it("reuses the same downstream verifyGameHash kickoff as the changed-hash branch (single request-construction site)", () => {
      const kickoffSites = app.match(/const verificationRequest: MemberVerificationRequest = \{/g) ?? [];
      expect(kickoffSites).toHaveLength(1);
    });
  });

  it("beginNewGameEpoch resets memberVerificationStateRef to idle, so a confirmed boundary (non-live close, changed hash, backward game_time) cannot leave a stale retryable/pending bookkeeping entry behind for the old game", () => {
    const beginDef = app.indexOf("const beginNewGameEpoch = useCallback(() => {");
    const beginBody = app.indexOf("}, []);", beginDef);
    expect(beginDef).toBeGreaterThan(-1);
    expect(app.slice(beginDef, beginBody)).toContain(
      "memberVerificationStateRef.current = IDLE_MEMBER_VERIFICATION_STATE;",
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PollRuntime {
  epoch: number;
  activeGameHash: string | null;
  token: number;
  verificationState: MemberVerificationState;
  gameActive: boolean;
  nowMs: number;
  publishedSnapshots: MemberSnapshot[];
}

// A minimal harness mirroring poll()'s gameHash-handling branch closely
// enough to prove the WIRING composition end to end: shouldVerifyGameStart
// for a genuinely new hash, shouldStartMemberVerification for a same-hash
// retry, both funneling into the same verifyGameHash -> runMemberVerification
// kickoff. The structural tests above prove App.tsx's actual source wires
// these same exported functions the same way; this proves the composition
// behaves correctly when actually run, with real (deferred) promises and an
// injected clock — never `Date.now()` or sleeping.
function createRuntime(): PollRuntime {
  return {
    epoch: 0,
    activeGameHash: null,
    token: 0,
    verificationState: IDLE_MEMBER_VERIFICATION_STATE,
    gameActive: true,
    nowMs: 0,
    publishedSnapshots: [],
  };
}

interface VerifyEffects {
  verifyMemberGameStart: () => Promise<MemberSnapshot>;
  recheckGameHash: () => Promise<string | null>;
}

function pollTick(runtime: PollRuntime, gameHash: string | null, verifyEffects: VerifyEffects) {
  let verifyGameHash: string | null = null;
  if (gameHash !== null && shouldVerifyGameStart(runtime.activeGameHash, gameHash)) {
    runtime.activeGameHash = gameHash;
    verifyGameHash = gameHash;
  } else if (
    gameHash !== null &&
    shouldStartMemberVerification({
      currentGameHash: gameHash,
      verificationState: runtime.verificationState,
      nowMs: runtime.nowMs,
      gameEpoch: runtime.epoch,
      runtimeEligible: runtime.gameActive,
    })
  ) {
    verifyGameHash = gameHash;
  }
  if (verifyGameHash === null) return null;

  const request = { epoch: runtime.epoch, gameHash: verifyGameHash, token: ++runtime.token };
  const done = runMemberVerification(
    request,
    {
      epoch: () => runtime.epoch,
      gameHash: () => runtime.activeGameHash,
      token: () => runtime.token,
      gameActive: () => runtime.gameActive,
      verificationState: () => runtime.verificationState,
      now: () => runtime.nowMs,
    },
    {
      setMemberSnapshot: (s) => runtime.publishedSnapshots.push(s),
      verifyMemberGameStart: verifyEffects.verifyMemberGameStart,
      recheckGameHash: verifyEffects.recheckGameHash,
      setVerificationState: (s) => {
        runtime.verificationState = s;
      },
    },
  );
  return { request, done };
}

describe("member-verification retry: deferred-promise poll simulation (P1 fix)", () => {
  it("requeues verification after an inconclusive recheck without ever blocking polling; only the retry publishes", async () => {
    const runtime = createRuntime();
    const order: string[] = [];

    // Step 1+2: poll detects game hash "hash-a"; verification request one
    // starts without blocking polling.
    const requestOneVerify = deferred<MemberSnapshot>();
    const requestOneRecheck = deferred<string | null>();
    const requestOne = pollTick(runtime, "hash-a", {
      verifyMemberGameStart: () => requestOneVerify.promise,
      recheckGameHash: () => requestOneRecheck.promise,
    });
    order.push("poll-one-fired-request-one");
    if (requestOne === null) throw new Error("expected request one to start");

    // Poll execution itself never blocks on the request: reaching this line
    // synchronously, without awaiting requestOne.done, proves it.
    order.push("poll-one-completed");

    // Step 3: verification response succeeds.
    requestOneVerify.resolve({ enabled: true, accessKind: "member" });
    // Step 4: the final authoritative recheck returns null — inconclusive.
    requestOneRecheck.resolve(null);
    await requestOne.done;

    // Step 5: request one is discarded and state becomes retryable, not
    // permanently pending.
    expect(runtime.verificationState.status).toBe("retryable");
    expect(runtime.publishedSnapshots).toEqual([
      disabledMember("game-session-verification-pending"),
      disabledMember("game-session-verification-retry"),
    ]);
    order.push("request-one-settled-retryable");

    // Step 6: another poll for hash-a runs before the deadline — no request.
    const retryState = runtime.verificationState;
    if (retryState.status !== "retryable") throw new Error("expected retryable");
    runtime.nowMs = retryState.nextAttemptAtMs - 1;
    const noRetry = pollTick(runtime, "hash-a", {
      verifyMemberGameStart: () => Promise.reject(new Error("must not be called before the deadline")),
      recheckGameHash: () => Promise.reject(new Error("must not be called before the deadline")),
    });
    expect(noRetry).toBeNull();
    order.push("poll-before-deadline-no-retry");

    // Step 7: clock advances beyond the retry deadline.
    runtime.nowMs = retryState.nextAttemptAtMs;

    // Step 8+9: another poll starts request two for hash-a; request two
    // rechecks hash-a.
    const requestTwoVerify = deferred<MemberSnapshot>();
    const requestTwoRecheck = deferred<string | null>();
    const requestTwo = pollTick(runtime, "hash-a", {
      verifyMemberGameStart: () => requestTwoVerify.promise,
      recheckGameHash: () => requestTwoRecheck.promise,
    });
    order.push("poll-two-fired-request-two");
    if (requestTwo === null) throw new Error("expected request two to start");
    order.push("poll-two-completed");

    // Step 10: request two publishes successfully.
    requestTwoVerify.resolve({ enabled: true, accessKind: "member" });
    requestTwoRecheck.resolve("hash-a");
    await requestTwo.done;

    // Assertions: only request two publishes the real snapshot (last entry).
    expect(runtime.publishedSnapshots.at(-1)).toEqual({ enabled: true, accessKind: "member" });
    expect(runtime.verificationState).toEqual({ status: "verified", gameHash: "hash-a", epoch: 0 });

    // Member state never remained permanently pending: pending -> retry ->
    // pending -> verified.
    const statuses = runtime.publishedSnapshots.map((s) => s.error ?? "verified");
    expect(statuses).toEqual([
      "game-session-verification-pending",
      "game-session-verification-retry",
      "game-session-verification-pending",
      "verified",
    ]);

    // Game epoch and authoritative hash are unchanged throughout — this was
    // a retry of the SAME game, never a new boundary.
    expect(runtime.epoch).toBe(0);
    expect(runtime.activeGameHash).toBe("hash-a");

    order.push("request-two-settled-verified");
    expect(order).toEqual([
      "poll-one-fired-request-one",
      "poll-one-completed",
      "request-one-settled-retryable",
      "poll-before-deadline-no-retry",
      "poll-two-fired-request-two",
      "poll-two-completed",
      "request-two-settled-verified",
    ]);
  });

  // NOTE: "an older request resolving after a retry begins cannot publish"
  // is covered in ./auth/member.test.ts by calling runMemberVerification
  // directly with a hand-bumped token. That scenario models component
  // teardown / an out-of-band token bump — pollTick's realistic
  // shouldStartMemberVerification gate correctly REFUSES to start a second
  // request for the same hash while the first is still "pending" (proven by
  // the "only one retry" test in member.test.ts), so it cannot be
  // reproduced through this harness's poll() simulation without bypassing
  // the very gate this fix adds.
});
