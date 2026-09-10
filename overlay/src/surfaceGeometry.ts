/**
 * Geometry-provider presence: the Round-6 replacement for OCR-title presence.
 *
 * A cheap Rust pixel probe (`probe_augment_surface`) is the AUTHORITY for three
 * things OCR must never decide:
 *   - present: is a three-card augment surface on screen right now;
 *   - occluded: is a dialog/scoreboard covering the offer (cards behind a panel);
 *   - visual freshness: the most recent accepted card rectangles/fingerprints.
 *
 * OCR is a separate, TRIGGERED track that only supplies per-slot identity. This
 * split fixes the live failures: confidence hysteresis preserves a positive
 * static offer through one uncertain observation, and scheduler health keeps
 * that frame renderable while a normal newer probe is in flight. OCR false-
 * negatives on unchanged pixels never drop presence, and the AFK modal
 * (readable card text behind it) is classified occluded → zero chips.
 *
 * Every value here is pure so presence/occlusion/health/reroll rules are
 * unit-tested without timers, IPC, or React. Mirrors the Rust SurfaceObservation
 * (serde camelCase).
 */
import type { PhysicalRect } from "./calibration";
import { PROBE_TIMEOUT_MS } from "./surfaceProbeScheduler";
import {
  emptyVisibleFrame,
  type VisibleOfferFrame,
  type VisibleSlot,
} from "./visibleOfferFrame";

/** Fast geometry cadence — sub-second detection, independent of slow OCR. */
export const GEOMETRY_INTERVAL_MS = 150;
/**
 * Longest full-probe duration treated as healthy by the deterministic latency
 * matrix. The live rolling diagnostics collect the actual capture+analysis+IPC+
 * publication distribution; this bound deliberately covers its 1 s test case.
 */
export const GEOMETRY_FULL_PROBE_P99_BUDGET_MS = 1000;
export const GEOMETRY_HEALTH_SAFETY_MARGIN_MS = 250;
/** Maximum wall-clock age of the last accepted geometry publication. */
export const GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS = Math.max(
  3 * GEOMETRY_INTERVAL_MS,
  GEOMETRY_FULL_PROBE_P99_BUDGET_MS + GEOMETRY_HEALTH_SAFETY_MARGIN_MS,
);
/**
 * Two fingerprints (144-bit average-hash bitstrings) are "the same card" within
 * this Hamming tolerance. Identical pixels hash to distance 0; different augments
 * measured ≥12 on the fixtures — 8 sits clear of both with margin.
 */
export const FINGERPRINT_CHANGED_HAMMING = 8;
/** An unresolved slot re-triggers OCR after this long (retry deadline). */
export const IDENTITY_RETRY_MS = 1500;
/**
 * Bounded negative continuity (FIX 1). A NEGATIVE geometry observation (0 or 1
 * strong card) following a stable positive preserves the prior visible state for
 * up to this many consecutive frames before clearing, so a transient detector
 * false-negative never blanks resolved chips or converts them to OCR ERROR. A
 * value of 2 preserves one negative frame and clears on the second consecutive.
 */
export const GEOMETRY_NEGATIVE_CONTINUITY_FRAMES = 2;

/** Per-card structural observation from the Rust geometry probe. */
export interface GeometryCard {
  regionIndex: number;
  present: boolean;
  /** Name-band rect (calibrated logical space) for chip rendering; null absent. */
  cardRect: PhysicalRect | null;
  interiorLuma: number;
  interiorStd: number;
  frameContrast: number;
  edgeEnergy: number;
  structuralScore: number;
  /** 144-bit average-hash bitstring of the icon+name window. */
  fingerprint: string;
}

/** One geometry probe result — presence/occlusion/visual-freshness authority. */
export interface GeometryObservation {
  probeSeq: number;
  capturedAt: number;
  captureWidth: number;
  captureHeight: number;
  present: boolean;
  occluded: boolean;
  confidence: number;
  blueControl?: {
    present: boolean;
    confidence: number;
    normalizedRect: { x: number; y: number; width: number; height: number };
    features?: {
      aspectRatio: number;
      blueBodyCoverage: number;
      bodySaturation: number;
      borderContrast: number;
      centralIconCoverage: number;
    };
  };
  cards: GeometryCard[];
  rejectionReasons: string[];
  preCaptureMs: number;
  captureMs: number;
  analysisMs: number;
  elapsedMs: number;
  /**
   * Command entry → the blocking capture closure actually starting (Rust
   * `dispatchWaitMs`). This is `spawn_blocking` QUEUE latency, NOT async-runtime
   * starvation — no *suspension point* precedes the dispatch (the `.await`s on
   * the way poll their `async fn`s inline; the first thing that can yield comes
   * after the spawn), so it needs no async worker and reads ~0 even under total
   * starvation. A large value means the blocking pool is saturated.
   * OPTIONAL: absent on every observation recorded before the measurement
   * shipped, and absent on JS-built observations.
   */
  dispatchWaitMs?: number;
  /**
   * The blocking closure returning → the command returning (Rust
   * `resumeWaitMs`). This one DOES measure async-runtime scheduling latency:
   * re-polling the woken timeout requires an async worker.
   * OPTIONAL for the same reason as `dispatchWaitMs`.
   */
  resumeWaitMs?: number;
}

export type GeometryClassification = "present" | "uncertain" | "absent";
export type GeometryHideReason =
  | "confirmed-absent"
  | "confirmed-weak-negative"
  | "occluded"
  | "uncertain-without-positive";

export interface GeometrySurfaceState {
  visualObservation: GeometryObservation | null;
  lastPositiveObservation: GeometryObservation | null;
  consecutiveWeakNegatives: number;
}

export interface GeometrySurfaceTransition {
  state: GeometrySurfaceState;
  classification: GeometryClassification;
  action: "publish" | "preserve" | "clear";
  hideReason: GeometryHideReason | null;
}

export function createGeometrySurfaceState(): GeometrySurfaceState {
  return {
    visualObservation: null,
    lastPositiveObservation: null,
    consecutiveWeakNegatives: 0,
  };
}

export function emptyGeometryObservation(
  probeSeq: number,
  capturedAt: number,
  reason = "no-observation",
): GeometryObservation {
  return {
    probeSeq,
    capturedAt,
    captureWidth: 0,
    captureHeight: 0,
    present: false,
    occluded: false,
    confidence: 0,
    blueControl: {
      present: false,
      confidence: 0,
      normalizedRect: { x: 0.435, y: 0.758, width: 0.13, height: 0.067 },
    },
    cards: [0, 1, 2].map((regionIndex) => ({
      regionIndex,
      present: false,
      cardRect: null,
      interiorLuma: 0,
      interiorStd: 0,
      frameContrast: 0,
      edgeEnergy: 0,
      structuralScore: 0,
      fingerprint: "",
    })),
    rejectionReasons: [reason],
    preCaptureMs: 0,
    captureMs: 0,
    analysisMs: 0,
    elapsedMs: 0,
  };
}

/**
 * Honest, elapsed-aware probe label.
 *
 * The expression this replaces (`captureValid ? "none" : reasons[0]`) had NO
 * elapsed-time input, so every one of the 19 round34 probes that took ≥10 s —
 * up to a 305 s round trip — was labelled `"none"`. Deciding from the deadline
 * as well as from the pixels makes that impossible.
 *
 * LABELLING ONLY. This never reaches a scheduling decision: `nextProbeAction`
 * keeps deciding from `inFlightSince` / `nativeOutstanding` /
 * `oldestNativeStartedAt` alone.
 *
 * Pure: deterministic, no clock, no I/O, no input mutation.
 */
export function classifyProbeTimeout(input: {
  captureWidth: number;
  captureHeight: number;
  rejectionReasons: readonly string[];
  /** JS invoke round trip (`completedAt - startedAt`). */
  roundTripMs: number;
  /** Rust `elapsed_ms` for the whole command body. */
  nativeElapsedMs: number;
  /** Watchdog deadline; defaults to the scheduler's own `PROBE_TIMEOUT_MS`. */
  timeoutMs?: number;
}): string {
  // 1. Invalid capture — byte-for-byte today's behavior. A rejection reason names
  //    a concrete cause and the deadline does not, so it wins even when the probe
  //    was ALSO starved (real row probeSeq 484).
  if (input.captureWidth <= 0 || input.captureHeight <= 0) {
    return input.rejectionReasons[0] ?? "capture-invalid";
  }
  // 2. Deadline exceeded. Either leg alone is sufficient: a starved native call
  //    and a stalled transport are both real, and neither may read as healthy.
  //    INCLUSIVE (`>=`) to agree with `nextProbeAction`'s own watchdog test
  //    `now - inFlightSince >= timeoutMs` on the same instant.
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (Math.max(input.roundTripMs, input.nativeElapsedMs) >= timeoutMs) {
    return "watchdog-exceeded";
  }
  // 3. Rejection reasons on a VALID capture (e.g. `insufficient-cards-0/3`) are a
  //    capture-validity signal, not a latency signal.
  return "none";
}

/** `undefined` / `NaN` / negative all read as 0. */
function nonNegMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Every millisecond of one probe, attributed. */
export interface GeometryTimingDecomposition {
  /** The whole. Every segment below sums to exactly this. */
  totalMs: number;
  /** Segments 7+8+9 — the blocking closure's own work. */
  closureWorkMs: number;
  /**
   * Segment 6 — `spawn_blocking` QUEUE latency. Needs no async worker to cross,
   * so it reads ~0 even under total async-runtime starvation; a large value
   * indicts the BLOCKING POOL, not the runtime. 0 when unmeasured.
   */
  dispatchWaitMs: number;
  /**
   * Segment 10 — the awaiting task polled again after its worker finished.
   * Crossing this DOES need an async worker, so this is the in-Rust
   * async-runtime starvation signal. 0 when unmeasured.
   */
  resumeWaitMs: number;
  /**
   * In-Rust time the named segments do not explain (explicit residual).
   *
   * Its MEANING CHANGED with this instrumentation, which matters when comparing
   * against pre-instrumentation traces. Before, it absorbed dispatch + resume —
   * that is where Phase 1's 166,522 ms sat. Now that those two bracket the
   * closure exactly, the residual is in-closure work between the measured
   * phases (`capture_rect_for_monitor`, the `physical_rect_for_region` calls,
   * the `DynamicImage` wrap) plus millisecond-truncation slop. It is NOT
   * async-runtime time.
   */
  unattributedNativeMs: number;
  /**
   * Segments 3+12 — IPC in and out of the webview, PLUS two delays that are not
   * IPC at all:
   * 1. Scheduling before the command future's first poll. Tauri spawns that
   *    future onto the async runtime and the Rust clock only starts at the first
   *    poll, so pre-first-poll starvation is invisible to `elapsedMs`.
   * 2. Main-thread IPC blocking. `get_foreground_state` is a NON-async command,
   *    so Tauri runs it inline on the IPC/main thread, queueing ahead of every
   *    other IPC message including this probe — on a 250 ms poll clock.
   *
   * So a large `transportMs` is a starvation candidate, but do not jump to
   * ASYNC-RUNTIME starvation: main-thread blocking is at least as likely and is
   * the mechanism this repo has already characterised.
   */
  transportMs: number;
  /**
   * dispatch + resume + unattributed + transport — i.e. everything that is not
   * the blocking closure's own work.
   *
   * NOTE: the name oversells it. TWO of its four parts are not async-runtime
   * time — `dispatchWaitMs` is blocking-pool queueing, and
   * `unattributedNativeMs` is in-closure work. Read the parts individually
   * before attributing this total to the runtime.
   */
  asyncRuntimeMs: number;
}

/**
 * Attribute a probe's round trip to the closure's own work vs everything else.
 * The segments have DIFFERENT causes — see each field's doc; only `resumeWaitMs`
 * and (partly) `transportMs` are async-runtime time.
 *
 * The decomposition ACCOUNTS FOR THE WHOLE: `closureWorkMs + dispatchWaitMs +
 * resumeWaitMs + unattributedNativeMs + transportMs === totalMs` for every
 * INTEGER-millisecond input — which is all production supplies (`roundTripMs` is
 * `Math.round`ed, the rest arrive as Rust `u64`). The identity is exact in real
 * arithmetic for any input, but IEEE-754 rounding can leave a ~1-ULP residue on
 * fractional inputs, so do not assert bit equality on synthetic fractions.
 * Silently dropping milliseconds would reproduce the exact blind spot this
 * exists to remove, so the residual is explicit and the totals never clamp
 * DOWN — sub-phase time exceeding the reported native total, or native time
 * exceeding the round trip, is kept rather than discarded.
 *
 * DIAGNOSTIC ONLY: arithmetic over numbers a probe already reported. It feeds no
 * cadence, cap, watchdog, epoch guard, or staleness rule. Pure.
 */
export function decomposeGeometryTiming(input: {
  roundTripMs: number;
  nativeElapsedMs: number;
  preCaptureMs: number;
  captureMs: number;
  analysisMs: number;
  dispatchWaitMs?: number;
  resumeWaitMs?: number;
}): GeometryTimingDecomposition {
  const closureWorkMs =
    nonNegMs(input.preCaptureMs) +
    nonNegMs(input.captureMs) +
    nonNegMs(input.analysisMs);
  const dispatchWaitMs = nonNegMs(input.dispatchWaitMs);
  const resumeWaitMs = nonNegMs(input.resumeWaitMs);
  const measuredNativeMs = closureWorkMs + dispatchWaitMs + resumeWaitMs;
  const nativeElapsedMs = nonNegMs(input.nativeElapsedMs);
  const unattributedNativeMs = Math.max(0, nativeElapsedMs - measuredNativeMs);
  const nativeTotalMs = Math.max(nativeElapsedMs, measuredNativeMs);
  const transportMs = Math.max(0, nonNegMs(input.roundTripMs) - nativeTotalMs);
  const totalMs = Math.max(nonNegMs(input.roundTripMs), nativeTotalMs);
  return {
    totalMs,
    closureWorkMs,
    dispatchWaitMs,
    resumeWaitMs,
    unattributedNativeMs,
    transportMs,
    asyncRuntimeMs:
      dispatchWaitMs + resumeWaitMs + unattributedNativeMs + transportMs,
  };
}

/** Hamming distance between two equal-length bitstrings (∞ if lengths differ). */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
}

/**
 * True when two fingerprints describe DIFFERENT cards (a reroll). An empty
 * fingerprint (no card) never "matches" a real one. Distances at or below the
 * tolerance are the same card surviving identical-pixel probes.
 */
export function fingerprintChanged(previous: string, current: string): boolean {
  if (previous.length === 0 || current.length === 0) return previous !== current;
  return hammingDistance(previous, current) > FINGERPRINT_CHANGED_HAMMING;
}

/**
 * Three-way raw classification. Zero structures are confirmed absent only when
 * native capture and analysis actually completed; a capture/IPC failure has no
 * pixels and is uncertain. Occlusion is an orthogonal immediate-clear.
 */
export function classifyGeometryObservation(
  observation: GeometryObservation,
): GeometryClassification {
  const strongCards = observation.cards.filter((card) => card.present).length;
  if (strongCards >= 2) return "present";
  if (
    strongCards === 0 &&
    observation.captureWidth > 0 &&
    observation.captureHeight > 0
  ) {
    return "absent";
  }
  return "uncertain";
}

function stabilizePresentObservation(
  previous: GeometryObservation | null,
  current: GeometryObservation,
): GeometryObservation {
  if (previous == null) return current;
  return {
    ...current,
    cards: current.cards.map((card, regionIndex) => {
      if (card.present) return card;
      const old = previous.cards[regionIndex];
      if (
        old?.present &&
        !fingerprintChanged(old.fingerprint, card.fingerprint)
      ) {
        return old;
      }
      return card;
    }),
  };
}

/**
 * Confidence hysteresis for the visual geometry surface.
 *
 * - ≥2 strong cards enters/remains present.
 * - 1 strong card is uncertain: preserve one completed cycle, clear on two.
 * - 0 strong cards is high-confidence absence and clears immediately.
 * - explicit occlusion always clears immediately.
 *
 * Preserving uses the last accepted geometry observation, so resolved chips do
 * not degrade to SCANNING merely because a borderline probe was uncertain.
 */
export function advanceGeometrySurface(
  previous: GeometrySurfaceState,
  observation: GeometryObservation,
): GeometrySurfaceTransition {
  const classification = classifyGeometryObservation(observation);
  const captureValid =
    observation.captureWidth > 0 && observation.captureHeight > 0;
  if (observation.occluded) {
    return {
      classification,
      action: "clear",
      hideReason: "occluded",
      state: {
        visualObservation: null,
        lastPositiveObservation: previous.lastPositiveObservation,
        consecutiveWeakNegatives: 0,
      },
    };
  }
  if (classification === "present") {
    const stabilized = stabilizePresentObservation(
      previous.lastPositiveObservation,
      observation,
    );
    return {
      classification,
      action: "publish",
      hideReason: null,
      state: {
        visualObservation: stabilized,
        lastPositiveObservation: stabilized,
        consecutiveWeakNegatives: 0,
      },
    };
  }
  // A missing/failed/timed-out capture is uncertainty, never visual proof that
  // the offer closed. Preserve the last authoritative pixels without consuming
  // the bounded weak-negative budget; the independent accepted-geometry clock
  // hides presentation if no authoritative result arrives before the deadline.
  if (!captureValid) {
    if (previous.visualObservation != null) {
      return {
        classification,
        action: "preserve",
        hideReason: null,
        state: previous,
      };
    }
    return {
      classification,
      action: "clear",
      hideReason: "uncertain-without-positive",
      state: previous,
    };
  }
  // A completed, valid 0-card capture is authoritative no-offer evidence. It
  // clears immediately so badges/placeholders cannot float over terrain after
  // selection. The bounded continuity below is reserved for a structurally
  // borderline 1-card frame (hover/animation), not a genuine zero-card frame.
  if (classification === "absent") {
    return {
      classification,
      action: "clear",
      hideReason: "confirmed-absent",
      state: {
        visualObservation: null,
        lastPositiveObservation: null,
        consecutiveWeakNegatives: 0,
      },
    };
  }
  // A structurally borderline one-card observation that follows a stable
  // positive gets bounded continuity. This is the hover/animation tolerance:
  // one uncertain frame preserves the prior surface, while a repeated
  // borderline frame clears. Valid zero-card observations were handled above
  // as authoritative absence.
  const weakCount = previous.consecutiveWeakNegatives + 1;
  if (previous.visualObservation != null && weakCount < GEOMETRY_NEGATIVE_CONTINUITY_FRAMES) {
    return {
      classification,
      action: "preserve",
      hideReason: null,
      state: {
        visualObservation: previous.visualObservation,
        lastPositiveObservation: previous.lastPositiveObservation,
        consecutiveWeakNegatives: weakCount,
      },
    };
  }
  return {
    classification,
    action: "clear",
    hideReason: previous.visualObservation == null
      ? "uncertain-without-positive"
      : "confirmed-weak-negative",
    state: {
      visualObservation: null,
      lastPositiveObservation: null,
      consecutiveWeakNegatives: weakCount,
    },
  };
}

/**
 * The offer is a NEW offer relative to the previous observation when it went
 * absent→present, or when ≥2 slots changed fingerprint while staying present
 * (a queued round replaced the completed one). A single-slot change is a reroll.
 *
 * Session identity does NOT key off a transient preserved-negative frame: a
 * single masked false-negative is not proof a round closed (it also occurs on a
 * dropped frame mid-offer), so treating it as a boundary would misclassify a
 * one-slot reroll that coincides with a dropped frame as a whole new offer. A
 * genuine close is a fresh valid zero-card observation (clear →
 * lastPositiveObservation nulled → this returns true on the next present frame
 * regardless of card overlap). Repeated augments across rounds
 * legitimately keep their champion-specific badge, so retaining them is correct,
 * not stale.
 */
export function newOfferDetected(
  previous: GeometryObservation | null,
  current: GeometryObservation,
): boolean {
  if (!current.present || current.occluded) return false;
  if (previous == null || !previous.present) return true;
  let changed = 0;
  for (let i = 0; i < current.cards.length; i += 1) {
    const prev = previous.cards[i]?.fingerprint ?? "";
    const curr = current.cards[i]?.fingerprint ?? "";
    if (current.cards[i]?.present && fingerprintChanged(prev, curr)) changed += 1;
  }
  return changed >= 2;
}

export interface GeometryHealthClocks {
  /** Generation and start time of the current logical attempt. */
  currentAttemptGeneration: number | null;
  currentAttemptStartedAt: number | null;
  /** Start of one uninterrupted unhealthy period; replacements never reset it. */
  continuousUnhealthyStartedAt: number | null;
  /** Any native completion, including stale/invalid results. */
  lastNativeCompletionAt: number | null;
  /** Last fresh, owner-current, authoritative geometry result. */
  lastAcceptedGeometryAt: number | null;
  /** Last accepted result that published or cleared render authority. */
  lastRenderAuthoritativeGeometryAt: number | null;
}

export function createGeometryHealthClocks(): GeometryHealthClocks {
  return {
    currentAttemptGeneration: null,
    currentAttemptStartedAt: null,
    continuousUnhealthyStartedAt: null,
    lastNativeCompletionAt: null,
    lastAcceptedGeometryAt: null,
    lastRenderAuthoritativeGeometryAt: null,
  };
}

export function startGeometryAttempt(
  previous: GeometryHealthClocks,
  attemptGeneration: number,
  startedAt: number,
): GeometryHealthClocks {
  return {
    ...previous,
    currentAttemptGeneration: attemptGeneration,
    currentAttemptStartedAt: startedAt,
  };
}

export function restartGeometryAttempt(
  previous: GeometryHealthClocks,
  attemptGeneration: number,
  restartedAt: number,
): GeometryHealthClocks {
  if (previous.currentAttemptGeneration !== attemptGeneration) return previous;
  return {
    ...previous,
    currentAttemptGeneration: null,
    currentAttemptStartedAt: null,
    continuousUnhealthyStartedAt:
      previous.continuousUnhealthyStartedAt ??
      previous.currentAttemptStartedAt ??
      restartedAt,
  };
}

export function completeGeometryAttempt(
  previous: GeometryHealthClocks,
  input: {
    attemptGeneration: number;
    completedAt: number;
    accepted: boolean;
    renderAuthoritative: boolean;
  },
): GeometryHealthClocks {
  const ownsCurrent =
    previous.currentAttemptGeneration === input.attemptGeneration;
  const accepted = ownsCurrent && input.accepted;
  return {
    ...previous,
    currentAttemptGeneration: ownsCurrent
      ? null
      : previous.currentAttemptGeneration,
    currentAttemptStartedAt: ownsCurrent
      ? null
      : previous.currentAttemptStartedAt,
    lastNativeCompletionAt: Math.max(
      previous.lastNativeCompletionAt ?? Number.NEGATIVE_INFINITY,
      input.completedAt,
    ),
    lastAcceptedGeometryAt: accepted
      ? input.completedAt
      : previous.lastAcceptedGeometryAt,
    lastRenderAuthoritativeGeometryAt:
      accepted && input.renderAuthoritative
        ? input.completedAt
        : previous.lastRenderAuthoritativeGeometryAt,
    continuousUnhealthyStartedAt: accepted
      ? null
      : previous.continuousUnhealthyStartedAt,
  };
}

export function markGeometryUnhealthyIfExpired(
  previous: GeometryHealthClocks,
  now: number,
  healthDeadlineMs = GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS,
): GeometryHealthClocks {
  const acceptedAt = previous.lastAcceptedGeometryAt;
  if (acceptedAt != null && now - acceptedAt <= healthDeadlineMs) return previous;
  if (previous.continuousUnhealthyStartedAt != null) return previous;
  return {
    ...previous,
    continuousUnhealthyStartedAt:
      acceptedAt != null
        ? acceptedAt + healthDeadlineMs
        : previous.currentAttemptStartedAt ?? now,
  };
}

/**
 * Render health is certified only by the wall-clock freshness of the last
 * accepted authoritative geometry result. Starting or watchdog-restarting a
 * replacement attempt never extends stale presentation.
 */
export function geometrySchedulerHealthy(input: {
  now: number;
  foreground: boolean;
  activeGame: boolean;
  lastAcceptedGeometryAt: number | null;
  /** Diagnostic-only legacy fields; intentionally ignored for render health. */
  inFlightSince?: number | null;
  lastProbeStartedAt?: number | null;
  lastProbeCompletedAt?: number | null;
  healthDeadlineMs?: number;
}): boolean {
  if (!input.foreground || !input.activeGame) return false;
  const deadline = input.healthDeadlineMs ?? GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS;
  return input.lastAcceptedGeometryAt != null &&
    input.now - input.lastAcceptedGeometryAt <= deadline;
}

/** A per-slot identity resolved by the OCR track, keyed to a geometry fingerprint. */
export interface IdentityRecord<R> {
  /** Geometry fingerprint this identity was resolved against. */
  fingerprint: string;
  /** Resolved identity, or null while OCR is still pending/unmatched. */
  resolution: R | null;
  /** Monotonic clock when this record was written (retry deadline base). */
  resolvedAt: number;
  /**
   * Champion generation the statistic was computed for. A champion change bumps
   * it so `reconcileSlotIdentity` recomputes rather than treating a stale
   * champion's value as immutable. Optional for backward compatibility.
   */
  championGeneration?: number;
  /**
   * Canonical numeric augment ID of the verified identity (empty while pending).
   * Lets the immutability guard detect a conflicting re-read for the same card.
   */
  augmentId?: string;
  /** Normalized/readable OCR title retained only to recompute derived stats. */
  ocrTitle?: string | null;
  foregroundEpoch?: number;
  gameEpoch?: number;
  offerGeneration?: number;
  slotGeneration?: number;
  ocrRunId?: number;
  championRequestId?: number;
  championPatch?: string | null;
  conflictCount?: number;
  unresolvedState?: "scanning" | "unmatched" | "ocr-error";
  failureCount?: number;
  retryAt?: number;
}

/**
 * Resolve a slot's current identity: the stored record ONLY while the slot
 * generation it was read under is still current. A confirmed reroll (or a new
 * offer, champion change, or NO_OFFER teardown) advances the generation and
 * clears the store, so the chip falls to SCANNING; an unwritten slot returns
 * null for the same reason. This is the stale-result guard for identity: a late
 * OCR result keyed to a superseded generation can never paint over the new card.
 *
 * It used to compare the LIVE fingerprint against `record.fingerprint` instead.
 * That was a second, competing authority reading a different baseline from the
 * confirmed-reroll path, and the 2026-07-27 trace shows exactly what it cost.
 * Slot 1 of offerGeneration 29 oscillated between two fingerprints 17 bits apart
 * that both OCR'd to the same augment 1051 / 52.0% / S; `record.fingerprint` is
 * one scalar chasing a bistable signal, so it was wrong roughly half the time —
 * a successful publication would itself re-arm the mismatch by storing whichever
 * pole it happened to read. The result was SCANNING on 24 of 72 frames (38% of
 * the offer's wall time) with the identity store intact and `slotGeneration`
 * pinned at 28 the entire time.
 *
 * Fingerprint evidence is not disabled and no threshold moved: it still feeds
 * `advanceRerollConfirmation`, which is the one reader with hysteresis. It is
 * simply no longer consulted raw by the render path.
 */
export function identityForSlot<R>(
  record: IdentityRecord<R> | null | undefined,
  currentSlotGeneration: number,
): R | null {
  if (record == null) return null;
  if ((record.slotGeneration ?? 0) !== currentSlotGeneration) return null;
  return record.resolution;
}

/**
 * Build the visible frame from a geometry observation. Presence, occlusion, and
 * per-slot geometry (rect + fingerprint) come from the observation; chip CONTENT
 * (identity) is layered via `resolveIdentity`, which returns null for a slot
 * whose identity is pending or fingerprint-mismatched (SCANNING).
 *
 * surfaceValidated is present && !occluded — a modal-occluded offer publishes an
 * EMPTY frame (zero chips) even though its cards physically exist.
 */
export function buildGeometryVisibleFrame<R>(params: {
  revision: number;
  captureSeq: number;
  observation: GeometryObservation;
  generation: number;
  resolveIdentity: (regionIndex: number, fingerprint: string) => R | null;
  resolveUnresolvedState?: (
    regionIndex: number,
    fingerprint: string,
  ) => "scanning" | "unmatched" | "ocr-error";
}): VisibleOfferFrame<R> {
  const { revision, captureSeq, observation, generation, resolveIdentity } = params;
  const renderable = observation.present && !observation.occluded;
  if (!renderable) {
    return emptyVisibleFrame(revision, captureSeq, generation, observation.capturedAt);
  }
  const slots: VisibleSlot<R>[] = observation.cards
    .filter((card) => card.present)
    .map((card) => ({
      regionIndex: card.regionIndex,
      cardRect: card.cardRect,
      fingerprint: card.fingerprint,
      resolution: resolveIdentity(card.regionIndex, card.fingerprint),
      unresolvedState: params.resolveUnresolvedState?.(card.regionIndex, card.fingerprint) ?? "scanning",
    }));
  return {
    revision,
    captureSeq,
    capturedAt: observation.capturedAt,
    surfaceValidated: true,
    generation,
    slots,
  };
}
