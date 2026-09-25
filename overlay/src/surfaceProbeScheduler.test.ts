import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROBE_CONFIG,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  MAX_OUTSTANDING_NATIVE_PROBES,
  nextProbeAction,
  oldestNativeStart,
  type ProbeSchedulerConfig,
  type ProbeSchedulerState,
} from "./surfaceProbeScheduler";
import {
  GEOMETRY_INTERVAL_MS,
  GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS,
  completeGeometryAttempt,
  createGeometryHealthClocks,
  geometrySchedulerHealthy,
  markGeometryUnhealthyIfExpired,
  startGeometryAttempt,
} from "./surfaceGeometry";
import { realAugmentOverlayRenderable } from "./augmentOverlayGate";
import { frameResultIsCurrent } from "./visibleOfferFrame";

const base: ProbeSchedulerState = {
  foreground: true,
  activeGame: true,
  inFlight: false,
  inFlightSince: null,
  lastProbeStartedAt: null,
  nativeOutstanding: 0,
};

describe("nextProbeAction — self-healing, telemetry-independent", () => {
  it("starts immediately when foreground + active game and never probed", () => {
    expect(nextProbeAction(base, DEFAULT_PROBE_CONFIG, 1000)).toEqual({ kind: "start" });
  });

  it("respects the ~250ms cadence between starts", () => {
    const state = { ...base, lastProbeStartedAt: 1000 };
    expect(nextProbeAction(state, DEFAULT_PROBE_CONFIG, 1000 + 100)).toEqual({
      kind: "skip",
      reason: "not-due",
    });
    expect(nextProbeAction(state, DEFAULT_PROBE_CONFIG, 1000 + PROBE_INTERVAL_MS)).toEqual({
      kind: "start",
    });
  });

  it("never runs two probes at once (one in flight => skip)", () => {
    const state = { ...base, inFlight: true, inFlightSince: 1000, lastProbeStartedAt: 1000 };
    expect(nextProbeAction(state, DEFAULT_PROBE_CONFIG, 1000 + PROBE_INTERVAL_MS)).toEqual({
      kind: "skip",
      reason: "in-flight",
    });
  });

  it("watchdog abandons a probe stuck in flight past the bounded timeout", () => {
    const state = { ...base, inFlight: true, inFlightSince: 1000, lastProbeStartedAt: 1000 };
    expect(nextProbeAction(state, DEFAULT_PROBE_CONFIG, 1000 + PROBE_TIMEOUT_MS)).toEqual({
      kind: "abandon",
      reason: "in-flight-timeout",
    });
  });

  it("recovers a wedged scheduler: timeout → abandon → next tick starts fresh", () => {
    // A probe wedged in flight past the timeout: the reducer releases ownership.
    const wedged = { ...base, inFlight: true, inFlightSince: 1000, lastProbeStartedAt: 1000 };
    expect(nextProbeAction(wedged, DEFAULT_PROBE_CONFIG, 1000 + PROBE_TIMEOUT_MS)).toEqual({
      kind: "abandon",
      reason: "in-flight-timeout",
    });
    // Once the abandon tick resets the guard (inFlight=false) AND the native
    // call has drained (nativeOutstanding 0, which `base` holds), the very next
    // tick starts a fresh probe — recovery needs no remount or focus toggle.
    const recovered = { ...base, inFlight: false, inFlightSince: null, lastProbeStartedAt: 1000 };
    expect(nextProbeAction(recovered, DEFAULT_PROBE_CONFIG, 1000 + PROBE_TIMEOUT_MS)).toEqual({
      kind: "start",
    });
  });

  it("has no 'asleep' state: any foreground in-game tick starts, however old the last probe", () => {
    // Defect B (level-15 offer that never scanned): the scheduler is a pure
    // reducer with no internal memory, so a probe that last ran 60 s ago — under
    // any telemetry — still starts on the next foreground in-game tick.
    const longIdle = { ...base, lastProbeStartedAt: 1000 };
    expect(nextProbeAction(longIdle, DEFAULT_PROBE_CONFIG, 1000 + 60_000)).toEqual({ kind: "start" });
  });

  it("skips while the game is not foreground or no active game", () => {
    expect(nextProbeAction({ ...base, foreground: false }, DEFAULT_PROBE_CONFIG, 5000)).toEqual({
      kind: "skip",
      reason: "not-foreground",
    });
    expect(nextProbeAction({ ...base, activeGame: false }, DEFAULT_PROBE_CONFIG, 5000)).toEqual({
      kind: "skip",
      reason: "not-active-game",
    });
  });

  it("keeps probing across a long-running game (many ticks, still due later)", () => {
    // Simulate a long game: last probe ages out repeatedly and always re-arms.
    let lastStart = 0;
    for (let tick = 1; tick <= 2000; tick += 1) {
      const now = tick * PROBE_INTERVAL_MS;
      const action = nextProbeAction(
        { ...base, lastProbeStartedAt: lastStart },
        DEFAULT_PROBE_CONFIG,
        now,
      );
      expect(action.kind).toBe("start");
      lastStart = now;
    }
  });

  it("keeps the 150 ms geometry track alive through 2000 completed negative probes", () => {
    const geometryConfig = {
      intervalMs: GEOMETRY_INTERVAL_MS,
      timeoutMs: PROBE_TIMEOUT_MS,
    };
    let lastStart: number | null = null;
    for (let tick = 0; tick < 2000; tick += 1) {
      const now = tick * GEOMETRY_INTERVAL_MS;
      expect(
        nextProbeAction({ ...base, lastProbeStartedAt: lastStart }, geometryConfig, now),
      ).toEqual({ kind: "start" });
      lastStart = now;
    }
    expect(
      nextProbeAction(
        { ...base, lastProbeStartedAt: lastStart },
        geometryConfig,
        2000 * GEOMETRY_INTERVAL_MS,
      ),
    ).toEqual({ kind: "start" });
  });
});

/**
 * Backlog coalescing. The watchdog releases LOGICAL ownership but cannot cancel
 * the native invoke, so the old call stays outstanding. The live trace
 * (mayhem-four-phase-postfix-20260726-014355.log) showed the consequence: native
 * work stayed healthy (nativeElapsedMs ~610 ms) while roundTripMs reached
 * 47–63 s and ~70 invokes were outstanding — every 2.1 s watchdog restart added
 * one more. Geometry now bounds outstanding native calls to at most one
 * presumed-wedged zombie plus one active replacement — a hard ceiling of two —
 * still far below Rust's own per-channel cap of 4 (GEOMETRY_CAPTURE_IN_FLIGHT,
 * lib.rs:803).
 */
describe("native-outstanding coalescing", () => {
  const cfg = DEFAULT_PROBE_CONFIG;

  it("abandons ownership WITHOUT issuing another native call at the cap", () => {
    const action = nextProbeAction(
      {
        ...base,
        inFlight: true,
        inFlightSince: 0,
        nativeOutstanding: MAX_OUTSTANDING_NATIVE_PROBES,
      },
      cfg,
      PROBE_TIMEOUT_MS,
    );
    expect(action).toEqual({ kind: "abandon", reason: "in-flight-timeout" });
  });

  it("abandons identically regardless of how deep the native backlog is", () => {
    // The action must not depend on the backlog level: a timeout releases
    // ownership and issues nothing, whether one native call is outstanding or
    // several are left over from before the cap tightened.
    for (const nativeOutstanding of [0, 1, 2, 5]) {
      expect(
        nextProbeAction(
          { ...base, inFlight: true, inFlightSince: 0, nativeOutstanding },
          cfg,
          PROBE_TIMEOUT_MS,
        ),
      ).toEqual({ kind: "abandon", reason: "in-flight-timeout" });
    }
  });

  it("does not start a fresh probe while the native backlog is at the cap", () => {
    const action = nextProbeAction(
      {
        ...base,
        inFlight: false,
        lastProbeStartedAt: null,
        nativeOutstanding: MAX_OUTSTANDING_NATIVE_PROBES,
      },
      cfg,
      10_000,
    );
    expect(action).toEqual({ kind: "skip", reason: "native-backlog" });
  });

  it("resumes starting once outstanding native calls drain", () => {
    expect(
      nextProbeAction(
        { ...base, inFlight: false, lastProbeStartedAt: null, nativeOutstanding: 0 },
        cfg,
        10_000,
      ),
    ).toEqual({ kind: "start" });
  });

  it("bounds repeated stalls to exactly one written-off zombie plus one active probe across a sustained 60 s IPC backlog", () => {
    // Replays the observed failure: the native side never resolves, so every
    // tick for 60 s sees inFlight with an expired deadline. The OLD bound
    // (peak <= 1, asserted below via MAX_OUTSTANDING_NATIVE_PROBES) is exactly
    // what produced PERMANENT starvation once one call wedged — the trace
    // reached ~70 outstanding under the pre-cap code, but even at cap 1 the
    // scheduler never issues another call once the first one never settles.
    // The NEW bound is stricter in every dimension except one deliberate +1:
    // at most one presumed-wedged zombie plus one active replacement, and that
    // replacement is issued EXACTLY ONCE in the whole 60 s window — never a
    // third call, ever. `oldestNativeStartedAt` is set on the first start and
    // deliberately never cleared, since nothing settles in this scenario.
    // The ceiling of 2 (not 3+) stays well under Rust's own per-channel cap of
    // 4 (GEOMETRY_CAPTURE_IN_FLIGHT, lib.rs:803) — Rust already admits
    // concurrent retries beneath that cap precisely because a cap of 1
    // "starves every death-round retry" (lib.rs:792-798); this JS reducer was
    // the piece still negating that design.
    let outstanding = 0;
    let inFlight = false;
    let inFlightSince: number | null = null;
    let oldestNativeStartedAt: number | null = null;
    let peak = 0;
    let startCount = 0;
    for (let now = 0; now <= 60_000; now += GEOMETRY_INTERVAL_MS) {
      const action = nextProbeAction(
        {
          ...base,
          inFlight,
          inFlightSince,
          lastProbeStartedAt: null,
          nativeOutstanding: outstanding,
          oldestNativeStartedAt,
        },
        {
          intervalMs: GEOMETRY_INTERVAL_MS,
          timeoutMs: PROBE_TIMEOUT_MS,
          wedgedNativeMs: WEDGED_NATIVE_PROBE_MS,
        },
        now,
      );
      if (action.kind === "start") {
        outstanding += 1; // native call issued; never resolves in this scenario
        inFlight = true;
        inFlightSince = now;
        startCount += 1;
        if (oldestNativeStartedAt == null) oldestNativeStartedAt = now;
      } else if (action.kind === "abandon") {
        inFlight = false;
        inFlightSince = null;
      }
      peak = Math.max(peak, outstanding);
    }
    expect(peak).toBe(2);
    expect(startCount).toBe(2);
    expect(peak).toBeLessThanOrEqual(MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT);
  });
});

/**
 * Wedged native probe recovery (contract: /tmp/overlay-sol-gate-native-recovery/contract.md).
 *
 * Runtime evidence: one physical native call grew 1885 ms -> 340108 ms,
 * continuousUnhealthyAgeMs reached ~17 min and never recovered,
 * schedulerRestartCount climbed 1 -> 21, and nativeOutstanding stayed pinned
 * at 1 — because `backlogged = nativeOutstanding >= MAX_OUTSTANDING_NATIVE_PROBES`
 * (1) never releases once a native call never settles: no probe -> no accepted
 * geometry -> scheduler unhealthy forever -> badge layer suppressed for the
 * rest of the game.
 *
 * The fix (NOT implemented by these tests — this file only pins the target
 * behavior): once the OLDEST unsettled native call has been outstanding at
 * least a bounded "presumed wedged" threshold, the effective backlog cap
 * rises from 1 to 2, permitting EXACTLY ONE replacement probe.
 * `WEDGED_NATIVE_PROBE_MS` / `MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT` below
 * are LOCAL test constants mirroring the production constants that land with
 * the implementation step (`surfaceProbeScheduler.ts`); importing the
 * not-yet-existing production names here would fail the whole file's import
 * and destroy behavioral red.
 *
 * Threshold justification for 4000 ms:
 *   - 4000 = 2x PROBE_TIMEOUT_MS (2000), mirroring the one existing house
 *     precedent for a "looser than the logical deadline, still bounded" value:
 *     FOREGROUND_PAYLOAD_MAX_AGE_MS (3000) is exactly 2x
 *     FOREGROUND_LOGICAL_DEADLINE_MS (1500) in foregroundPollScheduler.ts:47,62.
 *   - Rust's own NATIVE_CAPTURE_TIMEOUT is 1500 ms (lib.rs:790), so a
 *     well-behaved probe returns well inside 4000 ms.
 *   - Observed healthy geometry roundTripMs in the live bundle: 704 and 1593;
 *     documented healthy p99 is 1731 ms. 4000 clears ordinary tail latency
 *     with margin, so the discount fires only on genuine wedges.
 *   - 4000 also bounds the badge blackout to ~4 s instead of the observed
 *     ~17 minutes.
 *
 * Bound-of-2 justification: lib.rs:792-798 documents that
 * MAX_CONCURRENT_CAPTURES "MUST be > 1: at a cap of 1 a single hung capture
 * starves every death-round retry, so no frame is ever produced and badges
 * never render at levels 11/15 (they render again once a retry that is
 * admitted beneath the cap captures a frame)." Rust deliberately admits
 * concurrent retries beneath a per-channel cap of 4
 * (GEOMETRY_CAPTURE_IN_FLIGHT, lib.rs:803). The JS scheduler's
 * MAX_OUTSTANDING_NATIVE_PROBES = 1 currently negates that design by never
 * issuing the retry Rust is built to admit. A JS ceiling of 2 stays well
 * under Rust's per-channel cap of 4.
 */
const WEDGED_NATIVE_PROBE_MS = 4_000; // 2x PROBE_TIMEOUT_MS — see justification above
const MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT = 2;

describe("wedged native probe recovery", () => {
  const wedgedConfig = { ...DEFAULT_PROBE_CONFIG, wedgedNativeMs: WEDGED_NATIVE_PROBE_MS };

  it("first request stalls past the logical deadline (scenario step 1: precondition, not new contract)", () => {
    const state = { ...base, inFlight: true, inFlightSince: 0, lastProbeStartedAt: 0 };
    expect(nextProbeAction(state, wedgedConfig, PROBE_TIMEOUT_MS)).toEqual({
      kind: "abandon",
      reason: "in-flight-timeout",
    });
  });

  it("still fails closed just below the wedge bound — the cap was not merely loosened", () => {
    const state = {
      ...base,
      inFlight: false,
      nativeOutstanding: 1,
      oldestNativeStartedAt: 0,
    };
    expect(nextProbeAction(state, wedgedConfig, WEDGED_NATIVE_PROBE_MS - 1)).toEqual({
      kind: "skip",
      reason: "native-backlog",
    });
  });

  it("THE PRIMARY RED: becomes eligible for a bounded replacement once the oldest native call has been outstanding at least the wedge threshold", () => {
    // Observed defect: a call reaching 340108 ms left `skip: "native-backlog"`
    // permanent forever after. 4000 ms = 2x PROBE_TIMEOUT_MS (2000 ms) — the
    // same "2x the logical deadline" ratio the house already uses for
    // FOREGROUND_PAYLOAD_MAX_AGE_MS vs FOREGROUND_LOGICAL_DEADLINE_MS
    // (foregroundPollScheduler.ts:47,62) — and comfortably clears Rust's own
    // NATIVE_CAPTURE_TIMEOUT (1500 ms, lib.rs:790) and the observed healthy
    // roundTripMs (704/1593 ms, p99 1731 ms), so it fires only on genuine
    // wedges while bounding the badge blackout to ~4 s instead of ~17 minutes.
    const state = {
      ...base,
      inFlight: false,
      nativeOutstanding: 1,
      oldestNativeStartedAt: 0,
    };
    expect(nextProbeAction(state, wedgedConfig, WEDGED_NATIVE_PROBE_MS)).toEqual({
      kind: "start",
    });
  });

  it("bounds the replacement to exactly one — a second wedge never raises the cap further", () => {
    // Ceiling of 2, never 3+: Rust's own MAX_CONCURRENT_CAPTURES is 4 per
    // channel (GEOMETRY_CAPTURE_IN_FLIGHT, lib.rs:803) precisely because a cap
    // of 1 "starves every death-round retry" (lib.rs:792-798). This JS ceiling
    // of 2 stays well under Rust's cap of 4 — it is not a race to match Rust's
    // concurrency, only a bounded discount on the one pathological case.
    const state = {
      ...base,
      inFlight: false,
      nativeOutstanding: 2,
      oldestNativeStartedAt: 0,
    };
    expect(nextProbeAction(state, wedgedConfig, 60_000)).toEqual({
      kind: "skip",
      reason: "native-backlog",
    });
  });

  it("ownership gating still dominates a fully satisfied wedge condition", () => {
    const wedgeSatisfied = {
      ...base,
      inFlight: false,
      nativeOutstanding: 1,
      oldestNativeStartedAt: 0,
    };
    expect(
      nextProbeAction({ ...wedgeSatisfied, foreground: false }, wedgedConfig, WEDGED_NATIVE_PROBE_MS),
    ).toEqual({ kind: "skip", reason: "not-foreground" });
    expect(
      nextProbeAction({ ...wedgeSatisfied, activeGame: false }, wedgedConfig, WEDGED_NATIVE_PROBE_MS),
    ).toEqual({ kind: "skip", reason: "not-active-game" });
  });

  it("steady state: normal single-flight operation resumes alongside one written-off zombie", () => {
    // Only the zombie remains outstanding (the replacement itself already
    // settled back down to 1) — the app keeps probing on the ordinary cadence
    // instead of staying dead.
    const state = {
      ...base,
      inFlight: false,
      nativeOutstanding: 1,
      oldestNativeStartedAt: 0,
      lastProbeStartedAt: WEDGED_NATIVE_PROBE_MS,
    };
    expect(
      nextProbeAction(state, wedgedConfig, WEDGED_NATIVE_PROBE_MS + PROBE_INTERVAL_MS),
    ).toEqual({ kind: "start" });
  });

  it("the identity/OCR track is untouched: the discount requires BOTH the wedge config and a tracked oldest start", () => {
    // Non-goal pin: identityProbeTick (App.tsx) calls nextProbeAction with
    // DEFAULT_PROBE_CONFIG and ocrNativeOutstandingRef, passing NEITHER
    // oldestNativeStartedAt NOR wedgedNativeMs — OCR concurrency is tracked
    // separately in Rust (OCR_RECOGNITION_IN_FLIGHT) and changing it is an
    // explicit non-goal of this slice. The discount must require BOTH new
    // inputs simultaneously, so every partial combination still falls back
    // to the unchanged cap of 1.
    const farPastWedge = WEDGED_NATIVE_PROBE_MS * 10;

    // 1) wedgedNativeMs configured, oldestNativeStartedAt omitted entirely —
    // the exact shape a future geometry-config typo would produce.
    expect(
      nextProbeAction(
        { ...base, inFlight: false, nativeOutstanding: 1 },
        wedgedConfig,
        farPastWedge,
      ),
    ).toEqual({ kind: "skip", reason: "native-backlog" });

    // 2) wedgedNativeMs configured, oldestNativeStartedAt explicitly null —
    // the shape the geometry track itself passes when nothing is
    // outstanding-but-tracked.
    expect(
      nextProbeAction(
        { ...base, inFlight: false, nativeOutstanding: 1, oldestNativeStartedAt: null },
        wedgedConfig,
        farPastWedge,
      ),
    ).toEqual({ kind: "skip", reason: "native-backlog" });

    // 3) oldestNativeStartedAt supplied, but the config is plain
    // DEFAULT_PROBE_CONFIG with no wedgedNativeMs — identityProbeTick's exact
    // call shape if state bookkeeping leaked across tracks.
    expect(
      nextProbeAction(
        { ...base, inFlight: false, nativeOutstanding: 1, oldestNativeStartedAt: 0 },
        DEFAULT_PROBE_CONFIG,
        farPastWedge,
      ),
    ).toEqual({ kind: "skip", reason: "native-backlog" });
  });

  it("a healthy run never triggers the discount, because settling clears the tracked oldest start", () => {
    // Guards the dangerous implementation bug this contract exists to
    // prevent: if oldestNativeStartedAt is set once and never cleared when
    // the backlog drains, then after the first few seconds
    // `now - oldestNativeStartedAt >= 4000` is permanently true, the
    // effective cap becomes permanently 2, and the overlay silently runs at
    // double native capture load for the entire game. This simulation
    // encodes the bookkeeping contract App.tsx must honor: settling back to
    // zero outstanding clears the tracked oldest start.
    const healthyConfig = {
      intervalMs: GEOMETRY_INTERVAL_MS,
      timeoutMs: PROBE_TIMEOUT_MS,
      wedgedNativeMs: WEDGED_NATIVE_PROBE_MS,
    };
    const SETTLE_MS = 700; // observed healthy geometry round trips: 704 ms, 1593 ms
    let outstanding = 0;
    let inFlight = false;
    let inFlightSince: number | null = null;
    let lastProbeStartedAt: number | null = null;
    let oldestNativeStartedAt: number | null = null;
    let peak = 0;
    let startCount = 0;
    let sawAbandon = false;
    const pendingSettles: number[] = [];

    for (let now = 0; now <= 60_000; now += GEOMETRY_INTERVAL_MS) {
      // Settle any native calls whose round trip has completed by this tick.
      while (pendingSettles.length > 0 && pendingSettles[0] <= now) {
        pendingSettles.shift();
        outstanding -= 1;
        inFlight = false;
        inFlightSince = null;
        if (outstanding === 0) oldestNativeStartedAt = null;
      }

      const action = nextProbeAction(
        {
          ...base,
          inFlight,
          inFlightSince,
          lastProbeStartedAt,
          nativeOutstanding: outstanding,
          oldestNativeStartedAt,
        },
        healthyConfig,
        now,
      );

      if (action.kind === "start") {
        outstanding += 1;
        inFlight = true;
        inFlightSince = now;
        lastProbeStartedAt = now;
        startCount += 1;
        if (oldestNativeStartedAt == null) oldestNativeStartedAt = now;
        pendingSettles.push(now + SETTLE_MS);
      } else if (action.kind === "abandon") {
        sawAbandon = true;
      }
      peak = Math.max(peak, outstanding);
    }

    expect(peak).toBe(1);
    expect(sawAbandon).toBe(false);
    expect(startCount).toBeGreaterThan(60);
  });
});

describe("wedge recovery restores render eligibility", () => {
  const authorizedGate = {
    devBuild: false,
    tierFixtureEnabled: false,
    memberCoachEnabled: true,
    previewMode: false,
    visibleFrameRenderable: true,
    offerSurfaceRenderable: true,
  };

  it("fails closed while wedged, becomes eligible once the replacement settles", () => {
    // Composes the REAL modules end-to-end (surfaceGeometry.ts health clocks ->
    // augmentOverlayGate.ts render gate), no React. This is the actual
    // consequence chain from the contract, not a scheduler-only assertion.
    let clocks = createGeometryHealthClocks();
    clocks = startGeometryAttempt(clocks, 1, 0); // the wedged call starts at t=0, never settles

    // (a) Past the health deadline with no accepted geometry, health is false
    // and the offer fails closed — hiding remains the safe direction.
    const stillWedgedAt = GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS;
    const unhealthyBefore = geometrySchedulerHealthy({
      now: stillWedgedAt,
      foreground: true,
      activeGame: true,
      lastAcceptedGeometryAt: clocks.lastAcceptedGeometryAt,
    });
    expect(unhealthyBefore).toBe(false);
    expect(
      realAugmentOverlayRenderable({ ...authorizedGate, geometrySchedulerHealthy: unhealthyBefore }),
    ).toBe(false);

    clocks = markGeometryUnhealthyIfExpired(clocks, stillWedgedAt);
    expect(clocks.continuousUnhealthyStartedAt).not.toBeNull();

    // (b) The wedge-recovery replacement (a fresh attempt generation, mirroring
    // App.tsx's geometrySeqRef bump at start) completes successfully.
    clocks = startGeometryAttempt(clocks, 2, 4_000); // replacement starts at the wedge threshold
    clocks = completeGeometryAttempt(clocks, {
      attemptGeneration: 2,
      completedAt: 4_050,
      accepted: true,
      renderAuthoritative: true,
    });
    expect(clocks.lastAcceptedGeometryAt).toBe(4_050);
    expect(clocks.continuousUnhealthyStartedAt).toBeNull();

    const healthyAfter = geometrySchedulerHealthy({
      now: 4_050,
      foreground: true,
      activeGame: true,
      lastAcceptedGeometryAt: clocks.lastAcceptedGeometryAt,
    });
    expect(healthyAfter).toBe(true);
    expect(
      realAugmentOverlayRenderable({ ...authorizedGate, geometrySchedulerHealthy: healthyAfter }),
    ).toBe(true);
  });

  it("rejects the wedged call's late return once a replacement bumps the capture sequence", () => {
    // App.tsx bumps geometrySeqRef at the start of every probe, including the
    // wedge-recovery replacement. The wedged call's own (older) captureSeq can
    // therefore never again pass frameResultIsCurrent — its late return cannot
    // overwrite newer state (App.tsx:768).
    const wedgedCaptureSeq = 5;
    const replacementCaptureSeq = 6;
    expect(frameResultIsCurrent(wedgedCaptureSeq, replacementCaptureSeq)).toBe(false);
    expect(frameResultIsCurrent(replacementCaptureSeq, replacementCaptureSeq)).toBe(true);
  });
});

/**
 * Per-request native-call ownership — the App.tsx `geometryOldestNativeStartedAtRef`
 * bug.
 *
 * App.tsx tracks the oldest unresolved native geometry call in a SINGLE
 * SCALAR ref:
 *   - App.tsx:1901-1903 — on probe start: set-if-null.
 *   - App.tsx:2468-2470 — in the settle `finally`: cleared to null ONLY once
 *     `nativeOutstanding` (a separate counter) reaches zero.
 *   - App.tsx:3089 — fed to `nextProbeAction` as `oldestNativeStartedAt`.
 *
 * Failure timeline: probe A starts at t0. The wedge discount (4000 ms) later
 * raises the backlog cap to 2 and a replacement B starts — the scalar still
 * holds A's t0 (set-if-null never overwrites it). A settles while B is still
 * outstanding: `nativeOutstanding` drops 1 -> 1 (never reaches 0, since B is
 * still there), so the scalar is NEVER cleared and keeps reporting A's t0
 * forever. Every tick after that computes `now - t0 >= 4000` as permanently
 * true, so the discount cap (2) is permanently active, and the very next time
 * the in-flight guard opens up (B's OWN watchdog release — see below) a THIRD
 * probe (C) is admitted even though B itself is nowhere near 4000 ms old. C
 * bumps `geometrySeqRef`, so B's otherwise-valid return is stale-rejected
 * (App.tsx:1937-1940).
 *
 * The fix (NOT implemented by this file): per-request ownership via
 * `oldestNativeStart`, a pure helper over a `Map<captureSeq, startedAt>` that
 * only the settling request's OWN entry is deleted from.
 *
 * Both scenarios below drive the REAL `nextProbeAction` reducer through a
 * deterministic tick loop (step = GEOMETRY_INTERVAL_MS, no timers, no
 * sleeps). A shared driver models exactly the App.tsx bookkeeping that
 * surrounds every real probe start / settle / watchdog-abandon —
 * `nativeOutstanding`, the single `inFlight`/`inFlightSince`/token guard —
 * and is parameterized ONLY by how the "oldest outstanding start" is tracked,
 * since that tracking is the sole scope of this bug.
 *
 * One real reducer mechanic shapes both scenarios below and is not itself in
 * question: `nextProbeAction` checks `state.inFlight` BEFORE it ever looks at
 * the native backlog (surfaceProbeScheduler.ts:140-151). Every probe —
 * including the wedge-recovery replacement — is subject to the SAME
 * PROBE_TIMEOUT_MS (2000 ms) in-flight watchdog before it is subject to the
 * WEDGED_NATIVE_PROBE_MS (4000 ms) backlog discount. So after a replacement
 * starts, there are necessarily two sub-windows before it can be superseded:
 * an `in-flight` skip window (0-2000 ms of the replacement's own age, gated
 * by its own watchdog) followed by a `native-backlog` skip window (2000-4000
 * ms of its age, gated by the oldest-tracking this contract targets). Both
 * scenarios assert across the WHOLE span that no premature replacement is
 * admitted, and assert the `native-backlog` reason specifically for the
 * sub-window where it is the operative gate.
 */
describe("native call ownership: per-request registry vs single-scalar oldest-start tracking", () => {
  const GEOMETRY_WEDGE_CONFIG = {
    intervalMs: GEOMETRY_INTERVAL_MS,
    timeoutMs: PROBE_TIMEOUT_MS,
    wedgedNativeMs: WEDGED_NATIVE_PROBE_MS,
  };

  // Local types for the driver + strategy objects below (types only — the
  // overlay tsconfig runs `strict: true`, so every parameter here needs an
  // explicit type to avoid implicit-any).
  interface Driver {
    outstanding: number; // geometryNativeOutstandingRef
    inFlight: boolean; // geometryInFlightRef
    inFlightSince: number | null; // geometryInFlightSinceRef
    lastProbeStartedAt: number | null; // lastGeometryStartedAtRef
    token: number | null; // geometryInFlightTokenRef
    nextSeq: number; // geometrySeqRef
    scalarOldest: number | null; // geometryOldestNativeStartedAtRef (scalarOwnership only)
    starts: Map<number, number>; // registryOwnership only
  }

  interface OwnershipStrategy {
    onStart(driver: Driver, seq: number, startedAt: number): void;
    onSettle(driver: Driver, seq: number): void;
    oldest(driver: Driver): number | null;
  }

  // Everything except the oldest-start tracking is identical to production
  // and independent of the strategy under test.
  function createDriver(): Driver {
    return {
      outstanding: 0, // geometryNativeOutstandingRef
      inFlight: false, // geometryInFlightRef
      inFlightSince: null, // geometryInFlightSinceRef
      lastProbeStartedAt: null, // lastGeometryStartedAtRef
      token: null, // geometryInFlightTokenRef
      nextSeq: 0, // geometrySeqRef
      scalarOldest: null, // geometryOldestNativeStartedAtRef (scalarOwnership only)
      starts: new Map(), // registryOwnership only
    };
  }

  // A faithful transcription of App.tsx's CURRENT (buggy) bookkeeping. This
  // exists to prove the timeline discriminates, not to validate production —
  // its assertions must hold BEFORE and AFTER the fix, since it models the
  // old code path, not the new one.
  const scalarOwnership: OwnershipStrategy = {
    onStart(driver, _seq, startedAt) {
      // App.tsx:1901-1903
      if (driver.scalarOldest == null) driver.scalarOldest = startedAt;
    },
    onSettle(driver, _seq) {
      // App.tsx:2468-2470 — cleared ONLY once every native call has drained.
      if (driver.outstanding === 0) driver.scalarOldest = null;
    },
    oldest(driver) {
      return driver.scalarOldest;
    },
  };

  // Per-request ownership via the production helper (does not exist yet —
  // this is this file's red).
  const registryOwnership: OwnershipStrategy = {
    onStart(driver, seq, startedAt) {
      driver.starts.set(seq, startedAt);
    },
    onSettle(driver, seq) {
      driver.starts.delete(seq);
    },
    oldest(driver) {
      return oldestNativeStart(driver.starts);
    },
  };

  // App.tsx:1892-1917 prologue, generalized over the ownership strategy.
  function start(driver: Driver, strategy: OwnershipStrategy, now: number): number {
    const seq = (driver.nextSeq += 1);
    driver.outstanding += 1;
    driver.inFlight = true;
    driver.inFlightSince = now;
    driver.lastProbeStartedAt = now;
    driver.token = seq;
    strategy.onStart(driver, seq, now);
    return seq;
  }

  // App.tsx:2455-2486 `finally` block, generalized over the ownership
  // strategy. Order matters: outstanding is decremented BEFORE the
  // oldest-tracking is updated (mirrors 2458-2470), and the guard is released
  // only if THIS request still owns the token (mirrors 2481-2485).
  function settle(driver: Driver, strategy: OwnershipStrategy, seq: number): void {
    driver.outstanding = Math.max(0, driver.outstanding - 1);
    strategy.onSettle(driver, seq);
    if (driver.token === seq) {
      driver.inFlightSince = null;
      driver.inFlight = false;
      driver.token = null;
    }
  }

  // App.tsx:3095-3153 abandon branch: releases ONLY the logical guard. The
  // native call is still running — outstanding and the oldest-tracking are
  // deliberately untouched.
  function abandon(driver: Driver): void {
    driver.inFlight = false;
    driver.inFlightSince = null;
    driver.token = null;
  }

  function tick(
    driver: Driver,
    strategy: OwnershipStrategy,
    config: ProbeSchedulerConfig,
    now: number,
  ) {
    const state: ProbeSchedulerState = {
      foreground: true,
      activeGame: true,
      inFlight: driver.inFlight,
      inFlightSince: driver.inFlightSince,
      lastProbeStartedAt: driver.lastProbeStartedAt,
      nativeOutstanding: driver.outstanding,
      oldestNativeStartedAt: strategy.oldest(driver),
    };
    const action = nextProbeAction(state, config, now);
    let seq = null;
    if (action.kind === "start") {
      seq = start(driver, strategy, now);
    } else if (action.kind === "abandon") {
      abandon(driver);
    }
    return { action, seq };
  }

  // Advances the tick clock while the in-flight guard holds, asserting every
  // intermediate tick is exactly `skip: in-flight`. Returns the abandon
  // result. The 200-tick bound is a safety net (PROBE_TIMEOUT_MS /
  // GEOMETRY_INTERVAL_MS is ~14) so a regression that removes the exit
  // condition fails fast instead of hanging.
  function driveUntilGuardReleased(
    driver: Driver,
    strategy: OwnershipStrategy,
    config: ProbeSchedulerConfig,
    clock: { now: number },
  ) {
    for (let guard = 0; guard < 200; guard += 1) {
      clock.now += GEOMETRY_INTERVAL_MS;
      const result = tick(driver, strategy, config, clock.now);
      if (result.action.kind === "abandon") {
        expect(result.action).toEqual({ kind: "abandon", reason: "in-flight-timeout" });
        return result;
      }
      expect(result.action).toEqual({ kind: "skip", reason: "in-flight" });
    }
    throw new Error("in-flight guard never released");
  }

  // Advances the tick clock while backlogged, asserting every intermediate
  // tick is exactly `skip: native-backlog`. Returns the start result.
  // (WEDGED_NATIVE_PROBE_MS - PROBE_TIMEOUT_MS) / GEOMETRY_INTERVAL_MS is
  // ~14, so 200 is a generous safety bound, not a real assertion.
  function driveUntilBacklogClears(
    driver: Driver,
    strategy: OwnershipStrategy,
    config: ProbeSchedulerConfig,
    clock: { now: number },
  ) {
    for (let guard = 0; guard < 200; guard += 1) {
      clock.now += GEOMETRY_INTERVAL_MS;
      const result = tick(driver, strategy, config, clock.now);
      if (result.action.kind === "start") return result;
      expect(result.action).toEqual({ kind: "skip", reason: "native-backlog" });
    }
    throw new Error("native backlog never cleared");
  }

  // `tick()`'s returned `seq` is `number | null` (null on every non-"start"
  // action). Every call site below only captures it immediately after
  // asserting the action WAS "start", so it is always a real seq at that
  // point — this just narrows the type to match that already-asserted fact.
  function requireSeq(seq: number | null): number {
    if (seq == null) throw new Error("expected tick() to have returned a captured seq");
    return seq;
  }

  it("scalarOwnership: proves the timeline discriminates — admits a replacement (C) while B is still younger than the wedge threshold", () => {
    const driver = createDriver();
    const clock = { now: 0 };
    let peak = 0;

    // A starts at t=0.
    const aStart = tick(driver, scalarOwnership, GEOMETRY_WEDGE_CONFIG, clock.now);
    expect(aStart.action).toEqual({ kind: "start" });
    const aSeq = requireSeq(aStart.seq);
    peak = Math.max(peak, driver.outstanding);

    // A's own PROBE_TIMEOUT_MS watchdog releases the guard.
    driveUntilGuardReleased(driver, scalarOwnership, GEOMETRY_WEDGE_CONFIG, clock);
    peak = Math.max(peak, driver.outstanding);

    // Backlogged (cap 1, only A tracked) until A's start ages past the wedge
    // threshold — the wedge-recovery replacement B starts.
    const bStart = driveUntilBacklogClears(driver, scalarOwnership, GEOMETRY_WEDGE_CONFIG, clock);
    const bSeq = bStart.seq;
    const bStartAt = clock.now;
    expect(bStartAt).toBeGreaterThanOrEqual(WEDGED_NATIVE_PROBE_MS);
    expect(driver.outstanding).toBe(2); // A zombie + B replacement
    peak = Math.max(peak, driver.outstanding);

    // A settles while B is still young (mirrors the diagnosed t0+4500
    // timeline). Outstanding drops 2 -> 1, NOT to 0, so App.tsx's
    // clear-only-at-zero scalar keeps reporting A's stale t0 instead of B's.
    settle(driver, scalarOwnership, aSeq);
    expect(driver.outstanding).toBe(1);
    expect(scalarOwnership.oldest(driver)).toBe(0); // still A's t0 — the bug
    expect(driver.inFlight).toBe(true); // B still owns the guard

    // B's own PROBE_TIMEOUT_MS watchdog releases the guard next.
    driveUntilGuardReleased(driver, scalarOwnership, GEOMETRY_WEDGE_CONFIG, clock);
    peak = Math.max(peak, driver.outstanding);
    const bAgeAtNextTick = clock.now - bStartAt;
    expect(bAgeAtNextTick).toBeLessThan(WEDGED_NATIVE_PROBE_MS);

    // THE DISCRIMINATING MOMENT: the scalar is permanently stuck reporting
    // A's t0 (0), so `now - 0 >= WEDGED_NATIVE_PROBE_MS` is already true —
    // the discount cap (2) applies, outstanding (1, just B) is under it, and
    // a THIRD probe (C) is admitted on the very next tick, while B itself is
    // well short of the 4000 ms wedge threshold.
    clock.now += GEOMETRY_INTERVAL_MS;
    const cStart = tick(driver, scalarOwnership, GEOMETRY_WEDGE_CONFIG, clock.now);
    expect(cStart.action).toEqual({ kind: "start" });
    const bAgeAtCAdmission = clock.now - bStartAt;
    expect(bAgeAtCAdmission).toBeLessThan(WEDGED_NATIVE_PROBE_MS);
    peak = Math.max(peak, driver.outstanding);
    expect(peak).toBeLessThanOrEqual(MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT);
  });

  it("registryOwnership: THE PRIMARY RED — per-request timestamps correctly deny a replacement until B itself reaches the wedge threshold", () => {
    const driver = createDriver();
    const clock = { now: 0 };
    let peak = 0;

    // A starts at t=0.
    const aStart = tick(driver, registryOwnership, GEOMETRY_WEDGE_CONFIG, clock.now);
    expect(aStart.action).toEqual({ kind: "start" });
    const aSeq = requireSeq(aStart.seq);
    const aStartAt = clock.now;
    peak = Math.max(peak, driver.outstanding);

    // A's own PROBE_TIMEOUT_MS watchdog releases the guard.
    driveUntilGuardReleased(driver, registryOwnership, GEOMETRY_WEDGE_CONFIG, clock);

    // Backlogged until A's start ages past the wedge threshold — B starts.
    const bStart = driveUntilBacklogClears(driver, registryOwnership, GEOMETRY_WEDGE_CONFIG, clock);
    const bSeq = requireSeq(bStart.seq);
    const bStartAt = clock.now;
    expect(bStartAt).toBeGreaterThanOrEqual(WEDGED_NATIVE_PROBE_MS);
    expect(driver.outstanding).toBe(2); // A zombie + B replacement — peak of 2
    peak = Math.max(peak, driver.outstanding);

    // A settles first, while B is still unresolved. Capture the token before
    // settling so the "does not release B's ownership" check below is
    // meaningful (B currently owns it).
    expect(driver.starts.has(aSeq)).toBe(true);
    expect(driver.starts.has(bSeq)).toBe(true);
    const tokenBeforeASettles = driver.token;
    expect(tokenBeforeASettles).toBe(bSeq); // B is the current guard owner

    settle(driver, registryOwnership, aSeq);

    // A's settlement removes A's start timestamp ONLY.
    expect(driver.starts.has(aSeq)).toBe(false);
    expect(driver.starts.has(bSeq)).toBe(true);
    expect(driver.outstanding).toBe(1);

    // After A settles, the value handed to the scheduler is B's start time —
    // not A's, not null, not 0.
    expect(oldestNativeStart(driver.starts)).toBe(bStartAt);
    expect(oldestNativeStart(driver.starts)).not.toBeNull();
    expect(oldestNativeStart(driver.starts)).not.toBe(aStartAt);
    expect(oldestNativeStart(driver.starts)).not.toBe(0);

    // A's settlement does NOT release B's logical ownership/token
    // (App.tsx:2481-2485 clears the guard only when `token === captureSeq`,
    // and A's own captureSeq is not B's).
    expect(driver.token).toBe(tokenBeforeASettles);
    expect(driver.token).toBe(bSeq);
    expect(driver.inFlight).toBe(true); // B still owns the guard

    // B's own PROBE_TIMEOUT_MS watchdog releases the guard (skip:in-flight
    // throughout — this sub-window is gated by B's own watchdog, not by the
    // native backlog the oldest-tracking fix targets).
    driveUntilGuardReleased(driver, registryOwnership, GEOMETRY_WEDGE_CONFIG, clock);
    const bAgeAtGuardRelease = clock.now - bStartAt;
    expect(bAgeAtGuardRelease).toBeLessThan(WEDGED_NATIVE_PROBE_MS);
    peak = Math.max(peak, driver.outstanding);

    // C is DENIED (native-backlog) at every tick from here until B itself
    // reaches the wedge threshold — the correctly-tracked oldest start is
    // B's, not A's stale one, so the discount does not fire early.
    const cStart = driveUntilBacklogClears(driver, registryOwnership, GEOMETRY_WEDGE_CONFIG, clock);
    const bAgeAtCAdmission = clock.now - bStartAt;

    // C is ALLOWED once B reaches the wedge threshold — exactly one
    // replacement admitted at that point.
    expect(cStart.action).toEqual({ kind: "start" });
    expect(bAgeAtCAdmission).toBeGreaterThanOrEqual(WEDGED_NATIVE_PROBE_MS);
    expect(driver.outstanding).toBe(2); // B zombie + C replacement
    peak = Math.max(peak, driver.outstanding);

    // Exactly one replacement: the tick immediately after C starts is NOT
    // another start (C now owns the in-flight guard).
    clock.now += GEOMETRY_INTERVAL_MS;
    const afterC = tick(driver, registryOwnership, GEOMETRY_WEDGE_CONFIG, clock.now);
    expect(afterC.action.kind).not.toBe("start");
    peak = Math.max(peak, driver.outstanding);

    // Unresolved native calls never exceeded 2 at any tick across the whole
    // timeline.
    expect(peak).toBe(MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT);
    expect(peak).toBeLessThanOrEqual(MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT);
  });

  describe("oldestNativeStart", () => {
    it("returns null for an empty map — never 0, never Infinity", () => {
      const result = oldestNativeStart(new Map());
      expect(result).toBeNull();
      expect(result).not.toBe(0);
    });

    it("returns the single entry's value", () => {
      expect(oldestNativeStart(new Map([[1, 500]]))).toBe(500);
    });

    it("returns the minimum across multiple entries", () => {
      const starts = new Map([
        [1, 500],
        [2, 100],
        [3, 900],
      ]);
      expect(oldestNativeStart(starts)).toBe(100);
    });

    it("returns the next-oldest once the current minimum is deleted", () => {
      const starts = new Map([
        [1, 500],
        [2, 100],
        [3, 900],
      ]);
      starts.delete(2); // remove the current minimum (100)
      expect(oldestNativeStart(starts)).toBe(500);
    });

    it("returns null once the last entry is deleted", () => {
      const starts = new Map([[1, 500]]);
      starts.delete(1);
      expect(oldestNativeStart(starts)).toBeNull();
    });
  });
});
