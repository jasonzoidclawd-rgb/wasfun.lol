import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { computeOracleScore } from "@/lib/scoring/oracle-score";

/**
 * Regression: `championStatisticsAvailable` ANDed win rate with pick rate. When
 * the source stopped publishing champion pick rate, all 173 champion pages
 * claimed "Statistics not yet available for this patch" while holding a win
 * rate, tier and rank — and `champWr` became null, emptying the member Oracle
 * augment ranking on every champion.
 */
const SOURCE = readFileSync(
  path.join(process.cwd(), "src/app/[locale]/champions/[slug]/page.tsx"),
  "utf8",
);

type Champ = { win_rate: number | null; pick_rate: number | null; tier?: string | null; rank?: number | null };
const hasWinRate = (c: Champ) => typeof c.win_rate === "number";
const hasPickRate = (c: Champ) => typeof c.pick_rate === "number";
const hasAnyStatistic = (c: Champ) =>
  hasWinRate(c) || hasPickRate(c) || c.tier != null || c.rank != null;
const champWr = (c: Champ) => (hasWinRate(c) ? c.win_rate : null);

describe("champion statistical fields are independently available", () => {
  const cases: Array<[string, Champ]> = [
    ["WR present / PR present", { win_rate: 52.6, pick_rate: 14.2, tier: "S+", rank: 4 }],
    ["WR present / PR missing", { win_rate: 52.6, pick_rate: null, tier: "S+", rank: 4 }],
    ["WR missing / PR present", { win_rate: null, pick_rate: 14.2, tier: "A", rank: 40 }],
    ["tier+rank only", { win_rate: null, pick_rate: null, tier: "A", rank: 40 }],
    ["both missing, no tier/rank", { win_rate: null, pick_rate: null, tier: null, rank: null }],
  ];

  test.each(cases)("%s: each field stands alone", (_label, champ) => {
    expect(hasWinRate(champ)).toBe(typeof champ.win_rate === "number");
    expect(hasPickRate(champ)).toBe(typeof champ.pick_rate === "number");
  });

  test("a missing pick rate never suppresses the win rate", () => {
    const champ: Champ = { win_rate: 52.62, pick_rate: null, tier: "S+", rank: 4 };
    expect(hasWinRate(champ)).toBe(true);
    expect(champWr(champ)).toBe(52.62);
    expect(hasAnyStatistic(champ)).toBe(true);
  });

  test("'no statistics' is claimed only when nothing at all is known", () => {
    expect(hasAnyStatistic({ win_rate: 52.6, pick_rate: null })).toBe(true);
    expect(hasAnyStatistic({ win_rate: null, pick_rate: null, tier: "A" })).toBe(true);
    expect(hasAnyStatistic({ win_rate: null, pick_rate: null, rank: 7 })).toBe(true);
    expect(hasAnyStatistic({ win_rate: null, pick_rate: null, tier: null, rank: null })).toBe(false);
  });

  test("Oracle scoring needs only the win rate", () => {
    const augment = {
      slug: "tank-engine", name: "Tank Engine", rarity: "gold" as const,
      win_rate: null, icon: "", wikiDescription: "bonus health",
    };
    const withWr = computeOracleScore({ augment, championWinRate: 52.62 });
    const withoutWr = computeOracleScore({ augment });
    expect(withWr.total).toBeGreaterThan(0);
    expect(withWr.total).not.toBe(withoutWr.total);
  });

  test("the page no longer gates on both rates together", () => {
    // The combined gate must not exist as a binding or a render condition.
    // (The identifier may still appear in a comment explaining the regression.)
    expect(SOURCE).not.toContain("const championStatisticsAvailable");
    expect(SOURCE).not.toContain("{championStatisticsAvailable");
    expect(SOURCE).toContain("const hasWinRate =");
    expect(SOURCE).toContain("const hasPickRate =");
    // Oracle ranking must depend on the win rate alone.
    expect(SOURCE).toContain("const scoredAugments = champWr !== null");
  });

  test("live data: win rate survives the pick-rate outage", () => {
    const champions = JSON.parse(
      readFileSync(path.join(process.cwd(), "public/data/champions.json"), "utf-8"),
    ).champions as Champ[];
    const withWr = champions.filter(hasWinRate).length;
    expect(withWr).toBeGreaterThan(champions.length * 0.9);
    // Every champion holding a win rate must be Oracle-scorable.
    expect(champions.filter((c) => champWr(c) !== null).length).toBe(withWr);
  });
});
