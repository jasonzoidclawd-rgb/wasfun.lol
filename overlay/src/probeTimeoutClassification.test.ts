/**
 * `classifyProbeTimeout` — the honest, elapsed-aware probe label.
 *
 * Phase 1 (`.codex/gates/overlay-collapse-fix/phase1-root-cause.md` §3b) proved
 * that the `timeoutClassification` expression in `App.tsx`
 *
 *     captureValid ? "none" : observation.rejectionReasons[0] ?? "capture-invalid"
 *
 * has NO elapsed-time input at all — `captureValid` is only
 * `captureWidth > 0 && captureHeight > 0`. Across all 434 `[geometry-timing]`
 * records of the round34 collapse, every one of the 19 probes with
 * `nativeElapsedMs >= 10 s` was labelled `"none"`, up to and including
 * `probeSeq 483` at `nativeElapsedMs 167551` / `roundTripMs 305028`. A field
 * named "timeout classification" that cannot see time is the blind spot that let
 * a five-minute round trip look healthy in the trace.
 *
 * This suite pins a replacement that takes elapsed time as an input.
 *
 * SCOPE — LABELLING ONLY. `classifyProbeTimeout` is a diagnostic label and must
 * feed no scheduling decision. `nextProbeAction` continues to decide from
 * `inFlightSince` / `nativeOutstanding` / `oldestNativeStartedAt` alone; nothing
 * in this contract changes cadence, the outstanding-native cap (1, or 2 with a
 * wedged replacement), the watchdog, or any epoch/staleness guard.
 *
 * Every input below is a literal row from
 * `.codex/evidence/round34-live/trace.timestamped.jsonl` unless a comment says
 * otherwise; no clocks, no timers, no I/O.
 */
import { describe, expect, it } from "vitest";
import * as surfaceGeometryModule from "./surfaceGeometry";
import { PROBE_TIMEOUT_MS } from "./surfaceProbeScheduler";

/**
 * Everything the label may depend on. `timeoutMs` is the watchdog deadline the
 * label is measured against and defaults to `PROBE_TIMEOUT_MS`.
 */
type ProbeTimeoutInput = {
  captureWidth: number;
  captureHeight: number;
  rejectionReasons: readonly string[];
  /** JS invoke round trip (`completedAt - startedAt`). */
  roundTripMs: number;
  /** Rust-side `elapsed_ms` for the whole command body. */
  nativeElapsedMs: number;
  timeoutMs?: number;
};

type ProbeTimeoutClassifier = (input: ProbeTimeoutInput) => string;

/** Stable label vocabulary. */
const NONE = "none";
const WATCHDOG_EXCEEDED = "watchdog-exceeded";
const CAPTURE_INVALID = "capture-invalid";

/**
 * Soft adapter (house pattern, mirrors `offerAcquisitionDiagnostic.test.ts`):
 * resolve the symbol dynamically so this suite COMPILES and `tsc --noEmit` stays
 * clean before the production export exists, and fails at RUNTIME on the
 * assertion below instead of on an import error.
 */
function classifyProbeTimeout(input: ProbeTimeoutInput): string | undefined {
  const seam = (surfaceGeometryModule as Record<string, unknown>)[
    "classifyProbeTimeout"
  ];
  if (typeof seam !== "function") return undefined;
  return (seam as ProbeTimeoutClassifier)(input);
}

function label(input: ProbeTimeoutInput): string {
  const result = classifyProbeTimeout(input);
  expect(
    result,
    "surfaceGeometry must export a pure `classifyProbeTimeout(input): string` " +
      "that takes roundTripMs/nativeElapsedMs into account",
  ).toBeTypeOf("string");
  return result as string;
}

/**
 * probeSeq 483 — the last probe of the collapse. Valid pixels (the closure ran:
 * captureMs 182 / analysisMs 173 are non-zero), yet the round trip is 305 s.
 * The live build labelled this `"none"`.
 */
const collapsedProbe483: ProbeTimeoutInput = {
  captureWidth: 3024,
  captureHeight: 1890,
  rejectionReasons: [],
  roundTripMs: 305_028,
  nativeElapsedMs: 167_551,
};

/**
 * probeSeq 482 — `nativeElapsedMs 165349`, `roundTripMs 261977`, live label
 * `"none"`. This is THE headline red: 165 s of native elapsed reported as no
 * timeout at all.
 */
const collapsedProbe482: ProbeTimeoutInput = {
  captureWidth: 3024,
  captureHeight: 1890,
  rejectionReasons: [],
  roundTripMs: 261_977,
  nativeElapsedMs: 165_349,
};

/**
 * A healthy probe. The nearest literal trace row is probeSeq 6
 * (362/168/188, native 718, round trip 733); these are the canonical healthy
 * figures carried by the slice contract and sit inside the same band.
 */
const healthyProbe: ProbeTimeoutInput = {
  captureWidth: 3024,
  captureHeight: 1890,
  rejectionReasons: [],
  roundTripMs: 734,
  nativeElapsedMs: 716,
};

/**
 * probeSeq 4 — a real bounded-capture timeout. `captureMs`/`analysisMs` are 0
 * and the capture is invalid, so `rejectionReasons[0]` ("capture-timeout") is
 * what the live build reported and what must keep being reported.
 */
const captureTimeoutProbe4: ProbeTimeoutInput = {
  captureWidth: 0,
  captureHeight: 0,
  rejectionReasons: ["capture-timeout"],
  roundTripMs: 1_558,
  nativeElapsedMs: 1_503,
};

/**
 * probeSeq 484 — the game-ended error path under the same starvation.
 * `preCaptureMs 214752` there is just a copy of the total elapsed
 * (`absent_surface_observation`), the capture is invalid, and the live label was
 * the rejection reason. Slow AND invalid: the rejection reason still wins,
 * because it names the concrete cause and the timeout does not.
 */
const invalidAndStarvedProbe484: ProbeTimeoutInput = {
  captureWidth: 0,
  captureHeight: 0,
  rejectionReasons: ["actual-game-window-not-foreground"],
  roundTripMs: 366_865,
  nativeElapsedMs: 214_752,
};

describe("classifyProbeTimeout — a probe that took minutes is never \"none\"", () => {
  it("does not label the 165 s probe 482 as \"none\"", () => {
    expect(label(collapsedProbe482)).not.toBe(NONE);
  });

  it("labels the 165 s probe 482 as watchdog-exceeded", () => {
    expect(label(collapsedProbe482)).toBe(WATCHDOG_EXCEEDED);
  });

  it("labels the 305 s probe 483 as watchdog-exceeded", () => {
    expect(label(collapsedProbe483)).toBe(WATCHDOG_EXCEEDED);
  });

  it("flags a probe whose NATIVE elapsed alone blew the deadline", () => {
    // Transport was fine; all of the loss is inside Rust. A label that only read
    // roundTripMs would still be honest here, but one that reads neither is not.
    expect(
      label({
        captureWidth: 3024,
        captureHeight: 1890,
        rejectionReasons: [],
        roundTripMs: 65_800,
        nativeElapsedMs: 65_786,
      }),
    ).toBe(WATCHDOG_EXCEEDED);
  });

  it("flags a probe whose ROUND TRIP alone blew the deadline", () => {
    // The mirror case: native work was healthy, the IPC/transport leg was not.
    expect(
      label({
        captureWidth: 3024,
        captureHeight: 1890,
        rejectionReasons: [],
        roundTripMs: 117_720,
        nativeElapsedMs: 700,
      }),
    ).toBe(WATCHDOG_EXCEEDED);
  });
});

describe("classifyProbeTimeout — a fast, valid probe is still \"none\"", () => {
  it("labels the healthy probe none", () => {
    expect(label(healthyProbe)).toBe(NONE);
  });

  it("labels the real trace row probeSeq 6 none", () => {
    expect(
      label({
        captureWidth: 3024,
        captureHeight: 1890,
        rejectionReasons: [],
        roundTripMs: 733,
        nativeElapsedMs: 718,
      }),
    ).toBe(NONE);
  });

  it("does not invent a timeout from a non-empty rejection list on a valid capture", () => {
    // A valid capture that simply saw no cards carries rejection reasons but is
    // a perfectly healthy observation. Rejection reasons are a capture-validity
    // signal, not a latency signal.
    expect(
      label({
        captureWidth: 3024,
        captureHeight: 1890,
        rejectionReasons: ["insufficient-cards-0/3"],
        roundTripMs: 733,
        nativeElapsedMs: 718,
      }),
    ).toBe(NONE);
  });
});

describe("classifyProbeTimeout — the invalid-capture branch is unchanged", () => {
  it("still surfaces the first rejection reason (regression guard)", () => {
    expect(label(captureTimeoutProbe4)).toBe("capture-timeout");
  });

  it("keeps the rejection reason even when the probe was also starved", () => {
    expect(label(invalidAndStarvedProbe484)).toBe(
      "actual-game-window-not-foreground",
    );
  });

  it("never returns \"none\" for an invalid capture", () => {
    for (const input of [captureTimeoutProbe4, invalidAndStarvedProbe484]) {
      expect(label(input)).not.toBe(NONE);
    }
  });

  it("falls back to a stable non-empty label when there is no rejection reason", () => {
    const fallback = label({
      captureWidth: 0,
      captureHeight: 0,
      rejectionReasons: [],
      roundTripMs: 900,
      nativeElapsedMs: 880,
    });
    expect(fallback).toBe(CAPTURE_INVALID);
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("treats a zero dimension in either axis as invalid", () => {
    expect(
      label({
        captureWidth: 3024,
        captureHeight: 0,
        rejectionReasons: [],
        roundTripMs: 900,
        nativeElapsedMs: 880,
      }),
    ).toBe(CAPTURE_INVALID);
    expect(
      label({
        captureWidth: 0,
        captureHeight: 1890,
        rejectionReasons: [],
        roundTripMs: 900,
        nativeElapsedMs: 880,
      }),
    ).toBe(CAPTURE_INVALID);
  });
});

describe("classifyProbeTimeout — the deadline boundary", () => {
  // BOUNDARY CHOICE: INCLUSIVE. Exactly `timeoutMs` counts as exceeded, matching
  // `nextProbeAction`'s own watchdog test `now - inFlightSince >= timeoutMs`
  // (surfaceProbeScheduler.ts). The label and the watchdog therefore agree on
  // the same instant, which is the whole point of reusing the constant.
  it("is \"none\" one millisecond under the deadline", () => {
    expect(
      label({
        captureWidth: 3024,
        captureHeight: 1890,
        rejectionReasons: [],
        roundTripMs: PROBE_TIMEOUT_MS - 1,
        nativeElapsedMs: PROBE_TIMEOUT_MS - 1,
      }),
    ).toBe(NONE);
  });

  it("is watchdog-exceeded exactly at the deadline", () => {
    expect(
      label({
        captureWidth: 3024,
        captureHeight: 1890,
        rejectionReasons: [],
        roundTripMs: PROBE_TIMEOUT_MS,
        nativeElapsedMs: 0,
      }),
    ).toBe(WATCHDOG_EXCEEDED);
  });

  it("tracks PROBE_TIMEOUT_MS rather than a hardcoded number", () => {
    // The contract is the constant, not the value 2000. If the source of truth
    // moves, the label moves with it.
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(
      label({
        captureWidth: 3024,
        captureHeight: 1890,
        rejectionReasons: [],
        roundTripMs: PROBE_TIMEOUT_MS + 1,
        nativeElapsedMs: 0,
      }),
    ).toBe(WATCHDOG_EXCEEDED);
  });

  it("honours an explicit timeoutMs override", () => {
    const slowButUnderCustomDeadline: ProbeTimeoutInput = {
      captureWidth: 3024,
      captureHeight: 1890,
      rejectionReasons: [],
      roundTripMs: 5_000,
      nativeElapsedMs: 4_900,
      timeoutMs: 10_000,
    };
    expect(label(slowButUnderCustomDeadline)).toBe(NONE);
    expect(label({ ...slowButUnderCustomDeadline, timeoutMs: 4_000 })).toBe(
      WATCHDOG_EXCEEDED,
    );
  });
});

describe("classifyProbeTimeout — purity", () => {
  it("returns the same label for the same input every time", () => {
    const first = label(collapsedProbe483);
    const second = label(collapsedProbe483);
    const third = label({ ...collapsedProbe483 });
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("does not mutate its input", () => {
    const input: ProbeTimeoutInput = {
      captureWidth: 0,
      captureHeight: 0,
      rejectionReasons: ["capture-timeout"],
      roundTripMs: 1_558,
      nativeElapsedMs: 1_503,
    };
    const before = JSON.stringify(input);
    label(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(input.rejectionReasons).toHaveLength(1);
  });

  it("returns a plain non-empty string for every pinned row", () => {
    for (const input of [
      collapsedProbe482,
      collapsedProbe483,
      healthyProbe,
      captureTimeoutProbe4,
      invalidAndStarvedProbe484,
    ]) {
      const value = label(input);
      expect(value.length).toBeGreaterThan(0);
      expect(value.trim()).toBe(value);
    }
  });
});
