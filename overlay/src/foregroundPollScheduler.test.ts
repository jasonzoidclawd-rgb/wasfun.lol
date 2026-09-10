import { describe, expect, it, vi } from "vitest";
import {
  FOREGROUND_LOGICAL_DEADLINE_MS,
  FOREGROUND_PAYLOAD_MAX_AGE_MS,
  FOREGROUND_POLL_INTERVAL_MS,
  foregroundLogicalExpired,
  foregroundResultIsPublishable,
  nextForegroundPollAction,
  pollForeground,
  type ForegroundPollHost,
  type ForegroundPollState,
} from "./foregroundPollScheduler";

const idle: ForegroundPollState = {
  nativeStartedAt: null,
  logicalTimeoutFiredForStartedAt: null,
};

const inFlight = (startedAt: number, firedFor: number | null = null): ForegroundPollState => ({
  nativeStartedAt: startedAt,
  logicalTimeoutFiredForStartedAt: firedFor,
});

/**
 * PHYSICAL SINGLE-FLIGHT.
 *
 * The live defect: `resolveWithTimeout` resolved the AWAITED value at 1500 ms,
 * so `refreshForeground`'s `finally` cleared the in-flight guard while the
 * native invoke was still unsettled. Every later tick then saw a free slot and
 * issued another overlapping `get_foreground_state` — a sync Tauri command that
 * runs INLINE on the IPC/main thread. Under a slow native call that admitted a
 * new main-thread occupant roughly every 1500 ms without bound, which is the
 * in-Rust dispatch wait that reached 63 s in the latency-attribution trace.
 *
 * Physical ownership must therefore be a function of the promise settling and
 * nothing else. No clock, no deadline, and no override may hand out a second
 * slot.
 */
describe("foreground poll physical single-flight", () => {
  it("starts a poll when no native call is unsettled", () => {
    expect(nextForegroundPollAction(idle, 10_000)).toEqual({ kind: "start" });
  });

  it("coalesces a tick that arrives while a native call is unsettled", () => {
    expect(nextForegroundPollAction(inFlight(10_000), 10_250)).toEqual({
      kind: "coalesce",
      physicalInFlightAgeMs: 250,
    });
  });

  it("never issues a second native call, however old the unsettled one is", () => {
    // The deleted `foregroundPollMayStart` returned true once the flight passed
    // FOREGROUND_POLL_STUCK_MS. That override IS the congestion source: it
    // could only ever add a second main-thread occupant, never cancel the
    // first. There is no age at which a start is allowed.
    for (const age of [1_500, 3_000, 30_000, 300_000]) {
      expect(nextForegroundPollAction(inFlight(10_000), 10_000 + age).kind).toBe("coalesce");
    }
  });

  it("coalesces statelessly — no queue and no accumulated tick count", () => {
    // Ten ticks during one flight produce ten identical decisions carrying only
    // an age. Nothing accumulates, so no backlog can be replayed at settle.
    const decisions = Array.from({ length: 10 }, (_, index) =>
      nextForegroundPollAction(inFlight(10_000), 10_100 + index * 250),
    );
    expect(decisions.every((decision) => decision.kind === "coalesce")).toBe(true);
    expect(Object.keys(decisions[0])).toEqual(["kind", "physicalInFlightAgeMs"]);
  });
});

/**
 * LOGICAL FRESHNESS.
 *
 * Physical ownership outliving the deadline must not mean the last positive
 * classification stays authoritative: capture has to fail closed. The deadline
 * expires the PUBLISHED truth (to `unknown`, everything hidden) while leaving
 * the native slot occupied.
 */
describe("foreground logical freshness deadline", () => {
  it("expires once the unsettled flight passes the deadline", () => {
    expect(foregroundLogicalExpired(inFlight(10_000), 10_000 + FOREGROUND_LOGICAL_DEADLINE_MS))
      .toBe(true);
  });

  it("does not expire before the deadline", () => {
    expect(foregroundLogicalExpired(inFlight(10_000), 10_000 + FOREGROUND_LOGICAL_DEADLINE_MS - 1))
      .toBe(false);
  });

  it("never expires when nothing is in flight", () => {
    expect(foregroundLogicalExpired(idle, 10_000_000)).toBe(false);
  });

  it("fires exactly once per flight", () => {
    // Re-publishing `unknown` every 250 ms for the life of a slow call would
    // re-run the blur branch (stopOcr -> clearSurface) on every tick.
    const now = 10_000 + FOREGROUND_LOGICAL_DEADLINE_MS;
    expect(foregroundLogicalExpired(inFlight(10_000, null), now)).toBe(true);
    expect(foregroundLogicalExpired(inFlight(10_000, 10_000), now)).toBe(false);
    expect(foregroundLogicalExpired(inFlight(10_000, 10_000), now + 60_000)).toBe(false);
  });

  it("re-arms for the next flight", () => {
    // The edge guard is keyed to the flight's start stamp, so a fresh flight is
    // never mistaken for the one that already timed out.
    const state = inFlight(50_000, 10_000);
    expect(foregroundLogicalExpired(state, 50_000 + FOREGROUND_LOGICAL_DEADLINE_MS)).toBe(true);
  });
});

/**
 * LATE-RESULT REJECTION.
 *
 * Today's `Promise.race` had one accidental virtue: the loser's value was
 * discarded, so a slow invoke could never publish. Awaiting the invoke directly
 * removes that, and an arbitrarily old positive would otherwise be published as
 * current truth — ten overlay surfaces plus `set_click_through` are gated on
 * `gameWindowForeground` alone. Two independent rejects replace it.
 */
describe("foreground late-result rejection", () => {
  const base = { startedAt: 10_000, epochAtStart: 4, epochNow: 4 };

  it("publishes a result that settled inside the freshness window", () => {
    expect(foregroundResultIsPublishable({ ...base, settledAt: 10_400 })).toBe(true);
  });

  it("rejects a payload older than the maximum age", () => {
    expect(
      foregroundResultIsPublishable({
        ...base,
        settledAt: 10_000 + FOREGROUND_PAYLOAD_MAX_AGE_MS,
      }),
    ).toBe(false);
  });

  it("rejects a result whose foreground epoch moved during the flight", () => {
    // The logical timeout publishing `unknown` flips gameWindowForeground and
    // bumps the epoch. A positive measured before that flip must never
    // overwrite the newer negative.
    expect(foregroundResultIsPublishable({ ...base, settledAt: 10_400, epochNow: 5 })).toBe(false);
  });

  it("still publishes a slow-but-completed call, so nothing is permanently disabled", () => {
    // A call that lands between the logical deadline and the max age is stale
    // enough to have hidden the overlay, but publishing it restores foreground
    // truth. Only a sustained >= max-age native path keeps the overlay hidden,
    // which is the required fail-closed direction.
    expect(FOREGROUND_PAYLOAD_MAX_AGE_MS).toBeGreaterThan(FOREGROUND_LOGICAL_DEADLINE_MS);
    expect(
      foregroundResultIsPublishable({
        ...base,
        settledAt: 10_000 + FOREGROUND_LOGICAL_DEADLINE_MS + 100,
      }),
    ).toBe(true);
  });

  it("keeps the poll cadence well inside the freshness deadline", () => {
    // The interval is the only demand signal (there is no follow-up invoke), so
    // a settle is followed by a fresh poll within one tick.
    expect(FOREGROUND_POLL_INTERVAL_MS).toBeLessThan(FOREGROUND_LOGICAL_DEADLINE_MS);
  });
});

/**
 * END-TO-END OWNERSHIP, against a native call that never settles.
 *
 * The pure predicates above cannot prove the loop USES them correctly. These
 * drive the real `pollForeground` with a controllable clock and a hanging
 * invoke — the exact condition that produced 63 s of in-Rust dispatch wait.
 */
describe("foreground poll ownership loop", () => {
  function harness(options: { invoke: () => Promise<string> }) {
    const state: ForegroundPollState = {
      nativeStartedAt: null,
      logicalTimeoutFiredForStartedAt: null,
    };
    let clock = 10_000;
    let epoch = 0;
    const published: string[] = [];
    const unknowns: number[] = [];
    const logs: { action: string; fields: Record<string, number | boolean> }[] = [];
    const invoke = vi.fn(options.invoke);
    const host: ForegroundPollHost<string> = {
      now: () => clock,
      read: () => ({ ...state }),
      setNativeStartedAt: (value) => {
        state.nativeStartedAt = value;
      },
      latchLogicalTimeout: (startedAt) => {
        state.logicalTimeoutFiredForStartedAt = startedAt;
      },
      epoch: () => epoch,
      invoke,
      publish: (value) => published.push(value),
      publishUnknown: () => {
        unknowns.push(clock);
        // Mirrors `publishForeground`: degrading to unknown flips
        // gameWindowForeground and therefore starts a new epoch.
        epoch += 1;
      },
      log: (action, fields) => logs.push({ action, fields }),
    };
    return {
      host,
      state,
      invoke,
      published,
      unknowns,
      logs,
      advance: (ms: number) => {
        clock += ms;
      },
      bumpEpoch: () => {
        epoch += 1;
      },
    };
  }

  it("issues exactly one native call however many ticks arrive during a flight", async () => {
    const h = harness({ invoke: () => new Promise<string>(() => {}) });
    void pollForeground(h.host);
    for (let tick = 0; tick < 20; tick += 1) {
      h.advance(FOREGROUND_POLL_INTERVAL_MS);
      await pollForeground(h.host);
    }
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("holds physical ownership past the logical deadline", async () => {
    const h = harness({ invoke: () => new Promise<string>(() => {}) });
    void pollForeground(h.host);
    const startedAt = h.state.nativeStartedAt;
    expect(startedAt).not.toBeNull();
    h.advance(FOREGROUND_LOGICAL_DEADLINE_MS * 10);
    await pollForeground(h.host);
    // The timeout expired logical freshness; it did NOT free the native slot.
    expect(h.unknowns).toHaveLength(1);
    expect(h.state.nativeStartedAt).toBe(startedAt);
  });

  it("degrades to unknown exactly once, no matter how long the call hangs", async () => {
    const h = harness({ invoke: () => new Promise<string>(() => {}) });
    void pollForeground(h.host);
    for (let tick = 0; tick < 40; tick += 1) {
      h.advance(FOREGROUND_POLL_INTERVAL_MS);
      await pollForeground(h.host);
    }
    expect(h.unknowns).toHaveLength(1);
    expect(h.logs.filter((entry) => entry.action === "logical-timeout")).toHaveLength(1);
  });

  it("releases ownership when the call settles, and only then", async () => {
    let settle: (value: string) => void = () => {};
    const h = harness({ invoke: () => new Promise<string>((resolve) => { settle = resolve; }) });
    const flight = pollForeground(h.host);
    expect(h.state.nativeStartedAt).not.toBeNull();
    settle("foreground");
    await flight;
    expect(h.state.nativeStartedAt).toBeNull();
    expect(h.published).toEqual(["foreground"]);
  });

  it("polls again on the next tick after a settle", async () => {
    const h = harness({ invoke: () => Promise.resolve("foreground") });
    await pollForeground(h.host);
    h.advance(FOREGROUND_POLL_INTERVAL_MS);
    await pollForeground(h.host);
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("never publishes a payload that outlived the maximum age", async () => {
    let settle: (value: string) => void = () => {};
    const h = harness({ invoke: () => new Promise<string>((resolve) => { settle = resolve; }) });
    const flight = pollForeground(h.host);
    h.advance(FOREGROUND_PAYLOAD_MAX_AGE_MS);
    settle("stale-positive");
    await flight;
    expect(h.published).toEqual([]);
    expect(h.logs.some((entry) => entry.action === "late-reject")).toBe(true);
    // A rejected result still frees the slot, so the next tick can poll.
    expect(h.state.nativeStartedAt).toBeNull();
  });

  it("never publishes a payload whose epoch moved mid-flight", async () => {
    let settle: (value: string) => void = () => {};
    const h = harness({ invoke: () => new Promise<string>((resolve) => { settle = resolve; }) });
    const flight = pollForeground(h.host);
    h.advance(100);
    h.bumpEpoch(); // e.g. a focus flip published elsewhere
    settle("superseded");
    await flight;
    expect(h.published).toEqual([]);
  });

  it("recovers foreground truth after the hang clears", async () => {
    // Guarantee: a slow-but-eventually-healthy native path must not leave the
    // overlay permanently disabled.
    let settle: (value: string) => void = () => {};
    const h = harness({ invoke: () => new Promise<string>((resolve) => { settle = resolve; }) });
    const flight = pollForeground(h.host);
    h.advance(FOREGROUND_PAYLOAD_MAX_AGE_MS);
    settle("too-old");
    await flight;
    expect(h.published).toEqual([]);

    h.host.invoke = () => Promise.resolve("fresh");
    h.advance(FOREGROUND_POLL_INTERVAL_MS);
    await pollForeground(h.host);
    expect(h.published).toEqual(["fresh"]);
  });

  it("releases ownership even when the native call rejects", async () => {
    const h = harness({ invoke: () => Promise.reject(new Error("ipc closed")) });
    await expect(pollForeground(h.host)).rejects.toThrow("ipc closed");
    expect(h.state.nativeStartedAt).toBeNull();
  });
});
