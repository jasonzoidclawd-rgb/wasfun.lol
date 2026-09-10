import { describe, expect, it } from "vitest";
import {
  applyScanToOffer,
  emptyOfferState,
  offerActive,
  SCREEN_ABSENCE_CLEAR_PASSES,
  type OfferState,
} from "./offerLifecycle";

/** Resolver stub that records which titles were (re)resolved. */
function makeResolver() {
  const calls: string[] = [];
  return {
    calls,
    resolve: (title: string) => {
      calls.push(title);
      return `resolved:${title}`;
    },
  };
}

const normalize = (title: string) => title.trim();

// Titles containing 噪 model OCR noise: readable text that resolves to no
// known augment identity. Everything else validates.
const validate = (resolution: string) => !resolution.includes("噪");

function scan(
  state: OfferState<string>,
  titles: Array<string | null>,
  resolve: (title: string, regionIndex: number) => string = (title) => `resolved:${title}`,
) {
  return applyScanToOffer(state, titles, normalize, resolve, validate);
}

describe("latched offer lifecycle", () => {
  it("latches a three-card offer and reports it active", () => {
    const applied = scan(emptyOfferState(), ["殺戮時間", "靈魂淨化", "疾速追擊"]);
    expect(applied.cleared).toBe(false);
    expect(applied.changedRegions).toEqual([0, 1, 2]);
    expect(offerActive(applied.state)).toBe(true);
    expect(applied.state.slots.map((slot) => slot.title)).toEqual([
      "殺戮時間",
      "靈魂淨化",
      "疾速追擊",
    ]);
  });

  it("keeps the latched offer across identical re-scans without re-resolving", () => {
    const resolver = makeResolver();
    const first = scan(emptyOfferState(), ["卡一", "卡二", "卡三"], resolver.resolve);
    const second = scan(first.state, ["卡一", "卡二", "卡三"], resolver.resolve);

    expect(second.changedRegions).toEqual([]);
    expect(second.state.generation).toBe(first.state.generation);
    // The resolver ran exactly once per slot — stable slots keep their result.
    expect(resolver.calls).toEqual(["卡一", "卡二", "卡三"]);
    expect(second.state.slots[0]).toBe(first.state.slots[0]);
  });

  it("survives a champion level change by construction: level is not an input", () => {
    // The lifecycle has NO level parameter — nothing about player level can
    // clear a latched offer. This pin documents the level-3→4 badge fix.
    const latched = scan(emptyOfferState(), ["卡一", "卡二", "卡三"]);
    const rescan = scan(latched.state, ["卡一", "卡二", "卡三"]);
    expect(offerActive(rescan.state)).toBe(true);
    expect(rescan.cleared).toBe(false);
  });

  it("invalidates ONLY the rerolled slot immediately while others stay resolved", () => {
    const resolver = makeResolver();
    const first = scan(emptyOfferState(), ["卡一", "卡二", "卡三"], resolver.resolve);

    // Reroll in flight: slot 1 vanishes while slots 0/2 remain visible.
    const rerolling = scan(first.state, ["卡一", null, "卡三"], resolver.resolve);
    expect(rerolling.cleared).toBe(false);
    expect(rerolling.changedRegions).toEqual([1]);
    expect(rerolling.state.slots[1].fingerprint).toBeNull();
    expect(rerolling.state.slots[1].resolution).toBeNull();
    expect(rerolling.state.slots[0].resolution).toBe("resolved:卡一");
    expect(rerolling.state.slots[2].resolution).toBe("resolved:卡三");

    // The new card appears: only that slot is re-resolved.
    const rerolled = scan(rerolling.state, ["卡一", "新卡", "卡三"], resolver.resolve);
    expect(rerolled.changedRegions).toEqual([1]);
    expect(rerolled.state.slots[1].resolution).toBe("resolved:新卡");
    expect(resolver.calls).toEqual(["卡一", "卡二", "卡三", "新卡"]);
  });

  it("bumps the generation on any fingerprint change so publishes stay atomic", () => {
    const first = scan(emptyOfferState(), ["卡一", "卡二", "卡三"]);
    const rerolling = scan(first.state, ["卡一", null, "卡三"]);
    const rerolled = scan(rerolling.state, ["卡一", "新卡", "卡三"]);

    expect(first.state.generation).toBeGreaterThan(0);
    expect(rerolling.state.generation).toBe(first.state.generation + 1);
    expect(rerolled.state.generation).toBe(rerolling.state.generation + 1);
    // Every returned state is a complete snapshot — no mixed generations.
    expect(rerolled.state.slots).toHaveLength(3);
  });

  it("tolerates one fully-empty scan and clears on the second", () => {
    expect(SCREEN_ABSENCE_CLEAR_PASSES).toBe(2);
    const latched = scan(emptyOfferState(), ["卡一", "卡二", "卡三"]);

    const firstEmpty = scan(latched.state, [null, null, null]);
    expect(firstEmpty.cleared).toBe(false);
    expect(offerActive(firstEmpty.state)).toBe(true);

    const secondEmpty = scan(firstEmpty.state, [null, null, null]);
    expect(secondEmpty.cleared).toBe(true);
    expect(offerActive(secondEmpty.state)).toBe(false);
    expect(secondEmpty.state.slots.every((slot) => slot.resolution === null)).toBe(true);
  });

  it("never clears while unlatched: empty scans before any offer are inert", () => {
    const first = scan(emptyOfferState(), [null, null, null]);
    expect(first.cleared).toBe(false);
    const second = scan(first.state, [null, null, null]);
    expect(second.cleared).toBe(false);
    expect(offerActive(second.state)).toBe(false);
  });

  it("replaces an old offer atomically when new titles appear (stale OCR cannot restore it)", () => {
    const latched = scan(emptyOfferState(), ["卡一", "卡二", "卡三"]);
    const cleared = scan(
      scan(latched.state, [null, null, null]).state,
      [null, null, null],
    );
    expect(cleared.cleared).toBe(true);

    // The next offer starts from the CLEARED state; the old titles are gone
    // and the generation strictly advanced, so a stale publish is impossible.
    const next = scan(cleared.state, ["新一", "新二", "新三"]);
    expect(next.state.generation).toBeGreaterThan(latched.state.generation);
    expect(next.state.slots.map((slot) => slot.title)).toEqual(["新一", "新二", "新三"]);
  });

  it("never latches from OCR noise: unvalidated text before an offer is inert", () => {
    // Random gameplay text (HUD, minimap, announcements) reads as titles but
    // resolves to no known augment — it must never create an offer.
    const noise = scan(emptyOfferState(), ["噪音一", "噪音二", null]);
    expect(noise.cleared).toBe(false);
    expect(offerActive(noise.state)).toBe(false);
    expect(noise.state.latched).toBe(false);
    expect(noise.state.surfaceVisible).toBe(false);
  });

  it("hides the surface on the FIRST scan without validated evidence", () => {
    const latched = scan(emptyOfferState(), ["卡一", "卡二", "卡三"]);
    expect(latched.state.surfaceVisible).toBe(true);

    // Offer closed / occluded: chips must disappear immediately even though
    // the internal latch is retained for one more pass.
    const firstAbsent = scan(latched.state, [null, null, null]);
    expect(firstAbsent.cleared).toBe(false);
    expect(firstAbsent.state.surfaceVisible).toBe(false);
    expect(offerActive(firstAbsent.state)).toBe(true);
  });

  it("treats noise-only scans as surface absence: stale chips cannot survive gameplay", () => {
    // Regression: SCANNING/UNMATCHED chips stayed ~33s over normal gameplay
    // because noise text kept the old latch alive. Noise is absence evidence.
    const latched = scan(emptyOfferState(), ["卡一", "卡二", "卡三"]);
    const noiseOne = scan(latched.state, ["噪血條", "噪計分", "噪公告"]);
    expect(noiseOne.state.surfaceVisible).toBe(false);
    expect(noiseOne.cleared).toBe(false);
    // The retained slots are untouched — noise is never written into them.
    expect(noiseOne.state.slots[0].title).toBe("卡一");

    const noiseTwo = scan(noiseOne.state, ["噪血條", "噪計分", "噪公告"]);
    expect(noiseTwo.cleared).toBe(true);
    expect(offerActive(noiseTwo.state)).toBe(false);
  });

  it("restores the same offer when its fingerprints return after brief occlusion", () => {
    const resolver = makeResolver();
    const latched = scan(emptyOfferState(), ["卡一", "卡二", "卡三"], resolver.resolve);

    // Scoreboard covers the cards for one scan: hidden, retained.
    const occluded = scan(latched.state, [null, null, null], resolver.resolve);
    expect(occluded.state.surfaceVisible).toBe(false);

    // The same surface returns: restored without re-resolving anything.
    const restored = scan(occluded.state, ["卡一", "卡二", "卡三"], resolver.resolve);
    expect(restored.state.surfaceVisible).toBe(true);
    expect(restored.changedRegions).toEqual([]);
    expect(restored.state.slots[0]).toBe(latched.state.slots[0]);
    expect(resolver.calls).toEqual(["卡一", "卡二", "卡三"]);
  });

  it("keeps SCANNING evidence honest: a reroll slot counts as visible surface", () => {
    const latched = scan(emptyOfferState(), ["卡一", "卡二", "卡三"]);
    const rerolling = scan(latched.state, ["卡一", null, "卡三"]);
    // Two validated cards remain on screen — the surface is visible, so the
    // rerolled slot may render SCANNING.
    expect(rerolling.state.surfaceVisible).toBe(true);
    expect(rerolling.state.slots[1].fingerprint).toBeNull();
  });

  it("reports a queued offer replacing the current one (chained death rounds)", () => {
    const r2 = scan(emptyOfferState(), ["R2一", "R2二", "R2三"]);
    // Pick confirmed in-game: the R3 screen swaps in on the very next scan.
    const r3 = scan(r2.state, ["R3一", "R3二", "R3三"]);
    expect(r3.replacedOffer).toBe(true);
    expect(offerActive(r3.state)).toBe(true);
    expect(r3.state.generation).toBe(r2.state.generation + 1);
    expect(r3.state.slots.map((slot) => slot.title)).toEqual(["R3一", "R3二", "R3三"]);
  });

  it("never reports a single-slot reroll as an offer replacement", () => {
    const latched = scan(emptyOfferState(), ["卡一", "卡二", "卡三"]);
    const rerolled = scan(latched.state, ["卡一", "新卡", "卡三"]);
    expect(rerolled.replacedOffer).toBe(false);
    // A fresh latch after a clear is a new offer, not a replacement either.
    const cleared = scan(
      scan(latched.state, [null, null, null]).state,
      [null, null, null],
    );
    const fresh = scan(cleared.state, ["新一", "新二", "新三"]);
    expect(fresh.replacedOffer).toBe(false);
  });

  it("runs a full four-round game: every round independently latches and clears", () => {
    let state = emptyOfferState<string>();
    const offers = [
      ["R1一", "R1二", "R1三"],
      ["R2一", "R2二", "R2三"],
      ["R3一", "R3二", "R3三"],
      ["R4一", "R4二", "R4三"],
    ];
    for (const titles of offers) {
      const latched = scan(state, titles);
      expect(offerActive(latched.state)).toBe(true);
      expect(latched.state.slots.map((slot) => slot.title)).toEqual(titles);

      // Selection happens; the surface disappears for two passes.
      const gap = scan(latched.state, [null, null, null]);
      const done = scan(gap.state, [null, null, null]);
      expect(done.cleared).toBe(true);
      state = done.state;
    }
  });
});
