import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROBE_CONFIG,
  nextProbeAction,
  type ProbeSchedulerState,
} from "./surfaceProbeScheduler";
import { evaluateSurfacePresence, isPlausibleTitle } from "./surfacePresence";
import {
  applyScanToOffer,
  emptyOfferState,
  offerActive,
  type OfferState,
} from "./offerLifecycle";
import { buildVisibleFrame, visibleFrameRenderable } from "./visibleOfferFrame";
import type { PhysicalRect } from "./calibration";

// The real death-triggered R2 offer from the 01:52:34 retest, described
// verbatim (no pixel capture was supplied for this state, so this is a
// state-machine replay; the R1 pixel replay covers the OCR-from-image path).
const DEATH_OFFER = ["旋風鉤", "不祥契約", "靈光一閃"] as const;

// Only real augment names resolve to a catalog identity — but presence (Stage 1)
// never depends on that. Unknown-but-plausible titles still latch a live offer.
const KNOWN = new Set<string>(DEATH_OFFER);
const normalize = (title: string) => title.trim();
const resolve = (title: string) => (KNOWN.has(title) ? `resolved:${title}` : `unmatched:${title}`);
// Stage 2 latch predicate: presence, not catalog identity.
const titlePresent = () => true;

function freshRects(): Array<PhysicalRect | null> {
  return [0, 1, 2].map((i) => ({ x: 100 + i * 200, y: 250, width: 180, height: 60 }));
}

/**
 * Simulate one probe exactly as App.tsx does: Stage 1 surface presence from
 * plausible-title count (identity-independent), Stage 2 latch keyed on title
 * presence, then build the visible frame from the presence verdict.
 */
function scan(
  titles: Array<string | null>,
  prev: OfferState<string> = emptyOfferState<string>(),
) {
  const plausible = titles.map((title) =>
    title != null && isPlausibleTitle(normalize(title)) ? title : null,
  );
  const plausibleCount = plausible.filter((title) => title !== null).length;
  const presence = evaluateSurfacePresence({
    cropsCaptured: 3,
    plausibleTitles: plausibleCount,
    previouslyPresent: prev.latched,
  });
  const applied = applyScanToOffer(prev, plausible, normalize, resolve, titlePresent);
  const frame = buildVisibleFrame({
    revision: prev.generation + 1,
    captureSeq: prev.generation + 1,
    capturedAt: 1000,
    offerState: applied.state,
    freshRects: freshRects(),
    surfaceValidated: presence.present,
  });
  return { applied, presence, frame };
}

describe("post-death R2 activation — the scheduler probes regardless of telemetry", () => {
  it("probes on every foreground in-game tick, whatever the round bookkeeping says", () => {
    // The 01:52 fix: the scheduler NEVER reads scanMode / round counts — an
    // overcounted round that once drove scanMode 'off' can no longer veto a
    // probe. foreground + active game is the whole gate.
    const inGame: ProbeSchedulerState = {
      foreground: true,
      activeGame: true,
      inFlight: false,
      inFlightSince: null,
      lastProbeStartedAt: null,
      nativeOutstanding: 0,
    };
    expect(nextProbeAction(inGame, DEFAULT_PROBE_CONFIG, 1000)).toEqual({ kind: "start" });
  });

  it("renders the death-triggered offer from title presence alone", () => {
    // The three-card surface appears → presence.present=true → crops → OCR →
    // slot resolution → chips renderable.
    const { applied, presence, frame } = scan([...DEATH_OFFER]);
    expect(presence.present).toBe(true);
    expect(offerActive(applied.state)).toBe(true);
    expect(frame.surfaceValidated).toBe(true);
    expect(frame.slots.filter((slot) => slot.cardRect !== null)).toHaveLength(3);
    expect(visibleFrameRenderable(frame, true)).toBe(true);
    expect(applied.state.slots.map((slot) => slot.resolution)).toEqual(
      DEATH_OFFER.map((title) => `resolved:${title}`),
    );
  });

  it("renders even when NONE of the three titles resolve to a catalog identity", () => {
    // Presence is decided from title quality, not catalog membership. A brand
    // new patch's unknown augments are still a live, renderable offer.
    const { presence, frame } = scan(["完全虛構甲名", "完全虛構乙名", "完全虛構丙名"]);
    expect(presence.present).toBe(true);
    expect(frame.slots.filter((slot) => slot.cardRect !== null)).toHaveLength(3);
    expect(visibleFrameRenderable(frame, true)).toBe(true);
  });

  it("re-detects a real offer that appears long after the last probe (defect B: level-15)", () => {
    // Defect B: the level-15 offer 不可通行 / 拍拍鼓勵 / 斗內 appeared 37 s after
    // the scheduler had gone quiet and was never scanned. There is no 'asleep'
    // state now — a foreground in-game tick starts a probe however old the last
    // one is, and three plausible titles then evaluate present and render.
    const longIdle: ProbeSchedulerState = {
      foreground: true,
      activeGame: true,
      inFlight: false,
      inFlightSince: null,
      lastProbeStartedAt: 1000,
      nativeOutstanding: 0,
    };
    expect(nextProbeAction(longIdle, DEFAULT_PROBE_CONFIG, 1000 + 60_000)).toEqual({ kind: "start" });
    const { presence, frame } = scan(["不可通行", "拍拍鼓勵", "斗內"]);
    expect(presence.present).toBe(true);
    expect(visibleFrameRenderable(frame, true)).toBe(true);
  });
});

describe("normal gameplay renders zero slots", () => {
  it("does not validate a surface from combat noise or a single stray title", () => {
    // No readable card titles (combat): nothing is present, nothing renders.
    const combat = scan([null, null, null]);
    expect(combat.presence.present).toBe(false);
    expect(combat.frame.slots).toEqual([]);
    expect(visibleFrameRenderable(combat.frame, true)).toBe(false);

    // One plausible title plus bare-number combat noise: a new surface needs
    // ≥2 plausible titles, so this is still not an offer.
    const stray = scan(["旋風鉤", "9", "1234"]);
    expect(stray.presence.present).toBe(false);
    expect(stray.frame.slots).toEqual([]);
  });

  it("clears a completed offer to an empty frame once the surface is gone", () => {
    // A validated offer, then the cards close (combat): the very next probe
    // publishes an empty frame — no chip lingers over combat/respawn.
    const offer = scan([...DEATH_OFFER]).applied.state;
    expect(offer.latched).toBe(true);

    const afterClose = scan([null, null, null], offer);
    expect(afterClose.presence.present).toBe(false);
    expect(afterClose.frame.slots).toEqual([]);
    expect(visibleFrameRenderable(afterClose.frame, true)).toBe(false);
  });
});
