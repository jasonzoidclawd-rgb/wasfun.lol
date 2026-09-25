import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_OCR_RETRY_MS,
  MAX_OCR_RETRY_MS,
  NATIVE_OCR_TIMEOUT_MS,
  OCR_WATCHDOG_CADENCE_MS,
  VISIBLE_SCANNING_FAILURES,
  OcrOwnerRegistry,
  executeOcrRun,
  failurePublication,
  nextRetryDelay,
  ownerCurrent,
  classifyStaleReject,
  staleRejectSlotDrift,
  requestedPendingStates,
  type OcrOwnerContext,
} from "./ocrOwner";
import { hammingDistance } from "./surfaceGeometry";

const FP = ["10".repeat(72), "1100".repeat(36), "1110".repeat(36)];

function context(overrides: Partial<OcrOwnerContext> = {}): OcrOwnerContext {
  return {
    foregroundEpoch: 1,
    gameEpoch: 2,
    championGeneration: 3,
    championId: "56",
    offerGeneration: 4,
    round: 1,
    requestedSlots: [0, 2],
    slotGenerations: [5, 6, 7],
    fingerprints: FP,
    ...overrides,
  };
}

type RoundOwnedContext = OcrOwnerContext & { round: number | null };

function roundContext(
  round: number | null,
  overrides: Partial<OcrOwnerContext> = {},
): RoundOwnedContext {
  return { ...context(overrides), round };
}

describe("explicit OCR owner", () => {
  it("documents the measured timeout, retry and watchdog policy", () => {
    expect(NATIVE_OCR_TIMEOUT_MS).toBe(2_000);
    expect(INITIAL_OCR_RETRY_MS).toBe(750);
    expect(MAX_OCR_RETRY_MS).toBe(6_000);
    expect(VISIBLE_SCANNING_FAILURES).toBe(2);
    expect(OCR_WATCHDOG_CADENCE_MS).toBe(150);
  });

  it("has at most one current owner and replacement invalidates the old run", () => {
    const owners = new OcrOwnerRegistry();
    const old = owners.start(context(), 100);
    const replacement = owners.start(context({ offerGeneration: 5 }), 200);
    expect(owners.current).toBe(replacement);
    expect(ownerCurrent(old, owners.current, context({ offerGeneration: 5 }))).toBe(false);
  });

  it.each([
    ["foreground loss", { foregroundEpoch: 2 }],
    ["active game ends", { gameEpoch: 3 }],
    ["champion changes", { championGeneration: 4, championId: "103" }],
    ["slot rerolls", { slotGenerations: [5, 6, 8] }],
    ["offer closes", { offerGeneration: 5 }],
    ["new chained offer", { offerGeneration: 6 }],
  ])("rejects publication when %s during OCR", (_label, overrides) => {
    const owners = new OcrOwnerRegistry();
    const owner = owners.start(context(), 100);
    expect(ownerCurrent(owner, owners.current, context(overrides))).toBe(false);
  });

  it("an old run cannot release a replacement owner", () => {
    const owners = new OcrOwnerRegistry();
    const old = owners.start(context(), 100);
    const replacement = owners.start(context(), 200);
    expect(owners.release(old.runId)).toBe(false);
    expect(owners.current).toBe(replacement);
    expect(owners.release(replacement.runId)).toBe(true);
    expect(owners.current).toBeNull();
  });

  it("timeout invalidates exactly that owner and late completion stays stale", () => {
    const owners = new OcrOwnerRegistry();
    const timedOut = owners.start(context(), 100);
    expect(owners.expire(timedOut.runId, timedOut.timeoutDeadline - 1)).toBe(false);
    expect(owners.expire(timedOut.runId, timedOut.timeoutDeadline)).toBe(true);
    const replacement = owners.start(context(), 3_000);
    expect(ownerCurrent(timedOut, owners.current, context())).toBe(false);
    expect(owners.current).toBe(replacement);
  });

  it("rejects a round-1 result after accepted ownership advances to round 2", () => {
    const owners = new OcrOwnerRegistry();
    const round1 = owners.start(roundContext(1), 100);

    expect(ownerCurrent(round1, owners.current, roundContext(2))).toBe(false);
  });

  it("keeps an unchanged accepted round current", () => {
    const owners = new OcrOwnerRegistry();
    const round2 = owners.start(roundContext(2), 100);

    expect(ownerCurrent(round2, owners.current, roundContext(2))).toBe(true);
  });

  it("a timed-out round-1 run cannot publish or release its round-2 replacement", () => {
    const owners = new OcrOwnerRegistry();
    const round1 = owners.start(roundContext(1), 0);
    expect(owners.expire(round1.runId, NATIVE_OCR_TIMEOUT_MS)).toBe(true);

    // Keep every pre-existing authority, including offerGeneration, equal. The
    // accepted round itself is sufficient to invalidate the late native result.
    const round2 = owners.start(roundContext(2), NATIVE_OCR_TIMEOUT_MS + 1);
    expect(ownerCurrent(round1, owners.current, roundContext(2))).toBe(false);
    expect(owners.release(round1.runId)).toBe(false);
    expect(owners.current).toBe(round2);
  });
});

describe("native timeout and failure recovery", () => {
  it("times out when the native OCR promise never resolves", async () => {
    vi.useFakeTimers();
    const result = executeOcrRun(
      () => new Promise<string>(() => {}),
      (value) => value,
      25,
    );
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toEqual({ kind: "failure", reason: "timeout" });
    vi.useRealTimers();
  });

  it("ignores a native completion that arrives after timeout", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const native = new Promise<string>((resolve) => { finish = resolve; });
    const result = executeOcrRun(() => native, (value) => value, 25);
    await vi.advanceTimersByTimeAsync(25);
    finish("late");
    await expect(result).resolves.toEqual({ kind: "failure", reason: "timeout" });
    vi.useRealTimers();
  });

  it("a timed-out run completing after replacement cannot release that replacement", () => {
    const owners = new OcrOwnerRegistry();
    const timedOut = owners.start(context(), 0);
    expect(owners.expire(timedOut.runId, NATIVE_OCR_TIMEOUT_MS)).toBe(true);
    const replacement = owners.start(context(), NATIVE_OCR_TIMEOUT_MS + 1);
    expect(owners.release(timedOut.runId)).toBe(false);
    expect(owners.current).toBe(replacement);
  });

  it("contains a synchronous native throw", async () => {
    await expect(executeOcrRun(
      () => { throw new Error("sync"); },
      (value) => value,
      25,
    )).resolves.toEqual({ kind: "failure", reason: "sync" });
  });

  it("contains an asynchronous native rejection", async () => {
    await expect(executeOcrRun(
      async () => { throw new Error("async"); },
      (value) => value,
      25,
    )).resolves.toEqual({ kind: "failure", reason: "async" });
  });

  it("contains identity matching failures", async () => {
    await expect(executeOcrRun(
      async () => "title",
      () => { throw new Error("match"); },
      25,
    )).resolves.toEqual({ kind: "failure", reason: "match" });
  });

  it("uses bounded exponential retry for one, two and five failures", () => {
    expect(nextRetryDelay(1)).toBe(750);
    expect(nextRetryDelay(2)).toBe(1_500);
    expect(nextRetryDelay(5)).toBe(6_000);
  });

  it("moves SCANNING to OCR ERROR and allows a later success", async () => {
    expect(failurePublication(1, 100)).toMatchObject({ state: "scanning" });
    expect(failurePublication(2, 100)).toMatchObject({ state: "scanning" });
    expect(failurePublication(3, 100)).toMatchObject({ state: "ocr-error" });
    expect(failurePublication(5, 100)).toMatchObject({ state: "ocr-error", failureCount: 5 });
    await expect(executeOcrRun(async () => "valid", (value) => value, 25)).resolves.toEqual({
      kind: "success",
      value: "valid",
    });
  });

  it("only requested slots enter pending state", () => {
    expect(requestedPendingStates([0, 2])).toEqual(["scanning", "unchanged", "scanning"]);
  });

  it("a long-idle new offer can start after an earlier timeout", () => {
    const owners = new OcrOwnerRegistry();
    const first = owners.start(context(), 0);
    expect(owners.expire(first.runId, NATIVE_OCR_TIMEOUT_MS)).toBe(true);
    const later = owners.start(context({ offerGeneration: 9 }), 60_000);
    expect(later.runId).toBeGreaterThan(first.runId);
    expect(owners.current).toBe(later);
  });
});

/**
 * The 2026-07-26 four-phase trace contained 11 `[identity-stale-reject]` events
 * carrying ONLY `{runId, reason: "owner-superseded-before-publication"}` — one
 * opaque reason for eight structurally different authorities. That is why the
 * trace could not answer "did OCR give up, or did the card legitimately change?"
 * and why the run was misread as zero recovery. `classifyStaleReject` names the
 * FIRST violated authority so the next trace is auditable per rejection.
 */
describe("stale-reject cause classification", () => {
  const owner = { ...context(), runId: 7, startedAt: 0, timeoutDeadline: 2_000 };

  it("returns null when nothing was violated", () => {
    expect(classifyStaleReject(owner, owner, context(), false)).toBeNull();
  });

  it("names each semantic authority in first-violated order", () => {
    const cases: Array<[Partial<OcrOwnerContext>, string]> = [
      [{ foregroundEpoch: 2 }, "foreground-epoch"],
      [{ gameEpoch: 3 }, "game-epoch"],
      [{ championId: "99" }, "champion-id"],
      [{ championGeneration: 4 }, "champion-generation"],
      [{ offerGeneration: 5 }, "offer-generation"],
      [{ slotGenerations: [6, 6, 7] }, "slot-generation"],
    ];
    for (const [overrides, expected] of cases) {
      expect(classifyStaleReject(owner, owner, context(overrides), false)).toBe(expected);
    }
  });

  it("never reports fingerprint drift, at any magnitude, on any slot", () => {
    // Drift is no longer an ownership authority, so it can no longer be a cause.
    // `current.fingerprints` is the accepted BASELINE, which the settlement
    // re-latch rewrites on its own schedule — rejecting a correct read because
    // the baseline moved is exactly the 2026-07-27 defect.
    const nudged = `${"01".repeat(4)}${FP[0].slice(8)}`; // 8 bits: sub-band
    const inverted = "0".repeat(144); // 144 bits: maximal
    for (const fingerprints of [
      [nudged, FP[1], FP[2]],
      [inverted, FP[1], FP[2]], // requested slot, total movement
      [FP[0], inverted, FP[2]], // an unrequested slot's card
      [inverted, inverted, inverted],
    ]) {
      expect(classifyStaleReject(owner, owner, context({ fingerprints }), false)).toBeNull();
    }
  });

  it("still reports the reroll that drift used to stand in for", () => {
    // A genuine replacement is not detected by comparing pixels here — the
    // confirmed-reroll path detects it and advances the counter, one line up.
    expect(
      classifyStaleReject(
        owner,
        owner,
        context({ slotGenerations: [7, 6, 6], fingerprints: ["0".repeat(144), FP[1], FP[2]] }),
        false,
      ),
    ).toBe("slot-generation");
  });

  it("reports owner-replaced only after every semantic field matched", () => {
    const replacement = { ...context(), runId: 8, startedAt: 0, timeoutDeadline: 2_000 };
    expect(classifyStaleReject(owner, replacement, context(), false)).toBe("owner-replaced");
    // A real semantic change outranks the registry swap: the registry is a
    // consequence of the reroll, not the authority that invalidated the read.
    expect(classifyStaleReject(owner, replacement, context({ offerGeneration: 5 }), false))
      .toBe("offer-generation");
  });

  it("classifies accepted-round drift before generic owner replacement", () => {
    const round1 = { ...owner, round: 1 };
    const round2Replacement = {
      ...context(),
      round: 2,
      runId: 8,
      startedAt: 0,
      timeoutDeadline: 2_000,
    };

    expect(
      classifyStaleReject(round1, round2Replacement, roundContext(2), false),
    ).toBe("round");
  });

  it("surfaces a bare capture-seq bump as its OWN cause, never as a supersede", () => {
    // Geometry capture sequence alone is NOT an ownership authority; when it is
    // the only thing that moved, the diagnostic must say so rather than hide
    // behind `owner-superseded-before-publication`.
    expect(classifyStaleReject(owner, owner, context(), true)).toBe("capture-seq-only");
  });

  it("lets the trace's run-16 shape publish instead of rejecting it", () => {
    // slot 0 re-read triggered at geometry seq 984; the accepted baseline moved
    // again at seq 985 while the 915 ms native read was outstanding, and the
    // read was discarded. Nothing had superseded it: slotGeneration was 23 at
    // trigger AND at completion, and the run still owned the registry. 24 of the
    // 25 stale rejects in the 2026-07-27 trace had exactly this shape.
    const run16 = {
      ...context({ requestedSlots: [0], slotGenerations: [23, 23, 23], fingerprints: FP }),
      runId: 16,
      startedAt: 1_473_787,
      timeoutDeadline: 1_475_787,
    };
    const atCompletion = context({
      requestedSlots: [0],
      slotGenerations: [23, 23, 23],
      fingerprints: ["0".repeat(144), FP[1], FP[2]],
    });
    expect(ownerCurrent(run16, run16, atCompletion)).toBe(true);
    expect(classifyStaleReject(run16, run16, atCompletion, false)).toBeNull();

    // The drift is still MEASURED — as evidence, not as a verdict.
    expect(
      staleRejectSlotDrift(run16, atCompletion, hammingDistance),
    ).toEqual([72]);
  });
});
