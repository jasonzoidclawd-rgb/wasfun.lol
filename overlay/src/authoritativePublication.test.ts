/**
 * FIX 2 — the development diagnostic banner and the native
 * [offer-state]/[slot-publication] events must describe the SAME accepted
 * publication snapshot that rendering uses. The live retest (00:14:35) showed
 * resolved badges on screen while the banner claimed "No latched offer —
 * captured 0/3 · Riot IDs 0/3", because the banner mixed stale raw OCR probe
 * counts and the internal latch instead of the authoritative visible frame.
 *
 * The invariant: a rendered resolved badge can never coexist with a snapshot
 * claiming the current authoritative state has no visible offer — unless that
 * frame is explicitly retained-uncertainty continuity.
 */
import { describe, expect, it } from "vitest";
import {
  publicationSnapshotConsistent,
  summarizeAuthoritativePublication,
  type AuthoritativeSlot,
} from "./authoritativePublication";

const slot = (over: Partial<AuthoritativeSlot> = {}): AuthoritativeSlot => ({
  hasRect: true,
  resolved: false,
  scanning: false,
  ...over,
});

describe("summarizeAuthoritativePublication", () => {
  it("derives every count from the rendered frame, not the latch or raw probe", () => {
    const s = summarizeAuthoritativePublication({
      renderable: true,
      slots: [slot({ resolved: true }), slot({ resolved: true }), slot({ scanning: true })],
      offerGeneration: 7,
      geometrySeq: 42,
      retainedContinuity: false,
    });
    expect(s.offerVisible).toBe(true);
    expect(s.visibleCards).toBe(3);
    expect(s.resolvedBadges).toBe(2);
    expect(s.scanningSlots).toBe(1);
    expect(s.offerGeneration).toBe(7);
    expect(s.geometrySeq).toBe(42);
  });

  it("reports no visible offer when nothing is renderable", () => {
    const s = summarizeAuthoritativePublication({
      renderable: false,
      slots: [],
      offerGeneration: 3,
      geometrySeq: 9,
      retainedContinuity: false,
    });
    expect(s.offerVisible).toBe(false);
    expect(s.visibleCards).toBe(0);
    expect(s.resolvedBadges).toBe(0);
  });
});

describe("publicationSnapshotConsistent — the FIX 2 invariant", () => {
  it("rejects a resolved badge coexisting with no visible offer", () => {
    const inconsistent = summarizeAuthoritativePublication({
      renderable: false, // banner would claim "no visible offer"
      slots: [slot({ resolved: true }), slot({ resolved: true }), slot({ resolved: true })],
      offerGeneration: 7,
      geometrySeq: 42,
      retainedContinuity: false,
    });
    // A renderable:false frame cannot carry resolved badges — this is exactly the
    // 00:14:35 contradiction, and the summary must not manufacture it.
    expect(inconsistent.resolvedBadges).toBe(0);
    expect(publicationSnapshotConsistent(inconsistent)).toBe(true);
  });

  it("accepts resolved badges with an authoritatively visible offer", () => {
    const s = summarizeAuthoritativePublication({
      renderable: true,
      slots: [slot({ resolved: true }), slot({ scanning: true }), slot({ scanning: true })],
      offerGeneration: 7,
      geometrySeq: 42,
      retainedContinuity: false,
    });
    expect(s.offerVisible).toBe(true);
    expect(s.resolvedBadges).toBe(1);
    expect(publicationSnapshotConsistent(s)).toBe(true);
  });

  it("flags a hand-built inconsistent snapshot (resolved badge + not visible)", () => {
    expect(
      publicationSnapshotConsistent({
        offerVisible: false,
        visibleCards: 3,
        resolvedBadges: 2,
        scanningSlots: 1,
        retainedContinuity: false,
        offerGeneration: 7,
        geometrySeq: 42,
      }),
    ).toBe(false);
  });

  it("allows retained-uncertainty continuity to render prior badges while flagged", () => {
    const s = summarizeAuthoritativePublication({
      renderable: true,
      slots: [slot({ resolved: true }), slot({ resolved: true }), slot({ resolved: true })],
      offerGeneration: 7,
      geometrySeq: 42,
      retainedContinuity: true,
    });
    expect(s.offerVisible).toBe(true);
    expect(s.retainedContinuity).toBe(true);
    expect(publicationSnapshotConsistent(s)).toBe(true);
  });
});
