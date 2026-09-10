/**
 * The self-healing surface-probe scheduler decision function.
 *
 * A SINGLE probe runs on a fixed cadence while the GameClient is foreground and
 * an active game is running — and NOTHING else gates it. Round bookkeeping,
 * scanMode, champion level/death, phase, and prior cancellations may change the
 * round LABEL but can never stop the probe (that was the permanent-sleep bug:
 * scanning lived inside the 1.5 s poll's conditional branches and a stuck flag
 * or stale phase left it asleep indefinitely).
 *
 * `nextProbeAction` is a pure reducer so the liveness rules are unit-testable
 * without timers. The React effect owns a fixed interval and calls it each tick:
 *   - start   → acquire the in-flight guard and run one probe;
 *   - skip    → do nothing this tick (reason is diagnostic only);
 *   - abandon → the in-flight guard has been held past the bounded timeout, so
 *               the logical request is released. NO replacement is issued: a JS
 *               deadline cannot cancel a native capture, so the only thing a
 *               second invoke can do is deepen the queue that is making the
 *               first one slow. Recovery is the settle, and it needs no
 *               foreground toggle or component remount.
 */

/** Target cadence: 4 probes/second — sub-second detection without 20 ms OCR. */
export const PROBE_INTERVAL_MS = 250;
/**
 * A probe held longer than this releases its LOGICAL guard.
 *
 * Deliberately unchanged. The 2026-07-27 trace showed this deadline sitting
 * below the end-to-end round trip it actually times (roundTripMs > 2000 in 20 of
 * 22 samples in the R4 window, median 4001, max 9575), which turns a watchdog
 * into a load generator of fixed period: offered rate 1/D instead of 1/S, so
 * utilization S/D ≈ 1.9 > 1 and the queue never drains. Raising D would hide
 * that; making the timeout stop issuing work removes it. The deadline now only
 * releases ownership, so a slow-but-healthy probe costs nothing.
 */
export const PROBE_TIMEOUT_MS = 2000;
/**
 * Max native calls issued but not yet settled — ONE.
 *
 * A JS-side deadline cannot cancel an OS capture (`lib.rs:745-750` says so
 * outright: the permit lives in the blocking worker and is released only when
 * that worker truly returns). So an abandoned probe still runs to completion,
 * still holds one of the four Rust capture permits, and still ships its result.
 * Every "replacement" issued against it was pure added load on the exact
 * resource that was scarce.
 *
 * The previous value of 2 was not the cause of the collapse but it was the only
 * thing bounding it — it converted an unbounded blowup into a bounded permanent
 * stall (2 outstanding, 4 s round trips) instead of the ~70 outstanding and
 * 47–63 s round trips an uncapped run produced. One removes the pathology
 * rather than bounding it under ordinary operation. But a native call that
 * never settles at all — a genuine wedge — is no longer left to suppress the
 * scheduler forever: it is allowed exactly one bounded replacement
 * (`WEDGED_NATIVE_PROBE_MS` / `MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT` below),
 * so the true bound is one presumed-wedged zombie plus one active
 * replacement — a hard ceiling of two, not the unconditional zero this
 * comment used to claim.
 */
export const MAX_OUTSTANDING_NATIVE_PROBES = 1;
/**
 * A native call outstanding at least this long is presumed WEDGED rather than
 * merely slow. 4000 = 2x `PROBE_TIMEOUT_MS` (2000), mirroring the existing
 * house precedent that `FOREGROUND_PAYLOAD_MAX_AGE_MS` (3000) is 2x
 * `FOREGROUND_LOGICAL_DEADLINE_MS` (1500) in `foregroundPollScheduler.ts`. It
 * comfortably clears Rust's own `NATIVE_CAPTURE_TIMEOUT` (1500 ms, lib.rs:790)
 * and the observed healthy round trips (704 ms and 1593 ms; documented p99
 * 1731 ms), so it fires only on genuine wedges, not ordinary tail latency.
 */
export const WEDGED_NATIVE_PROBE_MS = 4_000;
/**
 * Effective backlog cap once the oldest outstanding native call is presumed
 * wedged: one written-off zombie plus one active replacement. `lib.rs:792-798`
 * documents that `MAX_CONCURRENT_CAPTURES` "MUST be > 1: at a cap of 1 a
 * single hung capture starves every death-round retry, so no frame is ever
 * produced and badges never render at levels 11/15" — Rust already admits
 * concurrent retries beneath a per-channel cap of 4. This raises the JS cap
 * from 1 to 2 for the same reason, staying well under that cap of 4.
 */
export const MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT = 2;

export interface ProbeSchedulerState {
  /** Actual GameClient foreground (fresh this tick). */
  foreground: boolean;
  /** Live Client reports an active game / capture allowed (fresh this tick). */
  activeGame: boolean;
  /** A probe is currently in flight. */
  inFlight: boolean;
  /** Monotonic clock when the in-flight probe started, or null. */
  inFlightSince: number | null;
  /** Monotonic clock when the last probe STARTED, or null (never). */
  lastProbeStartedAt: number | null;
  /**
   * Native calls issued but not yet settled, INCLUDING ones whose logical
   * ownership the watchdog already abandoned. Abandoning is not cancelling.
   */
  nativeOutstanding: number;
  /** Monotonic start of the OLDEST still-unsettled native call, or null when none. */
  oldestNativeStartedAt?: number | null;
}

export interface ProbeSchedulerConfig {
  intervalMs: number;
  timeoutMs: number;
  /** When set, a native call outstanding this long is presumed wedged. */
  wedgedNativeMs?: number;
}

export type ProbeAction =
  | { kind: "start" }
  | { kind: "skip"; reason: string }
  /**
   * Release logical ownership without issuing another native call. The caller
   * must NOT advance the capture sequence here: with no replacement in flight
   * the outstanding probe's own result is still the newest evidence, and
   * invalidating it is what drove goodput to zero while the machine ran at 100%
   * utilization.
   */
  | { kind: "abandon"; reason: string };

export const DEFAULT_PROBE_CONFIG: ProbeSchedulerConfig = {
  intervalMs: PROBE_INTERVAL_MS,
  timeoutMs: PROBE_TIMEOUT_MS,
};

/**
 * Oldest still-unsettled native call's start time, computed from a per-request
 * registry (`Map<captureSeq, startedAt>`) rather than a single scalar.
 *
 * Why per-request tracking is required, not optional: a scalar "set-if-null,
 * clear-once-outstanding-hits-zero" ref cannot represent two concurrent native
 * calls. Observed timeline: probe A starts at t0; the wedge discount
 * (`WEDGED_NATIVE_PROBE_MS`) later admits replacement B while A is still
 * outstanding. A settles FIRST, while B is still young — outstanding drops
 * 2 -> 1, never reaching 0, so a scalar that only clears "once every native
 * call has drained" is NEVER cleared and keeps reporting A's stale t0
 * forever. Every following tick then computes `now - t0 >= WEDGED_NATIVE_PROBE_MS`
 * as permanently true, so the wedge discount cap stays permanently active,
 * and the moment B's own watchdog next opens the in-flight guard a THIRD
 * probe C is admitted even though B itself is nowhere near the wedge
 * threshold — C bumps the capture sequence, so B's otherwise-valid return is
 * stale-rejected. Deleting only the settling request's OWN map entry (never
 * a count-gated bulk clear) makes that failure structurally impossible: the
 * map always reflects exactly what is still outstanding, so the minimum over
 * its values is always the true oldest start.
 *
 * Pure: does not mutate `starts`. Empty map -> `null` (never `0`, never
 * `Infinity` — both would be indistinguishable from a real, very-recent or
 * very-old start and would corrupt the wedge comparison in `nextProbeAction`).
 */
export function oldestNativeStart(starts: ReadonlyMap<number, number>): number | null {
  let oldest: number | null = null;
  for (const startedAt of starts.values()) {
    if (oldest === null || startedAt < oldest) oldest = startedAt;
  }
  return oldest;
}

export function nextProbeAction(
  state: ProbeSchedulerState,
  config: ProbeSchedulerConfig,
  now: number,
): ProbeAction {
  if (!state.foreground) return { kind: "skip", reason: "not-foreground" };
  if (!state.activeGame) return { kind: "skip", reason: "not-active-game" };
  const wedged =
    state.oldestNativeStartedAt != null &&
    config.wedgedNativeMs != null &&
    now - state.oldestNativeStartedAt >= config.wedgedNativeMs;
  const cap = wedged
    ? MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT
    : MAX_OUTSTANDING_NATIVE_PROBES;
  const backlogged = state.nativeOutstanding >= cap;
  if (state.inFlight) {
    if (state.inFlightSince != null && now - state.inFlightSince >= config.timeoutMs) {
      // Watchdog: the logical request has waited past the bounded timeout.
      // Release ownership ONLY. There is no "stuck" state a second invoke can
      // repair — abandoning is not cancelling, so the native call is still
      // running and still holding its capture permit, and a replacement merely
      // queues behind it. The settle is the recovery event.
      return { kind: "abandon", reason: "in-flight-timeout" };
    }
    return { kind: "skip", reason: "in-flight" };
  }
  if (backlogged) return { kind: "skip", reason: "native-backlog" };
  if (
    state.lastProbeStartedAt == null ||
    now - state.lastProbeStartedAt >= config.intervalMs
  ) {
    return { kind: "start" };
  }
  return { kind: "skip", reason: "not-due" };
}
