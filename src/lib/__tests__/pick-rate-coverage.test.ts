import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  hasPickRateCoverage,
  pickRateCoverage,
} from "@/lib/champions/pick-rate-coverage";
import { buildChampionDetailJsonLd } from "@/lib/seo/champion-detail";
import type { ChampionDetailChampion } from "@/lib/champions/detail-data";

const locales = ["en", "zh-TW", "zh-CN", "ja", "ko"] as const;

type Champ = { slug: string; pick_rate: number | null; win_rate: number | null };

function readChampions(): Champ[] {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "public/data/champions.json"), "utf-8"),
  ).champions as Champ[];
}

function readSource(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf-8");
}

function readMessages(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf-8"),
  );
}

const NONE: Champ[] = [
  { slug: "a", pick_rate: null, win_rate: 52 },
  { slug: "b", pick_rate: null, win_rate: 49 },
];
const PARTIAL: Champ[] = [
  { slug: "a", pick_rate: 14.2, win_rate: 52 },
  { slug: "b", pick_rate: null, win_rate: 49 },
];
const FULL: Champ[] = [
  { slug: "a", pick_rate: 14.2, win_rate: 52 },
  { slug: "b", pick_rate: 3.1, win_rate: 49 },
];

describe("pick-rate coverage measurement", () => {
  test("coverage is measured from the roster, not assumed", () => {
    expect(pickRateCoverage(NONE)).toBe(0);
    expect(pickRateCoverage(PARTIAL)).toBe(0.5);
    expect(pickRateCoverage(FULL)).toBe(1);
  });

  test("surfaces toggle on any coverage at all, not on full coverage", () => {
    expect(hasPickRateCoverage(NONE)).toBe(false);
    expect(hasPickRateCoverage(PARTIAL)).toBe(true);
    expect(hasPickRateCoverage(FULL)).toBe(true);
  });

  test("an empty roster is zero coverage, never a division by zero", () => {
    expect(pickRateCoverage([])).toBe(0);
    expect(hasPickRateCoverage([])).toBe(false);
  });

  test("a zero pick rate is a value, not a missing one", () => {
    expect(hasPickRateCoverage([{ pick_rate: 0 }])).toBe(true);
  });

  test("the live roster's coverage decides what the site currently shows", () => {
    const champions = readChampions();
    const coverage = pickRateCoverage(champions);

    expect(champions.length).toBeGreaterThan(0);
    expect(coverage).toBeGreaterThanOrEqual(0);
    expect(coverage).toBeLessThanOrEqual(1);
    // Whatever the source publishes today, the two must agree.
    expect(hasPickRateCoverage(champions)).toBe(coverage > 0);
  });
});

describe("pick-rate surfaces are coverage-gated", () => {
  test("the champions table hides the column when nothing is covered", () => {
    const source = readSource("src/components/champions/ChampionsIndex.tsx");

    expect(source).toContain("hasPickRateCoverage(champions)");
    expect(source).toContain("{showPickRate ? (");
    // Both the header and the cell sit behind the same flag: the column is
    // never emitted unconditionally again.
    expect(source).toMatch(/showPickRate[\s\S]{0,80}h: "Pick%"/);
    expect(source).not.toMatch(/^\s*\{ h: "Pick%", hide: "mobile" as const \},\s*$/m);
  });

  test("the homepage drops the pick stat instead of labelling an em-dash", () => {
    const source = readSource("src/components/dashboard/HeroMover.tsx");

    expect(source).toContain("champion.pick_rate != null ? (");
    // The "— pick" placeholder is gone: no em-dash is rendered beside the
    // pick-rate label any more.
    expect(source).not.toMatch(/pick_rate[\s\S]{0,60}"—"/);
  });

  test("the champions index meta description is chosen by coverage", () => {
    const source = readSource("src/app/[locale]/champions/page.tsx");

    expect(source).toContain("hasPickRateCoverage(champions)");
    expect(source).toContain('t("metaDescription")');
    expect(source).toContain('t("metaDescriptionNoPickRate")');
  });

  test("the zero-coverage meta description claims no pick rates, in every locale", () => {
    const claims: Record<(typeof locales)[number], RegExp> = {
      en: /pick rate/i,
      "zh-TW": /選用率/,
      "zh-CN": /选取率/,
      ja: /ピック率/,
      ko: /선택률|픽률/,
    };

    for (const locale of locales) {
      const champion = readMessages(locale).champion;

      expect(champion.metaDescriptionNoPickRate, locale).toEqual(expect.any(String));
      expect(champion.metaDescriptionNoPickRate, locale).not.toMatch(claims[locale]);
      // The covered variant still advertises it, so the claim returns with the data.
      expect(champion.metaDescription, locale).toMatch(claims[locale]);
    }
  });

  test("the per-champion 'unavailable' note only appears under partial coverage", () => {
    const source = readSource("src/app/[locale]/champions/[slug]/page.tsx");

    expect(source).toContain("const pickRateTracked = hasPickRateCoverage(champions)");
    expect(source).toContain("{!hasPickRate && pickRateTracked && hasAnyStatistic && (");
  });
});

describe("pick-rate structured data follows the value", () => {
  const champion = (pick_rate: number | null): ChampionDetailChampion =>
    ({
      slug: "brand",
      name: "Brand",
      icon: "/icon.png",
      tier: "S",
      rank: 4,
      win_rate: 52.62,
      pick_rate,
    }) as ChampionDetailChampion;

  const options = {
    url: "https://wasfun.lol/champions/brand",
    homeUrl: "https://wasfun.lol",
    championsUrl: "https://wasfun.lol/champions",
    championsLabel: "Champions",
    name: "Brand",
  };

  function properties(pick_rate: number | null): string[] {
    const graph = buildChampionDetailJsonLd(champion(pick_rate), "en", options)[
      "@graph"
    ] as Array<Record<string, unknown>>;
    const person = graph.find((node) => node["@type"] === "Person")!;
    const additional = (person.additionalProperty ?? []) as Array<{ name: string }>;
    return additional.map((property) => property.name);
  }

  test("no pick-rate property is emitted without a pick rate", () => {
    expect(properties(null)).not.toContain("Public pick rate");
    expect(properties(null)).toContain("Public win rate");
  });

  test("the property returns on its own when the value does", () => {
    expect(properties(14.22)).toContain("Public pick rate");
  });

  test("the live roster emits no pick-rate property while coverage is zero", () => {
    const champions = readChampions();
    if (hasPickRateCoverage(champions)) return;

    for (const row of champions.slice(0, 20)) {
      expect(properties(row.pick_rate), row.slug).not.toContain("Public pick rate");
    }
  });
});
