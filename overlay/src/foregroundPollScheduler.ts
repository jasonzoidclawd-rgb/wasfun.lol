/**
 * Foreground-poll scheduling: physically single-flight, logically
 * freshness-bounded.
 *
 * `get_foreground_state` is a NON-async Tauri command, so tauri classifies it
 * Blocking and runs it INLINE on the IPC/main thread. Concurrency there is not
 * parallelism — it is queueing in front of every other IPC message, geometry
 * probes included. The previous implementation raced the invoke against a
 * 1500 ms timeout and released its in-flight guard when the RACE resolved, not
 * when the invoke settled, so a slow native call earned a new overlapping
 * main-thread occupant roughly every 1500 ms without bound. That is the in-Rust
 * dispatch wait that reached 63 s while the actual capture work never exceeded
 * 1331 ms.
 *
 * Three concerns are kept separate here:
 *
 *  1. PHYSICAL ownership — occupied from the moment an invoke is issued until
 *     its promise settles. Only the settle releases it. No clock, deadline or
 *     override may hand out a second slot, because a JS-side timeout cannot
 *     cancel native work; it can only add to it.
 *  2. LOGICAL freshness — the published classification stops being trustworthy
 *     at `FOREGROUND_LOGICAL_DEADLINE_MS`. It degrades to `unknown`
 *     (everything hidden) while the native slot stays occupied. Hiding is
 *     always the safe direction.
 *  3. DEMAND — none is recorded. Ticks arriving during a flight coalesce into
 *     nothing, and the caller's existing periodic clock re-polls after the
 *     settle. A latest-request flag would have to be drained by a follow-up
 *     invoke issued from the settle handler, which under a slow native call
 *     runs the main thread at a 100% duty cycle — the very failure being fixed.
 */

/** Cadence of the caller's foreground clock. Not used for any deadline. */
export const FOREGROUND_POLL_INTERVAL_MS = 250;

/**
 * How long a published foreground classification may be trusted while its
 * replacement is still unsettled. Unchanged from the timeout it replaces.
 *
 * This deadline exists because of the 18:53 live retest: a native poll that
 * never settled left the LAST state latched forever (an in-flight guard with no
 * deadline at all), so development panels stayed painted over Terminal and the
 * game never regained foreground. A poll that cannot produce fresh truth must
 * degrade to "unknown" — hiding is always the safe direction. What changed is
 * only WHICH ownership the deadline expires: logical publication, never the
 * physical native slot.
 */
export const FOREGROUND_LOGICAL_DEADLINE_MS = 1500;

/**
 * Hard age bound on a settled payload. A native result describes the moment
 * the invoke was issued, so publishing one that is seconds old can assert
 * "the game is in front" long after focus left — and ten overlay surfaces plus
 * `set_click_through` gate on `gameWindowForeground` alone.
 *
 * It is deliberately LOOSER than the logical deadline. Rejecting everything
 * past 1500 ms would leave a consistently-slow-but-healthy native path
 * permanently unable to publish any truth, i.e. permanently disabled. Between
 * the deadline and this bound the overlay hides and then recovers; only a
 * sustained >= 3 s native path keeps it hidden, which is the required
 * fail-closed direction rather than a wedge.
 */
export const FOREGROUND_PAYLOAD_MAX_AGE_MS = 3000;

export interface ForegroundPollState {
  /** When the unsettled invoke was issued; `null` when the slot is free. */
  nativeStartedAt: number | null;
  /** `nativeStartedAt` of the flight whose logical timeout already fired. */
  logicalTimeoutFiredForStartedAt: number | null;
}

export type ForegroundPollAction =
  | { kind: "start" }
  | { kind: "coalesce"; physicalInFlightAgeMs: number };

/**
 * A tick may start a poll only when no native invoke is unsettled. There is no
 * stuck-override: an old flight yields `coalesce` forever, because the only
 * thing a second invoke can do is deepen the main-thread queue.
 */
export function nextForegroundPollAction(
  state: ForegroundPollState,
  nowMs: number,
): ForegroundPollAction {
  if (state.nativeStartedAt === null) return { kind: "start" };
  return { kind: "coalesce", physicalInFlightAgeMs: nowMs - state.nativeStartedAt };
}

/**
 * True when the unsettled flight has outlived logical freshness and has not
 * already expired it. The caller latches `logicalTimeoutFiredForStartedAt` to
 * the flight's start stamp so the degrade-to-unknown publication (and its blur
 * handling) happens once per flight, not on every 250 ms tick for the life of a
 * slow call.
 */
export function foregroundLogicalExpired(
  state: ForegroundPollState,
  nowMs: number,
  deadlineMs: number = FOREGROUND_LOGICAL_DEADLINE_MS,
): boolean {
  if (state.nativeStartedAt === null) return false;
  if (state.logicalTimeoutFiredForStartedAt === state.nativeStartedAt) return false;
  return nowMs - state.nativeStartedAt >= deadlineMs;
}

/**
 * Whether a settled payload may be published. Rejects on either axis:
 *
 *  - the foreground epoch moved during the flight, so something newer (the
 *    logical timeout degrading to `unknown`, a focus flip) already published
 *    and this result would overwrite it with older evidence;
 *  - the payload is older than `FOREGROUND_PAYLOAD_MAX_AGE_MS`.
 *
 * A rejected result changes nothing: physical ownership is released by the
 * settle regardless, so the next tick issues a fresh poll.
 */
export function foregroundResultIsPublishable(input: {
  startedAt: number;
  settledAt: number;
  epochAtStart: number;
  epochNow: number;
  maxAgeMs?: number;
}): boolean {
  if (input.epochNow !== input.epochAtStart) return false;
  return input.settledAt - input.startedAt < (input.maxAgeMs ?? FOREGROUND_PAYLOAD_MAX_AGE_MS);
}

/**
 * Everything one poll needs from its caller. The ownership loop lives here
 * rather than in the component so the invariants below are provable against a
 * native call that never settles — a source-text guard over a hook body can be
 * satisfied by code that no longer works.
 */
export interface ForegroundPollHost<T> {
  now(): number;
  read(): ForegroundPollState;
  setNativeStartedAt(value: number | null): void;
  latchLogicalTimeout(startedAt: number | null): void;
  epoch(): number;
  /** Must not reject: a foreground read that fails is an `unknown` result. */
  invoke(): Promise<T>;
  publish(value: T): void;
  publishUnknown(): void;
  log(action: string, fields: Record<string, number | boolean>): void;
}

/**
 * Run exactly one foreground poll.
 *
 * Physical ownership is taken before the first `await` and released in
 * `finally` — the only release site there is. A tick that finds ownership held
 * performs no native work at all and instead enforces logical freshness, so a
 * slow native call degrades the published classification to `unknown` without
 * ever adding a second occupant to the IPC/main thread.
 */
export async function pollForeground<T>(host: ForegroundPollHost<T>): Promise<T | null> {
  const now = host.now();
  const state = host.read();
  const action = nextForegroundPollAction(state, now);

  if (action.kind === "coalesce") {
    if (foregroundLogicalExpired(state, now)) {
      host.latchLogicalTimeout(state.nativeStartedAt);
      host.log("logical-timeout", {
        physicalInFlightAgeMs: action.physicalInFlightAgeMs,
        epoch: host.epoch(),
      });
      // Fail closed. Physical ownership is deliberately NOT released: the
      // native call is still running and JS cannot cancel it.
      host.publishUnknown();
    }
    return null;
  }

  const startedAt = now;
  host.setNativeStartedAt(startedAt);
  host.latchLogicalTimeout(null);
  const epochAtStart = host.epoch();
  try {
    const value = await host.invoke();
    const settledAt = host.now();
    const epochNow = host.epoch();
    const publishable = foregroundResultIsPublishable({
      startedAt,
      settledAt,
      epochAtStart,
      epochNow,
    });
    host.log(publishable ? "settle" : "late-reject", {
      nativeMs: settledAt - startedAt,
      epochMoved: epochNow !== epochAtStart,
      epoch: epochNow,
    });
    if (!publishable) return null;
    host.publish(value);
    return value;
  } finally {
    host.setNativeStartedAt(null);
  }
}
