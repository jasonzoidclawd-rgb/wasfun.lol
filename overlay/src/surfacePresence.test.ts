import { describe, expect, it } from "vitest";
import {
  evaluateSurfacePresence,
  isPlausibleTitle,
  plausibleTitleCount,
} from "./surfacePresence";
import { normalizeAugmentNameForLookup } from "./scoring/offer-lookup";

const normalize = normalizeAugmentNameForLookup;

describe("isPlausibleTitle — basic quality, never catalog membership", () => {
  it("accepts compact card-name strings (real augment names)", () => {
    for (const name of ["旋風鉤", "不祥契約", "靈光一閃", "疾速追擊", "斗內", "殺戮時間", "食魂者"]) {
      expect(isPlausibleTitle(normalize(name)), name).toBe(true);
    }
    // A name that is NOT in any catalog is still a plausible title.
    expect(isPlausibleTitle(normalize("完全虛構的名稱"))).toBe(true);
  });

  it("rejects empty, single-char, overlong, and bare-number noise", () => {
    expect(isPlausibleTitle("")).toBe(false);
    expect(isPlausibleTitle(normalize("х"))).toBe(false); // one char
    expect(isPlausibleTitle("a".repeat(17))).toBe(false); // overlong garbage
    expect(isPlausibleTitle(normalize("1234"))).toBe(false); // combat number
    expect(isPlausibleTitle(normalize("  "))).toBe(false);
  });
});

describe("plausibleTitleCount", () => {
  it("counts only regions with a plausible fresh title", () => {
    expect(plausibleTitleCount(["旋風鉤", "不祥契約", "靈光一閃"], normalize)).toBe(3);
    expect(plausibleTitleCount(["旋風鉤", null, null], normalize)).toBe(1);
    expect(plausibleTitleCount(["旋風鉤", "9", "1234"], normalize)).toBe(1);
    expect(plausibleTitleCount([null, null, null], normalize)).toBe(0);
  });
});

describe("evaluateSurfacePresence — identity-independent", () => {
  it("asserts a NEW surface from >=2 plausible titles and three crops", () => {
    const verdict = evaluateSurfacePresence({
      cropsCaptured: 3,
      plausibleTitles: 2,
      previouslyPresent: false,
    });
    expect(verdict.present).toBe(true);
    expect(verdict.confidence).toBeGreaterThan(0);
  });

  it("does NOT require any catalog identity — 0/3 known still present with plausible text", () => {
    // The point: presence is decided from title count alone. Even if none of the
    // three plausible titles resolve to a Riot/ARAMGG augment, the surface is present.
    const verdict = evaluateSurfacePresence({
      cropsCaptured: 3,
      plausibleTitles: 3, // three plausible titles, zero catalog identities assumed
      previouslyPresent: false,
    });
    expect(verdict.present).toBe(true);
  });

  it("rejects a single stray plausible title over combat (new surface needs >=2)", () => {
    const verdict = evaluateSurfacePresence({
      cropsCaptured: 3,
      plausibleTitles: 1,
      previouslyPresent: false,
    });
    expect(verdict.present).toBe(false);
    expect(verdict.rejectionReasons).toContain("insufficient-identity");
  });

  it("keeps an already-present surface through a one-card reroll on >=1 plausible title", () => {
    const verdict = evaluateSurfacePresence({
      cropsCaptured: 3,
      plausibleTitles: 1,
      previouslyPresent: true,
    });
    expect(verdict.present).toBe(true);
  });

  it("rejects when the capture did not produce all three crops", () => {
    const verdict = evaluateSurfacePresence({
      cropsCaptured: 2,
      plausibleTitles: 3,
      previouslyPresent: false,
    });
    expect(verdict.present).toBe(false);
    expect(verdict.rejectionReasons).toContain("insufficient-crops");
  });

  it("is absent over combat: zero plausible titles never present", () => {
    expect(
      evaluateSurfacePresence({ cropsCaptured: 3, plausibleTitles: 0, previouslyPresent: false })
        .present,
    ).toBe(false);
    // Even when previously present, zero titles clears immediately.
    expect(
      evaluateSurfacePresence({ cropsCaptured: 3, plausibleTitles: 0, previouslyPresent: true })
        .present,
    ).toBe(false);
  });
});
