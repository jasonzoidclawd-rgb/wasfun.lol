import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  boundedDiagnosticHash,
  emitNativeDiagnostic,
  logOverlayDiagnostic,
  traceForwardingEnabledFrom,
} from "./publicationDiagnostics";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

describe("privacy-bounded overlay diagnostics", () => {
  afterEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("hashes normalized OCR text without returning the original", () => {
    const raw = "  隱私敏感文字  ";
    const hash = boundedDiagnosticHash(raw);
    expect(hash).toMatch(/^h[0-9a-f]{8}$/);
    expect(hash).not.toContain(raw.trim());
    expect(boundedDiagnosticHash(raw)).toBe(hash);
  });

  it("emits only the caller's bounded structured payload in development", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logOverlayDiagnostic("[identity-start]", { runId: 7, titleHash: "h12345678" });
    expect(info).toHaveBeenCalledWith(
      "[identity-start]",
      JSON.stringify({ runId: 7, titleHash: "h12345678" }),
    );
    info.mockRestore();
  });

  // The OCR-identity lifecycle is console-only by default; a live game can't see
  // the WebView console. MAYHEM_OVERLAY_TRACE=1 forwards the same bounded lines
  // to terminal stderr so a tee'd log captures why slots fail to resolve. Off by
  // default → normal dev runs stay quiet (no behavior change).
  it("enables trace forwarding only in a dev build with the flag set", () => {
    expect(traceForwardingEnabledFrom({ dev: true, flag: "1" })).toBe(true);
    expect(traceForwardingEnabledFrom({ dev: true, flag: undefined })).toBe(false);
    expect(traceForwardingEnabledFrom({ dev: true, flag: "0" })).toBe(false);
    expect(traceForwardingEnabledFrom({ dev: false, flag: "1" })).toBe(false);
  });

  it("bridges native-forwarded diagnostics to the terminal stderr sink verbatim", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    emitNativeDiagnostic("[game-poll]", { action: "preserve", failureAgeMs: 0 });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("emit_overlay_diagnostic", {
      marker: "[game-poll]",
      payload: JSON.stringify({ action: "preserve", failureAgeMs: 0 }),
    });
    info.mockRestore();
  });

  it("keeps logOverlayDiagnostic console-only unless the trace flag opts in", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // MAYHEM_OVERLAY_TRACE is unset in the test env → no terminal forward.
    logOverlayDiagnostic("[identity-timeout]", { runId: 1, reason: "timeout" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    info.mockRestore();

    // Wiring guard (env flags are not runtime-flippable in vitest): the terminal
    // forward for the console stream must stay gated on the trace predicate.
    const src = readFileSync(new URL("./publicationDiagnostics.ts", import.meta.url), "utf8");
    expect(src).toContain(
      "if (isTraceForwardingEnabled()) forwardToNativeSink(marker, serialized);",
    );
  });

  // A geometry wedge supersedes EVERY probe (the 2 s watchdog restarts the seq
  // before the slow invoke resolves), so a [geometry-timing] log placed after the
  // stale-rejection returns is silent in exactly the failure it exists to
  // diagnose. It must log BEFORE the return, and must carry nativeElapsedMs (Rust
  // probe total) alongside roundTripMs (JS invoke round-trip) — their gap is the
  // IPC/main-thread delay, which is what discriminates a slow capture from a
  // blocked main thread.
  it("logs [geometry-timing] before stale-rejection, with native vs round-trip split", () => {
    const src = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const timingAt = src.indexOf('logOverlayDiagnostic("[geometry-timing]"');
    const staleReturnAt = src.indexOf("if (stale) return;");
    expect(timingAt).toBeGreaterThan(-1);
    expect(staleReturnAt).toBeGreaterThan(-1);
    expect(timingAt).toBeLessThan(staleReturnAt);
    expect(src).toContain("nativeElapsedMs: observation.elapsedMs");
    expect(src).toContain("stale,");
  });
});

/**
 * Source guard for the baseline-settlement wiring. The pure functions are unit
 * tested in `rerollInvalidation.test.ts`; what cannot be proven there is that
 * App.tsx actually GATES confirmation on settlement, adopts the settled baseline
 * exactly once, and clears the provisional state at every lifecycle boundary.
 * Getting any of those wrong silently restores the level-3 badge wipe.
 */
describe("baseline settlement wiring", () => {
  const src = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

  it("gates reroll confirmation on settlement", () => {
    expect(src).toContain("!genuineAppear &&\n        !settling");
  });

  it("suppresses confirmation BEFORE the invalidation call reads it", () => {
    const settlingGate = src.indexOf("const settling =");
    const confirmation = src.indexOf("advanceRerollConfirmation({");
    const invalidation = src.indexOf("applyRerollInvalidation({");
    expect(settlingGate).toBeGreaterThan(-1);
    expect(settlingGate).toBeLessThan(confirmation);
    expect(confirmation).toBeLessThan(invalidation);
  });

  it("adopts the settled baseline exactly once, guarded on the latch edge", () => {
    expect(src).toContain("settlement.latched && !wasLatched");
    expect(src).toContain("acceptedSlotFingerprintsRef.current = settlement.provisional.slice()");
    // The adoption must precede the confirmation that reads the accepted baseline.
    expect(src.indexOf("settlement.provisional.slice()"))
      .toBeLessThan(src.indexOf("advanceRerollConfirmation({"));
  });

  it("clears the provisional baseline at every lifecycle boundary", () => {
    // Champion change, geometry/offer reset, offer close (NO_OFFER), occlusion.
    expect(src.split("baselineSettlementRef.current = null;").length - 1).toBe(4);
  });
});

/**
 * GEOMETRY CAPTURE SEQUENCE OWNERSHIP.
 *
 * `visibleFrame.captureSeq` is the geometry track's capture authority and the
 * ONLY source of the HUD's `geoseq`. `clearSurface` published `scanSeqRef` —
 * the OCR track's counter — into that field, so after any foreground blur the
 * displayed sequence jumped BACKWARD (observed live: 590 → 90) and then sat
 * frozen while geometry was stalled. The two counters advance at ~20x different
 * rates, so the wrong one is not a rounding error: it reads as "geometry is
 * alive at frame 90" while geometry is in fact dead.
 *
 * The value is diagnostic-only today (grep confirms `App.tsx`'s
 * `geometrySeq:` line is the single reader of `.captureSeq`), which is exactly
 * why it must be right: it is the number a human trusts while debugging a live
 * stall, and it lied during three separate investigations of this failure.
 */
describe("geometry capture-sequence ownership", () => {
  const src = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

  it("publishes the geometry counter, never the OCR scan counter", () => {
    expect(src).toContain("publishEmptyVisibleFrame(geometrySeqRef.current");
    expect(src).not.toContain("publishEmptyVisibleFrame(scanSeqRef.current");
  });

  it("never sources a published capture sequence from scanSeqRef", () => {
    // Any future call site must take the geometry counter too.
    expect(src).not.toMatch(/publishEmptyVisibleFrame\(\s*scanSeqRef/);
  });

  it("bumps the geometry sequence before publishing the cleared frame", () => {
    // The empty frame must carry the POST-invalidation sequence, so a late
    // in-flight result can never match it and re-publish.
    const clearSurface = src.indexOf("const clearSurface = useCallback(");
    expect(clearSurface).toBeGreaterThan(-1);
    const bump = src.indexOf("geometrySeqRef.current += 1;", clearSurface);
    const publish = src.indexOf("publishEmptyVisibleFrame(geometrySeqRef.current", clearSurface);
    expect(bump).toBeGreaterThan(-1);
    expect(bump).toBeLessThan(publish);
  });
});
