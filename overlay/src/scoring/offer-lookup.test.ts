import { describe, expect, it } from "vitest";
import { diagnoseAugmentMatch, type OverlayAugmentLookup } from "./offer-lookup";
import type { PoolAugment } from "./probability";

function augment(overrides: Partial<PoolAugment> = {}): PoolAugment {
  return {
    slug: "arcane-comet",
    name: "Arcane Comet",
    win_rate: 55,
    score: 60,
    tier: "B",
    rarity: "gold",
    probability: 0.2,
    probabilityWithReroll: 0.4,
    ...overrides,
  };
}

describe("OCR match diagnostics", () => {
  it("reports an exact accepted match", () => {
    const candidate = augment();
    const lookup: OverlayAugmentLookup = new Map([[
      "arcanecomet",
      candidate,
    ]]);

    expect(diagnoseAugmentMatch("Arcane Comet", lookup)).toEqual({
      augment: candidate,
      normalizedText: "arcanecomet",
      bestCandidate: "arcane-comet",
      confidence: 1,
      rejectionReason: null,
    });
  });

  it("reports normalization and the rejection reason for empty OCR", () => {
    const result = diagnoseAugmentMatch(" : ! ", new Map());

    expect(result.normalizedText).toBe("");
    expect(result.bestCandidate).toBeNull();
    expect(result.rejectionReason).toBe("empty-after-normalization");
  });

  it("reports the nearest candidate when OCR text is rejected", () => {
    const lookup: OverlayAugmentLookup = new Map([[
      "arcanecomet",
      augment(),
    ]]);

    const result = diagnoseAugmentMatch("zz", lookup);

    expect(result.augment).toBeNull();
    expect(result.bestCandidate).toBe("arcane-comet");
    expect(result.confidence).toBeCloseTo(1 / 12);
    expect(result.rejectionReason).toMatch(/^distance-11-exceeds-threshold-1$/);
  });
});
