import { describe, expect, it } from "vitest";
import { numericSummary, parseOverlayTrace, summarizeOcrTrace } from "./traceReplay";

// A tee'd overlay log: each diagnostic line is `[marker] {json}` (the exact form
// both console.info and the Rust `eprintln!("{} {}", marker, payload)` sink use).
const SAMPLE = [
  '[game-poll] {"action":"preserve","failureAgeMs":1200}',
  '[identity-trigger] {"requestedSlots":[0,1,2],"reason":"missing"}',
  '[identity-start] {"runId":10,"requestedSlots":[0,1,2]}',
  '[identity-native-finish] {"runId":10,"captureAttempted":true,"cropCount":3,"ocrMs":2800,"captureMs":40}',
  '[identity-timeout] {"runId":10,"reason":"timeout","failures":[1,1,1]}',
  "a plain narrator line that is not a diagnostic and must be ignored",
  '[identity-start] {"runId":11,"requestedSlots":[0,1,2]}',
  '[identity-native-finish] {"runId":11,"captureAttempted":true,"cropCount":0,"ocrMs":15,"captureMs":5}',
  '[identity-watchdog-restart] {"runId":11,"reason":"deadline-exceeded"}',
  '[geometry-watchdog] {"probeSeq":706,"inFlightMs":4200,"hiddenReason":"probe-timeout"}',
  '[geometry-timing] {"attemptGeneration":707,"preCaptureMs":110,"captureMs":220,"analysisMs":330,"nativeElapsedMs":660,"roundTripMs":700,"stale":true,"timeoutClassification":"capture-timeout","continuousUnhealthyAgeMs":2100,"acceptedGeometryAgeMs":1400}',
  '[geometry-stale-hide] {"attemptGeneration":708,"staleHide":true,"continuousUnhealthyAgeMs":2300,"acceptedGeometryAgeMs":1600}',
  '[geometry-recovery] {"attemptGeneration":709,"continuousUnhealthyAgeMs":2500,"acceptedGeometryAgeMs":0}',
  '[identity-native-return] {"runId":7,"nativeMs":5300,"cropCount":3,"captureMs":900,"ocrMs":4300}',
  "[identity-malformed] {this is not json}",
].join("\n");

describe("overlay trace replay", () => {
  it("parses `[marker] {json}` lines and ignores noise and malformed payloads", () => {
    const events = parseOverlayTrace(SAMPLE);
    expect(events).toHaveLength(13);
    expect(events[0]).toEqual({ marker: "[game-poll]", payload: { action: "preserve", failureAgeMs: 1200 } });
    expect(events.map((e) => e.marker)).not.toContain("[identity-malformed]");
  });

  it("tallies the OCR-identity lifecycle so `resolved 0/3` has a cause", () => {
    const summary = summarizeOcrTrace(parseOverlayTrace(SAMPLE));
    expect(summary.starts).toBe(2);
    expect(summary.nativeFinishes).toBe(2);
    expect(summary.publishes).toBe(0);
    expect(summary.timeouts).toBe(1);
    expect(summary.watchdogRestarts).toBe(1);
    expect(summary.staleRejects).toBe(0);
    expect(summary.capture.samples).toBe(2);
    expect(summary.capture.zeroCropCount).toBe(1);
    expect(summary.capture.ocrMs).toEqual({ count: 2, min: 15, median: 1407.5, max: 2800 });
    expect(summary.markerCounts["[identity-native-finish]"]).toBe(2);
  });

  it("surfaces the geometry-stall confirming signals (watchdog + late native return)", () => {
    const summary = summarizeOcrTrace(parseOverlayTrace(SAMPLE));
    // How long the geometry probe was blocked before the watchdog fired.
    expect(summary.geometryWatchdogs).toBe(1);
    expect(summary.geometryInFlightMs).toEqual({ count: 1, min: 4200, median: 4200, max: 4200 });
    // How long the native OCR really ran — even past the JS timeout that abandoned it.
    expect(summary.nativeReturns).toBe(1);
    expect(summary.nativeMs).toEqual({ count: 1, min: 5300, median: 5300, max: 5300 });
  });

  it("summarizes complete geometry timing, stale hide, and recovery evidence", () => {
    const summary = summarizeOcrTrace(parseOverlayTrace(SAMPLE));
    expect(summary.geometryTimings).toBe(1);
    expect(summary.geometryPreCaptureMs).toEqual({ count: 1, min: 110, median: 110, max: 110 });
    expect(summary.geometryCaptureMs).toEqual({ count: 1, min: 220, median: 220, max: 220 });
    expect(summary.geometryAnalysisMs).toEqual({ count: 1, min: 330, median: 330, max: 330 });
    expect(summary.geometryNativeElapsedMs).toEqual({ count: 1, min: 660, median: 660, max: 660 });
    expect(summary.geometryRoundTripMs).toEqual({ count: 1, min: 700, median: 700, max: 700 });
    expect(summary.staleGeometryResults).toBe(1);
    expect(summary.geometryTimeoutClassifications).toEqual({ "capture-timeout": 1 });
    expect(summary.geometryStaleHides).toBe(1);
    expect(summary.geometryRecoveries).toBe(1);
    expect(summary.continuousUnhealthyAgeMs).toEqual({
      count: 3,
      min: 2100,
      median: 2300,
      max: 2500,
    });
    expect(summary.acceptedGeometryAgeMs).toEqual({
      count: 3,
      min: 0,
      median: 1400,
      max: 1600,
    });
  });

  it("summarizes numeric samples with an even-count median", () => {
    expect(numericSummary([])).toEqual({ count: 0, min: 0, median: 0, max: 0 });
    expect(numericSummary([5])).toEqual({ count: 1, min: 5, median: 5, max: 5 });
    expect(numericSummary([10, 2, 8, 4])).toEqual({ count: 4, min: 2, median: 6, max: 10 });
  });
});

/**
 * The hide marker had TWO defects the 2026-07-26 four-phase trace exposed:
 * the runtime emitted `[geometry-hidden]` while the summary counted a nested
 * `staleHide === true` field, so a trace containing 2 real hide events (both
 * `ttl-expired`, `staleHide: false`) reported `stale hides 0` — the operator
 * read that as "geometry never hid the card", which was the opposite of the
 * truth. One canonical marker, counted by OCCURRENCE, removes both.
 */
describe("canonical geometry stale-hide marker", () => {
  it("counts every stale-hide occurrence regardless of the staleHide field", () => {
    const trace = [
      '[geometry-stale-hide] {"probeSeq":1006,"hiddenReason":"ttl-expired","staleHide":false}',
      '[geometry-stale-hide] {"probeSeq":1204,"hiddenReason":"probe-timeout","staleHide":false}',
    ].join("\n");
    // Exactly the supplied trace's shape: 2 hides, previously summarized as 0.
    expect(summarizeOcrTrace(parseOverlayTrace(trace)).geometryStaleHides).toBe(2);
  });

  it("still replays logs written with the legacy `[geometry-hidden]` marker", () => {
    const legacy = '[geometry-hidden] {"probeSeq":900,"hiddenReason":"ttl-expired","staleHide":false}';
    expect(summarizeOcrTrace(parseOverlayTrace(legacy)).geometryStaleHides).toBe(1);
  });

  it("counts a mixed old/new log once per event", () => {
    const mixed = [
      '[geometry-hidden] {"probeSeq":900,"staleHide":true}',
      '[geometry-stale-hide] {"probeSeq":901,"staleHide":false}',
    ].join("\n");
    expect(summarizeOcrTrace(parseOverlayTrace(mixed)).geometryStaleHides).toBe(2);
  });

  it("keeps hide events inside the geometry age samples under either marker", () => {
    const trace = [
      '[geometry-stale-hide] {"continuousUnhealthyAgeMs":40,"acceptedGeometryAgeMs":60}',
      '[geometry-hidden] {"continuousUnhealthyAgeMs":80,"acceptedGeometryAgeMs":100}',
    ].join("\n");
    const summary = summarizeOcrTrace(parseOverlayTrace(trace));
    expect(summary.continuousUnhealthyAgeMs.count).toBe(2);
    expect(summary.acceptedGeometryAgeMs.count).toBe(2);
  });
});

/**
 * The foreground-poll fields are how a retest PROVES the single-flight
 * invariant from a log rather than from reading code: every started poll ends
 * as exactly one `settle` or one `late-reject`. The payload keys below must
 * stay identical to the ones `pollForeground` passes to `host.log`.
 */
describe("foreground poll summary", () => {
  const trace = [
    '[foreground-poll] {"action":"settle","nativeMs":120,"epochMoved":false,"epoch":3}',
    '[foreground-poll] {"action":"logical-timeout","physicalInFlightAgeMs":1500,"epoch":3}',
    '[foreground-poll] {"action":"late-reject","nativeMs":4200,"epochMoved":true,"epoch":4}',
    '[foreground-poll] {"action":"settle","nativeMs":80,"epochMoved":false,"epoch":4}',
  ].join("\n");

  it("counts each poll outcome separately", () => {
    const summary = summarizeOcrTrace(parseOverlayTrace(trace));
    expect(summary.foregroundSettles).toBe(2);
    expect(summary.foregroundLateRejects).toBe(1);
    expect(summary.foregroundLogicalTimeouts).toBe(1);
  });

  it("samples native duration and coalesced in-flight age independently", () => {
    const summary = summarizeOcrTrace(parseOverlayTrace(trace));
    // Only settles/late-rejects carry nativeMs; only coalesced ticks carry the age.
    expect(summary.foregroundNativeMs.count).toBe(3);
    expect(summary.foregroundNativeMs.max).toBe(4200);
    expect(summary.foregroundPhysicalInFlightAgeMs.count).toBe(1);
    expect(summary.foregroundPhysicalInFlightAgeMs.max).toBe(1500);
  });

  it("does not fold foreground polls into the geometry counters", () => {
    const summary = summarizeOcrTrace(parseOverlayTrace(trace));
    expect(summary.geometryTimings).toBe(0);
    expect(summary.geometryNativeElapsedMs.count).toBe(0);
    expect(summary.markerCounts["[foreground-poll]"]).toBe(4);
  });
});
