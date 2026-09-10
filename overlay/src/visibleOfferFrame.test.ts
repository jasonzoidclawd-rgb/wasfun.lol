import { describe, expect, it } from "vitest";
import {
  applyScanToOffer,
  emptyOfferState,
  type OfferState,
} from "./offerLifecycle";
import {
  buildVisibleFrame,
  emptyVisibleFrame,
  frameResultIsCurrent,
  slotHasCurrentRect,
  validateOfferSurface,
  visibleFrameRenderable,
} from "./visibleOfferFrame";
import type { PhysicalRect } from "./calibration";

const normalize = (title: string) => title.trim();
const validate = (resolution: string) => resolution.startsWith("resolved:");
const resolve = (title: string) => `resolved:${title}`;

function rect(regionIndex: number): PhysicalRect {
  return { x: 100 + regionIndex * 200, y: 250, width: 180, height: 60 };
}

function offerFrom(titles: Array<string | null>): OfferState<string> {
  return applyScanToOffer(emptyOfferState<string>(), titles, normalize, resolve, validate).state;
}

describe("validateOfferSurface — multi-signal, not OCR-title-only", () => {
  it("validates a new surface only with all three crops AND ≥2 known identities", () => {
    expect(validateOfferSurface({ cropsCaptured: 3, validatedSlots: 3, latched: false })).toEqual({
      validated: true,
      reason: "validated-new-surface",
    });
    expect(validateOfferSurface({ cropsCaptured: 3, validatedSlots: 2, latched: false }).validated).toBe(true);
  });

  it("rejects arbitrary combat UI that matches only one region", () => {
    // A single stray name-match over gameplay must NOT be read as an offer.
    expect(validateOfferSurface({ cropsCaptured: 3, validatedSlots: 1, latched: false })).toEqual({
      validated: false,
      reason: "insufficient-identity",
    });
    expect(validateOfferSurface({ cropsCaptured: 3, validatedSlots: 0, latched: false }).validated).toBe(false);
  });

  it("keeps a latched offer visible through a single-slot reroll on ≥1", () => {
    expect(validateOfferSurface({ cropsCaptured: 3, validatedSlots: 1, latched: true })).toEqual({
      validated: true,
      reason: "validated-latched-reroll",
    });
    expect(validateOfferSurface({ cropsCaptured: 3, validatedSlots: 0, latched: true }).validated).toBe(false);
  });

  it("rejects when the capture did not produce all three name-band crops", () => {
    expect(validateOfferSurface({ cropsCaptured: 2, validatedSlots: 3, latched: false })).toEqual({
      validated: false,
      reason: "insufficient-crops",
    });
    expect(validateOfferSurface({ cropsCaptured: 0, validatedSlots: 0, latched: true }).reason).toBe("insufficient-crops");
  });
});

describe("buildVisibleFrame — fresh geometry or explicit empty", () => {
  it("mirrors the offer slots with fresh rects when the surface is validated", () => {
    const offer = offerFrom(["旋風鉤", "不祥契約", "靈光一閃"]);
    const frame = buildVisibleFrame({
      revision: 5,
      captureSeq: 9,
      capturedAt: 1000,
      offerState: offer,
      freshRects: [rect(0), rect(1), rect(2)],
      surfaceValidated: true,
    });
    expect(frame.surfaceValidated).toBe(true);
    expect(frame.slots.map((slot) => slot.cardRect)).toEqual([rect(0), rect(1), rect(2)]);
    expect(frame.slots.map((slot) => slot.fingerprint)).toEqual(["旋風鉤", "不祥契約", "靈光一閃"]);
    expect(frame.generation).toBe(offer.generation);
  });

  it("drops the rect for any slot the current capture did not produce a crop for", () => {
    const offer = offerFrom(["旋風鉤", "不祥契約", "靈光一閃"]);
    const frame = buildVisibleFrame({
      revision: 1,
      captureSeq: 1,
      capturedAt: 1000,
      offerState: offer,
      freshRects: [rect(0), null, rect(2)],
      surfaceValidated: true,
    });
    expect(frame.slots[1].cardRect).toBeNull();
    expect(frame.slots.filter(slotHasCurrentRect)).toHaveLength(2);
  });

  it("produces an EMPTY frame when the surface is not validated, ignoring the latch", () => {
    const offer = offerFrom(["旋風鉤", "不祥契約", "靈光一閃"]);
    expect(offer.latched).toBe(true);
    const frame = buildVisibleFrame({
      revision: 2,
      captureSeq: 4,
      capturedAt: 1000,
      offerState: offer,
      freshRects: [rect(0), rect(1), rect(2)],
      surfaceValidated: false,
    });
    expect(frame.surfaceValidated).toBe(false);
    expect(frame.slots).toEqual([]);
  });
});

describe("visibleFrameRenderable — the single render gate", () => {
  it("renders only a validated frame while the game is foreground", () => {
    const validated = buildVisibleFrame({
      revision: 1,
      captureSeq: 1,
      capturedAt: 1000,
      offerState: offerFrom(["旋風鉤", "不祥契約", "靈光一閃"]),
      freshRects: [rect(0), rect(1), rect(2)],
      surfaceValidated: true,
    });
    expect(visibleFrameRenderable(validated, true)).toBe(true);
    expect(visibleFrameRenderable(validated, false)).toBe(false);
  });

  it("never renders a null or empty frame", () => {
    expect(visibleFrameRenderable(null, true)).toBe(false);
    expect(visibleFrameRenderable(emptyVisibleFrame(3, 3, 0), true)).toBe(false);
  });
});

describe("stale-result rejection — old OCR cannot resurrect a hidden frame", () => {
  it("accepts only a result whose seq is still the latest", () => {
    // Sequence: validated offer at seq 5, superseded by a zero-surface scan at
    // seq 6 that published a hidden frame. The delayed old result (seq 5) must
    // be rejected so it cannot restore chips.
    const latest = 6;
    expect(frameResultIsCurrent(6, latest)).toBe(true); // the zero-surface scan
    expect(frameResultIsCurrent(5, latest)).toBe(false); // the delayed old result
    expect(frameResultIsCurrent(7, latest)).toBe(false); // a superseded newer clear
  });
});
