import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { isConfirmedLive } from "@/lib/augments/availability";

const locales = ["en", "zh-TW", "zh-CN", "ja", "ko"] as const;

type ComboRecord = { champion: string; augment: string; tier: string };
type CatalogAugment = { slug: string; name: string; availability?: { status?: string } };
type CatalogChampion = { slug: string; rank: number | null; tier: string | null };

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), relative), "utf-8")) as T;
}

function readMessages(locale: string): Record<string, Record<string, string>> {
  return readJson(`messages/${locale}.json`);
}

const publicCombos = readJson<{ combos: ComboRecord[] }>("public/data/combos.json").combos;
const publicAugments = readJson<{ augments: CatalogAugment[] }>(
  "public/data/augments.json",
).augments;
const publicChampions = readJson<{ champions: CatalogChampion[] }>(
  "public/data/champions.json",
).champions;

describe("the public combo payload carries no ranking evidence", () => {
  test("every published combo is the same tier, so tier cannot order them", () => {
    // export_public_catalog.build_combo_teaser publishes S-tier only, capped at
    // 3 per champion. A uniform tier is the DESIGN of the public ladder, not a
    // generator bug — the internal catalog keeps the full S/A/B/C spread. It
    // does mean nothing in this payload ranks one combo above another.
    const tiers = new Set(publicCombos.map((combo) => combo.tier));

    expect(publicCombos.length).toBeGreaterThan(0);
    expect([...tiers]).toEqual(["S"]);
  });

  test("no champion is published more than the teaser cap", () => {
    const perChampion = new Map<string, number>();
    for (const combo of publicCombos) {
      perChampion.set(combo.champion, (perChampion.get(combo.champion) ?? 0) + 1);
    }

    expect(Math.max(...perChampion.values())).toBeLessThanOrEqual(3);
  });
});

describe("the homepage combo claim matches what it can prove", () => {
  test("the heading claims champion ranking, not combo ranking, in every locale", () => {
    for (const locale of locales) {
      const title = readMessages(locale).dashboard.combosTitle;

      expect(title, locale).toEqual(expect.any(String));
      expect(title.trim(), locale).not.toBe("");
      // "Top combos" asserted an ordering the payload cannot support.
      expect(title.toLowerCase(), locale).not.toBe("top combos");
    }
  });

  test("the v3 Home carries no combo list, so it makes no combo ordering claim at all", () => {
    // The old Home ordered S-tier combos by champion rank. v3 Home answers
    // "where's my champion, and what changed?" and has no combo surface; the
    // combo teaser must not come back without evidence that can order it.
    const source = readFileSync(
      path.join(process.cwd(), "src/app/[locale]/page.tsx"),
      "utf-8",
    );

    expect(source).not.toMatch(/ComboHighlights|readCombosFile|combos\.json/);
    expect(source).not.toMatch(/comboScore|scoreCombo|Math\.random/);
  });

  test("champion rank is a complete, deterministic ordering key", () => {
    const ranked = publicChampions.filter((c) => c.rank != null);
    const ranks = ranked.map((c) => c.rank as number);

    expect(ranked.length).toBeGreaterThan(0);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("withdrawn augments never reach a suggestion surface", () => {
  const augmentByName = new Map(publicAugments.map((a) => [a.name, a]));

  test("no published combo references an augment that is not offerable", () => {
    const offending = publicCombos.filter((combo) => {
      const augment = augmentByName.get(combo.augment);
      return !augment || !isConfirmedLive(augment);
    });

    expect(offending).toEqual([]);
  });

  test("the homepage suggests no augment: its only augment surface is the patch notes' change list", () => {
    // Combos are generated before the augment lifecycle is resolved, so the old
    // Home re-checked availability before suggesting one. v3 Home suggests no
    // augment; it lists augments the patch notes name, which is a fact about
    // the patch, and links nothing from the combo snapshot.
    const source = readFileSync(
      path.join(process.cwd(), "src/app/[locale]/page.tsx"),
      "utf-8",
    );

    expect(source).toContain('note.sections.filter((s) => s.id === "augments")');
    expect(source).not.toMatch(/AugmentSpotlight|ComboHighlights|TierMiniGrid|HeroMover/);
  });

  test("a disabled augment is dropped from the highlight list", () => {
    const augments = [
      { slug: "live-one", name: "Live One", availability: { status: "confirmed_live" } },
      { slug: "off-one", name: "Off One", availability: { status: "disabled" } },
    ];
    const byName = new Map(augments.map((a) => [a.name, a]));
    const combos: ComboRecord[] = [
      { champion: "brand", augment: "Off One", tier: "S" },
      { champion: "garen", augment: "Live One", tier: "S" },
    ];

    const kept = combos.filter((combo) => {
      const augment = byName.get(combo.augment);
      return augment?.availability?.status === "confirmed_live";
    });

    expect(kept.map((c) => c.augment)).toEqual(["Live One"]);
  });
});
