/**
 * Failure D — `質變：大混亂` canonical-matching side.
 *
 * The live retest showed this card going SCANNING → OCR ERROR. This test pins
 * the CANONICAL-MATCHING half: the deterministic normalizer must collapse the
 * full-width colon `：` (U+FF1A), the ASCII colon `:`, and the colon-less form to
 * ONE identical lookup key, and must do so via explicit Unicode normalization
 * (NFKC) + punctuation stripping — never fuzzy matching that could confuse
 * distinct augments. If these all agree, a canonical-name catalog entry resolves
 * regardless of which colon the OCR emits, which isolates any remaining failure
 * to OCR recognition (crop/glyphs) or catalog membership, not normalization.
 */
import { describe, expect, it } from "vitest";
import { normalizeAugmentNameForLookup } from "./scoring/offer-lookup";

describe("質變：大混亂 punctuation normalization (failure D — matching side)", () => {
  const FULLWIDTH = "質變：大混亂"; // U+FF1A full-width colon (Traditional client)
  const ASCII = "質變:大混亂"; // U+003A ascii colon (OCR substitution)
  const COLONLESS = "質變大混亂"; // colon dropped entirely by OCR

  it("collapses full-width, ASCII, and colon-less variants to one key", () => {
    const key = normalizeAugmentNameForLookup(FULLWIDTH);
    expect(key).toBe(normalizeAugmentNameForLookup(ASCII));
    expect(key).toBe(normalizeAugmentNameForLookup(COLONLESS));
    expect(key).toBe("質變大混亂");
  });

  it("tolerates surrounding whitespace and stray spacing around punctuation", () => {
    expect(normalizeAugmentNameForLookup("  質變 ： 大混亂 ")).toBe("質變大混亂");
  });

  it("preserves the meaningful Chinese glyphs (no over-stripping)", () => {
    const key = normalizeAugmentNameForLookup(FULLWIDTH);
    for (const glyph of ["質", "變", "大", "混", "亂"]) {
      expect(key).toContain(glyph);
    }
  });

  it("keeps distinct augments distinct (normalization is not fuzzy)", () => {
    expect(normalizeAugmentNameForLookup("質變：大混亂")).not.toBe(
      normalizeAugmentNameForLookup("質變：小混亂"),
    );
  });
});
