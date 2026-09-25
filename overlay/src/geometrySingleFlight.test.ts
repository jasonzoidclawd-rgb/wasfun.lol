/**
 * R4 MUST RECOVER WITHOUT FOCUS TOGGLING.
 *
 * Live trace 2026-07-27, t≈495,000–511,600 (wall 01:12:02–01:12:18). Three cards
 * were physically on screen and the overlay painted NOTHING — not even SCANNING —
 * for ~10 s, until the operator tabbed out and back in.
 *
 * The foreground poll was NOT involved: across the whole 155,741-line trace
 * `[foreground-poll]` logged 128,554 `settle` actions and ZERO `logical-timeout`
 * and ZERO `late-reject`. Physical single-flight held.
 *
 * The geometry scheduler collapsed instead. Its watchdog deadline (2000 ms) sits
 * BELOW the native probe's actual completion time under load, which the trace
 * measured at 1,727–3,659 ms while the real work (preCapture+capture+analysis)
 * stayed flat at ~650–720 ms — i.e. the extra latency was queueing, not work. So
 * the watchdog kept declaring "stuck" a probe that was merely slow and, via
 * `restart`, issued ANOTHER native invoke without cancelling the first:
 *
 *   seq 604 inFlight=2000 restarts=6  outstanding=1 action=restart
 *   seq 606 inFlight=2092 restarts=7  outstanding=2 action=abandon
 *   seq 608 inFlight=2109 restarts=8  outstanding=1 action=restart
 *   seq 610 inFlight=2111 restarts=9  outstanding=2 action=abandon
 *   ...                    restarts=21
 *
 * Every probe came back `stale:true`, so no accepted frame ever existed, the
 * offer never reached OFFER_VISIBLE, no identity-trigger fired, and nothing —
 * badge or SCANNING — could render.
 *
 * Worse than slow: the watchdog INVALIDATES what it waits for. Both `restart`
 * and `abandon` bump `geometrySeqRef` (App.tsx:2782) before any result returns,
 * so every completed probe fails `captureSeq !== geometrySeqRef.current` and
 * returns at App.tsx:1714 — above the surface commit, the offer FSM, the slot
 * publications and `decideOcrTrigger`. Goodput was exactly zero at 100%
 * utilization: 6 geometry results landed inside t=495000..515000 and all 6 were
 * `stale:true`. The offer FSM never ran, so it sat frozen at
 * `NO_OFFER / render:false / "no-offer-surface"` for 32,657 ms with three cards
 * on screen, and `realFrameRenderable` had three independently-false conjuncts.
 * That is why the operator saw neither a badge nor a SCANNING chip.
 *
 * Tabbing out "fixed" it only by accident, and NOT via the foreground epoch:
 * losing foreground made probes 614 and 617 abort at the native gate
 * (lib.rs:1248) BEFORE `capture_image`, returning their capture permits without
 * doing capture work. The queue drained, and probe 622 — the first whose round
 * trip (<=753 ms) beat the 2,109 ms watchdog quantum since seq 595 — landed with
 * its seq unbumped and became the first accepted frame in 32.7 s. Recovery
 * happened at a STABLE foregroundEpoch 5, 5,220 ms after the last focus flip;
 * every marker in the recovery chain carries `foregroundEpoch:5`. (Probe 620,
 * which an earlier reading credited with recovering at native=800 ms, was itself
 * stale.) The same lag repeats on the second collapse: 5,612 ms.
 *
 * So the recovery event is a queue drain, not a focus change — and the drain
 * must be reachable without one.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  nextProbeAction,
  DEFAULT_PROBE_CONFIG,
  MAX_OUTSTANDING_NATIVE_PROBES,
  type ProbeSchedulerState,
} from "./surfaceProbeScheduler";

const live = (overrides: Partial<ProbeSchedulerState> = {}): ProbeSchedulerState => ({
  foreground: true,
  activeGame: true,
  inFlight: false,
  inFlightSince: null,
  lastProbeStartedAt: null,
  nativeOutstanding: 0,
  ...overrides,
});

describe("geometry probe single-flight", () => {
  it("never issues a replacement while a native probe is unsettled", () => {
    // The watchdog cannot cancel native work; a replacement can only deepen the
    // queue that is already making the first call slow.
    const timedOut = live({
      inFlight: true,
      inFlightSince: 0,
      lastProbeStartedAt: 0,
      nativeOutstanding: 1,
    });
    const action = nextProbeAction(timedOut, DEFAULT_PROBE_CONFIG, DEFAULT_PROBE_CONFIG.timeoutMs);
    expect(action.kind).not.toBe("restart");
    expect(action.kind).toBe("abandon");
  });

  it("does not start a fresh probe while the abandoned one is still unsettled", () => {
    // After abandonment the logical guard is released but the native call is
    // still occupying the capture path. Starting here is what produced the
    // 1↔2 outstanding oscillation.
    const abandoned = live({
      inFlight: false,
      inFlightSince: null,
      lastProbeStartedAt: 0,
      nativeOutstanding: 1,
    });
    const action = nextProbeAction(abandoned, DEFAULT_PROBE_CONFIG, 3_000);
    expect(action.kind).toBe("skip");
  });

  it("caps concurrent native geometry probes at one", () => {
    expect(MAX_OUTSTANDING_NATIVE_PROBES).toBe(1);
  });

  it("13/15. resumes on the next tick once the slow probe settles — no focus change", () => {
    // The settle is the recovery event. `foreground` never changes across these
    // three states, so no focus epoch transition is involved.
    const settled = live({
      inFlight: false,
      inFlightSince: null,
      lastProbeStartedAt: 0,
      nativeOutstanding: 0,
    });
    const action = nextProbeAction(settled, DEFAULT_PROBE_CONFIG, 3_000);
    expect(action.kind).toBe("start");
    expect(settled.foreground).toBe(true);
  });

  it("14. drives the full R4 sequence to a fresh probe without ever losing foreground", () => {
    // Replays the trace shape: a probe issued, the 2000 ms watchdog firing while
    // the native call is still running, the call settling at 3,659 ms, and the
    // scheduler recovering by itself.
    const actions: string[] = [];
    let state = live({ lastProbeStartedAt: null });

    actions.push(nextProbeAction(state, DEFAULT_PROBE_CONFIG, 0).kind); // start
    state = live({ inFlight: true, inFlightSince: 0, lastProbeStartedAt: 0, nativeOutstanding: 1 });

    // Watchdog deadline passes while the native probe is genuinely still working.
    actions.push(nextProbeAction(state, DEFAULT_PROBE_CONFIG, 2_000).kind); // abandon
    state = { ...state, inFlight: false, inFlightSince: null };

    // Ticks during the remaining native time must add nothing.
    for (const now of [2_250, 2_500, 3_000, 3_500]) {
      actions.push(nextProbeAction(state, DEFAULT_PROBE_CONFIG, now).kind); // skip
    }

    // Native call settles at 3,659 ms (trace value for probeSeq 602).
    state = { ...state, nativeOutstanding: 0 };
    actions.push(nextProbeAction(state, DEFAULT_PROBE_CONFIG, 3_659).kind); // start

    expect(actions).toEqual(["start", "abandon", "skip", "skip", "skip", "skip", "start"]);
    expect(actions).not.toContain("restart");
    // Foreground was true for every single decision.
    expect(state.foreground).toBe(true);
  });

  it("issues exactly one native probe per settle across a long slow stretch", () => {
    // The collapse signature was schedulerRestartCount climbing 6→21 while no
    // frame was ever accepted. Under single-flight the count of issued probes
    // can never exceed the count of settles.
    let outstanding = 0;
    let inFlight = false;
    let inFlightSince: number | null = null;
    let lastProbeStartedAt: number | null = null;
    let started = 0;
    let settles = 0;

    for (let now = 0; now <= 40_000; now += 250) {
      // The native call settles 3,600 ms after it started.
      if (outstanding > 0 && inFlightSince != null && now - inFlightSince >= 3_600) {
        outstanding -= 1;
        settles += 1;
        inFlight = false;
      }
      const action = nextProbeAction(
        { foreground: true, activeGame: true, inFlight, inFlightSince, lastProbeStartedAt, nativeOutstanding: outstanding },
        DEFAULT_PROBE_CONFIG,
        now,
      );
      // `abandon` releases the logical guard and issues nothing, exactly as
      // App.tsx now applies it. Only `start` may add a native call.
      if (action.kind === "start") {
        started += 1;
        outstanding += 1;
        inFlight = true;
        inFlightSince = now;
        lastProbeStartedAt = now;
      } else if (action.kind === "abandon") {
        inFlight = false;
      }
      expect(outstanding).toBeLessThanOrEqual(1);
    }

    expect(started).toBeGreaterThan(0);
    expect(started - settles).toBeLessThanOrEqual(1);
  });

  it("18. still refuses to probe when foreground or the active game is gone", () => {
    // Single-flight must not weaken the compliance gate.
    expect(nextProbeAction(live({ foreground: false }), DEFAULT_PROBE_CONFIG, 10_000).kind).toBe("skip");
    expect(nextProbeAction(live({ activeGame: false }), DEFAULT_PROBE_CONFIG, 10_000).kind).toBe("skip");
  });
});

/**
 * The watchdog must stop invalidating the work it is waiting for.
 *
 * `geometrySeqRef` exists so a REPLACEMENT probe's result wins over the one it
 * replaced. With no replacement ever issued, bumping it has exactly one effect:
 * the in-flight probe's own result is declared stale on arrival and dropped at
 * App.tsx:1714 — above the surface commit, the offer FSM and the publications.
 * That is the mechanism that produced 6-of-6 stale results and a 32.657 s frozen
 * NO_OFFER state with three cards visible.
 */
describe("abandonment does not invalidate the in-flight result", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const watchdog = src.slice(
    src.indexOf('if (action.kind === "abandon")'),
    src.indexOf("void runGeometryProbe(scheduledAt)"),
  );

  it("has a watchdog block to inspect", () => {
    expect(watchdog.length).toBeGreaterThan(0);
  });

  it("never advances the capture sequence while abandoning", () => {
    expect(watchdog).not.toContain("geometrySeqRef.current += 1");
  });

  it("no longer has a restart branch anywhere in the geometry tick", () => {
    // `restart` is the only action that issued a second concurrent invoke.
    expect(src).not.toContain('action.kind === "restart" || action.kind === "abandon"');
  });

  it("counts the OCR track's outstanding natives instead of hardcoding zero", () => {
    // App.tsx:2815 pinned `nativeOutstanding: 0` for the identity probe, so the
    // OCR watchdog issued seven copies of the identical job (runIds 36-42,
    // 2109 ms apart) until they saturated the Rust MAX_CONCURRENT_CAPTURES gate.
    expect(src).not.toContain("nativeOutstanding: 0,");
  });
});
