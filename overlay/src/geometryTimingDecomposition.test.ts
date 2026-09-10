/**
 * `decomposeGeometryTiming` — attribute every millisecond of a probe.
 *
 * Phase 1 (`.codex/gates/overlay-collapse-fix/phase1-root-cause.md` §1) measured
 * the round34 collapse across 434 `[geometry-timing]` records and found the lost
 * time in exactly the segments that need a TOKIO ASYNC-RUNTIME WORKER TO POLL A
 * TASK — never in capture or analysis. The blocking closure's own work is flat
 * (median 703 ms healthy -> 714 ms at the end) while the in-Rust dispatch wait
 * grows to a median of 166 522 ms and the IPC transport wait to 137 477 ms.
 *
 * The trace could not say that at the time. It shipped `preCaptureMs`,
 * `captureMs`, `analysisMs`, `nativeElapsedMs` and `roundTripMs` as five
 * unrelated numbers, so the two derived quantities that isolate the failure
 *
 *     rust_wait = nativeElapsedMs - (preCaptureMs + captureMs + analysisMs)
 *     transport = roundTripMs     -  nativeElapsedMs
 *
 * existed only in an analyst's head. This suite pins a decomposition that
 * computes them, that carries the new `dispatchWaitMs` / `resumeWaitMs`
 * measurements when they are present, and — the core requirement — that ACCOUNTS
 * FOR THE WHOLE. A decomposition allowed to quietly drop milliseconds would
 * reproduce the exact blind spot this slice exists to remove, so the segments
 * must sum to the total EXACTLY, with an explicit unattributed segment absorbing
 * whatever the named segments do not explain.
 *
 * SCOPE — DIAGNOSTIC ONLY. This is arithmetic over numbers a probe already
 * reported. It feeds no scheduling decision and changes no cadence, cap,
 * watchdog, epoch guard, or staleness rule.
 *
 * The reference algorithm the assertions below encode (`nonNeg(v)` is
 * `Number.isFinite(v) && v > 0 ? v : 0`, so undefined/NaN/negative all read 0):
 *
 *     closureWorkMs        = nonNeg(preCaptureMs) + nonNeg(captureMs) + nonNeg(analysisMs)
 *     dispatchWaitMs       = nonNeg(input.dispatchWaitMs)
 *     resumeWaitMs         = nonNeg(input.resumeWaitMs)
 *     measuredNative       = closureWorkMs + dispatchWaitMs + resumeWaitMs
 *     unattributedNativeMs = max(0, nonNeg(nativeElapsedMs) - measuredNative)
 *     nativeTotalMs        = max(nonNeg(nativeElapsedMs), measuredNative)
 *     transportMs          = max(0, nonNeg(roundTripMs) - nativeTotalMs)
 *     totalMs              = max(nonNeg(roundTripMs), nativeTotalMs)
 *     asyncRuntimeMs       = dispatchWaitMs + resumeWaitMs + unattributedNativeMs + transportMs
 *
 * `nativeTotalMs` never clamps DOWN to `nativeElapsedMs`: if the sub-phases
 * report more than the total, the excess is kept rather than discarded, because
 * discarding it is precisely the silent loss under test.
 */
import { describe, expect, it } from "vitest";
import * as surfaceGeometryModule from "./surfaceGeometry";

type GeometryTimingInput = {
  /** JS invoke round trip (`completedAt - startedAt`). */
  roundTripMs: number;
  /** Rust-side `elapsed_ms` for the whole command body. */
  nativeElapsedMs: number;
  preCaptureMs: number;
  captureMs: number;
  analysisMs: number;
  /**
   * New in this slice: time from entering the command body to the blocking
   * closure actually starting. Absent on every historical observation.
   */
  dispatchWaitMs?: number;
  /**
   * New in this slice: time from the blocking closure returning to the awaiting
   * task being polled again. Absent on every historical observation.
   */
  resumeWaitMs?: number;
};

type GeometryTimingDecomposition = {
  /** The whole. Every segment below sums to exactly this. */
  totalMs: number;
  /** Segments 7+8+9 — the blocking closure's own work. */
  closureWorkMs: number;
  /** Segment 6 — spawn_blocking queueing. 0 when unmeasured. */
  dispatchWaitMs: number;
  /** Segment 10 — the awaiting task being polled again. 0 when unmeasured. */
  resumeWaitMs: number;
  /** In-Rust time the named segments do not explain (the explicit residual). */
  unattributedNativeMs: number;
  /** Segments 3+12 — IPC in and out of the webview. */
  transportMs: number;
  /** dispatch + resume + unattributed + transport. */
  asyncRuntimeMs: number;
};

type GeometryTimingDecomposer = (
  input: GeometryTimingInput,
) => GeometryTimingDecomposition;

/**
 * Soft adapter (house pattern, mirrors `offerAcquisitionDiagnostic.test.ts`):
 * resolve the symbol dynamically so this suite COMPILES and `tsc --noEmit` stays
 * clean before the production export exists, and fails at RUNTIME on the
 * assertion below instead of on an import error.
 */
function decompose(
  input: GeometryTimingInput,
): GeometryTimingDecomposition | undefined {
  const seam = (surfaceGeometryModule as Record<string, unknown>)[
    "decomposeGeometryTiming"
  ];
  if (typeof seam !== "function") return undefined;
  return (seam as GeometryTimingDecomposer)(input);
}

function timing(input: GeometryTimingInput): GeometryTimingDecomposition {
  const result = decompose(input);
  expect(
    result,
    "surfaceGeometry must export a pure `decomposeGeometryTiming(input)` " +
      "returning { totalMs, closureWorkMs, dispatchWaitMs, resumeWaitMs, " +
      "unattributedNativeMs, transportMs, asyncRuntimeMs }",
  ).toBeTypeOf("object");
  return result as GeometryTimingDecomposition;
}

/** The five segments that must account for the whole. */
function segments(
  d: GeometryTimingDecomposition,
): ReadonlyArray<readonly [string, number]> {
  return [
    ["closureWorkMs", d.closureWorkMs],
    ["dispatchWaitMs", d.dispatchWaitMs],
    ["resumeWaitMs", d.resumeWaitMs],
    ["unattributedNativeMs", d.unattributedNativeMs],
    ["transportMs", d.transportMs],
  ];
}

function segmentSum(d: GeometryTimingDecomposition): number {
  return segments(d).reduce((total, [, ms]) => total + ms, 0);
}

/** The canonical healthy probe: closure work is essentially the whole trip. */
const healthy: GeometryTimingInput = {
  preCaptureMs: 359,
  captureMs: 177,
  analysisMs: 178,
  nativeElapsedMs: 716,
  roundTripMs: 734,
};

/**
 * probeSeq 483, the last probe of the collapse, verbatim from
 * `.codex/evidence/round34-live/trace.timestamped.jsonl`. Its derived
 * `rust_wait` (166 522) and `transport` (137 477) are the peak values Phase 1
 * reports for the whole run.
 */
const collapsed483: GeometryTimingInput = {
  preCaptureMs: 674,
  captureMs: 182,
  analysisMs: 173,
  nativeElapsedMs: 167_551,
  roundTripMs: 305_028,
};

describe("decomposeGeometryTiming — the parts account for the whole", () => {
  it("sums to the total exactly on a healthy probe", () => {
    const d = timing(healthy);
    expect(d.totalMs).toBe(734);
    expect(segmentSum(d)).toBe(d.totalMs);
  });

  it("sums to the total exactly on the collapsed probe", () => {
    const d = timing(collapsed483);
    expect(d.totalMs).toBe(305_028);
    expect(segmentSum(d)).toBe(d.totalMs);
  });

  it("splits the total into closure work plus async-runtime time with nothing left over", () => {
    for (const input of [healthy, collapsed483]) {
      const d = timing(input);
      expect(d.closureWorkMs + d.asyncRuntimeMs).toBe(d.totalMs);
      expect(d.asyncRuntimeMs).toBe(
        d.dispatchWaitMs +
          d.resumeWaitMs +
          d.unattributedNativeMs +
          d.transportMs,
      );
    }
  });

  it("keeps the total at least as large as the native elapsed it was built from", () => {
    // A decomposition that clamped the total down to roundTripMs would silently
    // discard native time whenever the two clocks disagree.
    const skewed: GeometryTimingInput = {
      preCaptureMs: 100,
      captureMs: 50,
      analysisMs: 50,
      nativeElapsedMs: 5_000,
      roundTripMs: 0,
    };
    const d = timing(skewed);
    expect(d.totalMs).toBeGreaterThanOrEqual(5_000);
    expect(segmentSum(d)).toBe(d.totalMs);
  });

  it("keeps sub-phase time that exceeds the reported native total", () => {
    const inconsistent: GeometryTimingInput = {
      preCaptureMs: 500,
      captureMs: 500,
      analysisMs: 500,
      nativeElapsedMs: 100,
      roundTripMs: 120,
    };
    const d = timing(inconsistent);
    expect(d.closureWorkMs).toBe(1_500);
    expect(segmentSum(d)).toBe(d.totalMs);
    expect(d.totalMs).toBeGreaterThanOrEqual(1_500);
  });
});

describe("decomposeGeometryTiming — a healthy probe is closure work", () => {
  it("attributes almost everything to the blocking closure", () => {
    const d = timing(healthy);
    expect(d.closureWorkMs).toBe(714);
    expect(d.closureWorkMs / d.totalMs).toBeGreaterThan(0.95);
  });

  it("leaves only a sliver on the async runtime", () => {
    const d = timing(healthy);
    expect(d.unattributedNativeMs).toBe(2);
    expect(d.transportMs).toBe(18);
    expect(d.asyncRuntimeMs).toBe(20);
    expect(d.asyncRuntimeMs).toBeLessThan(d.closureWorkMs);
  });
});

describe("decomposeGeometryTiming — the collapse is async-runtime time", () => {
  // This is the test that would have caught the collapse. The closure's own work
  // on probe 483 (1029 ms) is ORDINARY — a healthy probe spends 714 ms. Reading
  // the five raw numbers, nothing announces itself; reading the decomposition,
  // 99.6% of a five-minute round trip sits in segments that only a tokio worker
  // can advance.
  it("attributes the overwhelming majority to the async runtime, not the closure", () => {
    const d = timing(collapsed483);
    expect(d.closureWorkMs).toBe(1_029);
    expect(d.asyncRuntimeMs / d.totalMs).toBeGreaterThan(0.99);
    expect(d.closureWorkMs / d.totalMs).toBeLessThan(0.005);
    expect(d.asyncRuntimeMs).toBeGreaterThan(d.closureWorkMs * 100);
  });

  it("reproduces Phase 1's rust_wait and transport peaks exactly", () => {
    const d = timing(collapsed483);
    // rust_wait = nativeElapsedMs - (pre + capture + analysis) = 166 522
    expect(d.unattributedNativeMs).toBe(166_522);
    // transport = roundTripMs - nativeElapsedMs = 137 477
    expect(d.transportMs).toBe(137_477);
    expect(d.asyncRuntimeMs).toBe(303_999);
  });

  it("keeps closure work in the same band as a healthy probe", () => {
    // The decisive negative result: capture and analysis never degraded, so a
    // decomposition that blamed the closure would be wrong about the cause.
    const healthyWork = timing(healthy).closureWorkMs;
    const collapsedWork = timing(collapsed483).closureWorkMs;
    expect(collapsedWork).toBeLessThan(healthyWork * 2);
  });
});

describe("decomposeGeometryTiming — the new dispatch/resume measurements", () => {
  it("splits the opaque in-Rust wait once both waits are reported", () => {
    // The post-fix world: the same probe, now instrumented. The wait that was
    // unattributed is fully explained and nothing else moves.
    const d = timing({
      ...collapsed483,
      dispatchWaitMs: 100_000,
      resumeWaitMs: 66_522,
    });
    expect(d.dispatchWaitMs).toBe(100_000);
    expect(d.resumeWaitMs).toBe(66_522);
    expect(d.unattributedNativeMs).toBe(0);
    expect(d.transportMs).toBe(137_477);
    expect(d.asyncRuntimeMs).toBe(303_999);
    expect(segmentSum(d)).toBe(d.totalMs);
  });

  it("attributes a partially-explained wait without losing the remainder", () => {
    const d = timing({ ...collapsed483, dispatchWaitMs: 160_000 });
    expect(d.dispatchWaitMs).toBe(160_000);
    expect(d.resumeWaitMs).toBe(0);
    expect(d.unattributedNativeMs).toBe(6_522);
    expect(segmentSum(d)).toBe(d.totalMs);
    expect(d.asyncRuntimeMs).toBe(303_999);
  });

  it("handles historical observations that carry neither field", () => {
    // The fields are new; every record already on disk lacks them. No NaN, no
    // throw, no undefined leaking into the arithmetic.
    const d = timing(collapsed483);
    expect(d.dispatchWaitMs).toBe(0);
    expect(d.resumeWaitMs).toBe(0);
    for (const [name, ms] of segments(d)) {
      expect(Number.isFinite(ms), `${name} must be finite`).toBe(true);
      expect(Number.isNaN(ms), `${name} must not be NaN`).toBe(false);
    }
    expect(Number.isFinite(d.totalMs)).toBe(true);
    expect(Number.isFinite(d.asyncRuntimeMs)).toBe(true);
  });

  it("handles an explicitly undefined field the same as an absent one", () => {
    const withUndefined = timing({
      ...collapsed483,
      dispatchWaitMs: undefined,
      resumeWaitMs: undefined,
    });
    const withoutKeys = timing(collapsed483);
    expect(withUndefined).toEqual(withoutKeys);
  });
});

describe("decomposeGeometryTiming — no negative segments, ever", () => {
  const adversarial: ReadonlyArray<readonly [string, GeometryTimingInput]> = [
    [
      "all zeros",
      {
        preCaptureMs: 0,
        captureMs: 0,
        analysisMs: 0,
        nativeElapsedMs: 0,
        roundTripMs: 0,
      },
    ],
    [
      "native elapsed exceeds the round trip",
      {
        preCaptureMs: 300,
        captureMs: 200,
        analysisMs: 200,
        nativeElapsedMs: 9_000,
        roundTripMs: 700,
      },
    ],
    [
      "negative sub-phases",
      {
        preCaptureMs: -1,
        captureMs: -50,
        analysisMs: -1_000,
        nativeElapsedMs: 700,
        roundTripMs: 720,
      },
    ],
    [
      "negative totals",
      {
        preCaptureMs: 10,
        captureMs: 10,
        analysisMs: 10,
        nativeElapsedMs: -5,
        roundTripMs: -9_999,
      },
    ],
    [
      "NaN everywhere",
      {
        preCaptureMs: Number.NaN,
        captureMs: Number.NaN,
        analysisMs: Number.NaN,
        nativeElapsedMs: Number.NaN,
        roundTripMs: Number.NaN,
        dispatchWaitMs: Number.NaN,
        resumeWaitMs: Number.NaN,
      },
    ],
    [
      "negative waits",
      {
        preCaptureMs: 300,
        captureMs: 200,
        analysisMs: 200,
        nativeElapsedMs: 800,
        roundTripMs: 820,
        dispatchWaitMs: -400,
        resumeWaitMs: -400,
      },
    ],
    [
      "waits larger than the native total",
      {
        preCaptureMs: 300,
        captureMs: 200,
        analysisMs: 200,
        nativeElapsedMs: 800,
        roundTripMs: 820,
        dispatchWaitMs: 50_000,
        resumeWaitMs: 50_000,
      },
    ],
  ];

  for (const [name, input] of adversarial) {
    it(`keeps every segment >= 0 and the sum exact: ${name}`, () => {
      const d = timing(input);
      for (const [segment, ms] of segments(d)) {
        expect(Number.isFinite(ms), `${segment} must be finite`).toBe(true);
        expect(ms, `${segment} must not be negative`).toBeGreaterThanOrEqual(0);
      }
      expect(d.totalMs).toBeGreaterThanOrEqual(0);
      expect(d.asyncRuntimeMs).toBeGreaterThanOrEqual(0);
      expect(segmentSum(d)).toBe(d.totalMs);
    });
  }
});

describe("decomposeGeometryTiming — purity", () => {
  it("returns the same decomposition for the same input every time", () => {
    expect(timing(collapsed483)).toEqual(timing(collapsed483));
    expect(timing({ ...collapsed483 })).toEqual(timing(collapsed483));
  });

  it("does not mutate its input", () => {
    const input: GeometryTimingInput = {
      ...collapsed483,
      dispatchWaitMs: 100_000,
      resumeWaitMs: 66_522,
    };
    const before = JSON.stringify(input);
    timing(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
