import { describe, expect, it } from "vitest";
import {
  applyScanToOffer,
  emptyOfferState,
  offerActive,
  type OfferState,
} from "./offerLifecycle";
import {
  DEFAULT_PROBE_CONFIG,
  nextProbeAction,
  type ProbeSchedulerState,
} from "./surfaceProbeScheduler";

// The exact R1 offer from the 18:53:40 failed retest (champion level 3):
// three validated cards visible while the overlay showed nothing.
const R1_TITLES = ["魔法導彈", "天界之身", "頂尖發明家"] as const;

const normalize = (title: string) => title.trim();
const validate = (resolution: string) => resolution.startsWith("resolved:");

function makeResolver() {
  const calls: Array<{ title: string; regionIndex: number }> = [];
  const resolve = (title: string, regionIndex: number) => {
    calls.push({ title, regionIndex });
    return `resolved:${title}`;
  };
  return { calls, resolve };
}

// The scheduler gate is a pure function of THIS tick: foreground + active game,
// nothing telemetry-derived. Only the foreground leg varies across these cases.
function probe(foreground: boolean) {
  const state: ProbeSchedulerState = {
    foreground,
    activeGame: true,
    inFlight: false,
    inFlightSince: null,
    lastProbeStartedAt: null,
    nativeOutstanding: 0,
  };
  return nextProbeAction(state, DEFAULT_PROBE_CONFIG, 1000);
}

describe("R1 replay — real three-card screen activates scanning", () => {
  it("attempts a per-card resolution for every one of the three R1 slots", () => {
    const { calls, resolve } = makeResolver();
    const scan = applyScanToOffer(
      emptyOfferState<string>(),
      [...R1_TITLES],
      normalize,
      resolve,
      validate,
    );

    expect(calls).toEqual([
      { title: "魔法導彈", regionIndex: 0 },
      { title: "天界之身", regionIndex: 1 },
      { title: "頂尖發明家", regionIndex: 2 },
    ]);
    expect(scan.state.latched).toBe(true);
    expect(scan.state.surfaceVisible).toBe(true);
    expect(offerActive(scan.state)).toBe(true);
    expect(scan.state.slots.map((slot) => slot.resolution)).toEqual(
      R1_TITLES.map((title) => `resolved:${title}`),
    );
  });

  it("keeps probing on the 250 ms scheduler once the R1 offer latches", () => {
    const { resolve } = makeResolver();
    const scan = applyScanToOffer(
      emptyOfferState<string>(),
      [...R1_TITLES],
      normalize,
      resolve,
      validate,
    );
    expect(offerActive(scan.state)).toBe(true);
    // Scanning is telemetry-independent: the latch never changes the gate, and
    // there is no separate "fast loop" to escalate to — one 250 ms scheduler.
    expect(probe(true)).toEqual({ kind: "start" });
  });

  it("cannot be suppressed by stale foreground state from an earlier tick", () => {
    // Tick 1: Terminal foreground — no scan runs, and crucially nothing about
    // that tick is stored anywhere the next decision reads from.
    expect(probe(false)).toEqual({ kind: "skip", reason: "not-foreground" });

    // Tick 2: GameClient foreground with the R1 screen up. The decision is a
    // pure function of THIS tick's inputs, so the earlier skip cannot leak
    // forward — the probe runs and the scan latches all three cards.
    expect(probe(true)).toEqual({ kind: "start" });

    const { calls, resolve } = makeResolver();
    const scan = applyScanToOffer(emptyOfferState<string>(), [...R1_TITLES], normalize, resolve, validate);
    expect(calls).toHaveLength(3);
    expect(offerActive(scan.state)).toBe(true);
  });

  it("restores scanning after game → Terminal → game without clearing the latch prematurely", () => {
    const { resolve } = makeResolver();
    let state: OfferState<string> = emptyOfferState<string>();
    state = applyScanToOffer(state, [...R1_TITLES], normalize, resolve, validate).state;
    expect(offerActive(state)).toBe(true);

    // Focus flips to Terminal: the scheduler skips, but the offer is preserved
    // as background state only (no scans applied, no pixels rendered).
    expect(probe(false)).toEqual({ kind: "skip", reason: "not-foreground" });
    expect(offerActive(state)).toBe(true);

    // Focus returns: probing resumes and the SAME offer is still latched — the
    // next scan re-confirms it without re-resolving anything.
    expect(probe(true)).toEqual({ kind: "start" });
    const { calls: rescanCalls, resolve: rescanResolve } = makeResolver();
    const rescan = applyScanToOffer(state, [...R1_TITLES], normalize, rescanResolve, validate);
    expect(rescanCalls).toHaveLength(0);
    expect(offerActive(rescan.state)).toBe(true);
    expect(rescan.state.generation).toBe(state.generation);
  });
});
