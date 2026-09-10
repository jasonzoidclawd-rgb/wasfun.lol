import { describe, expect, test } from "vitest";
import { normalizeChampionName, resolveKnownChampionSlug } from "./championResolve";

const slugByName = new Map<string, string>([
  ["cho'gath", "chogath"],
  ["chogath", "chogath"],
  ["米利歐", "milio"],
  ["wukong", "wukong"],
]);
const knownSlugs = new Set(["chogath", "milio", "wukong", "leesin"]);

describe("resolveKnownChampionSlug", () => {
  test("resolves exact and lowercased catalog names", () => {
    expect(resolveKnownChampionSlug("Cho'Gath", slugByName, knownSlugs)).toBe("chogath");
    expect(resolveKnownChampionSlug("cho'gath", slugByName, knownSlugs)).toBe("chogath");
  });

  test("resolves localized catalog names", () => {
    expect(resolveKnownChampionSlug("米利歐", slugByName, knownSlugs)).toBe("milio");
  });

  test("resolves punctuation and case via normalization", () => {
    expect(resolveKnownChampionSlug("CHO GATH", slugByName, knownSlugs)).toBe("chogath");
  });

  test("accepts a raw name that already equals a known slug", () => {
    expect(resolveKnownChampionSlug("Lee Sin", slugByName, knownSlugs)).toBe("leesin");
  });

  test("returns null for champ-select placeholder text", () => {
    expect(resolveKnownChampionSlug("Locked", slugByName, knownSlugs)).toBeNull();
    expect(resolveKnownChampionSlug("locked", slugByName, knownSlugs)).toBeNull();
  });

  test("returns null for empty or garbage input", () => {
    expect(resolveKnownChampionSlug("", slugByName, knownSlugs)).toBeNull();
    expect(resolveKnownChampionSlug("   ", slugByName, knownSlugs)).toBeNull();
    expect(resolveKnownChampionSlug("???", slugByName, knownSlugs)).toBeNull();
    expect(resolveKnownChampionSlug("Choose a champion", slugByName, knownSlugs)).toBeNull();
    expect(resolveKnownChampionSlug("FutureChampion", slugByName, knownSlugs)).toBeNull();
  });
});

describe("normalizeChampionName", () => {
  test("keeps ascii letters only, lowercased", () => {
    expect(normalizeChampionName("Cho'Gath")).toBe("chogath");
    expect(normalizeChampionName("Dr. Mundo")).toBe("drmundo");
  });
});
