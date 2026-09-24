/**
 * Home "Moved since last patch": only changes beyond noise are shown, and an
 * empty list says "no move beyond noise yet", never "nothing changed".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ChampionRow } from "../score/engine";
import { championMovers, MOVE_Z } from "../score/movers";

const row = (winRate: number, pickRate: number, prev: { patch: string; winRate: number } | null): ChampionRow => ({
  winRate,
  pickRate,
  patch: "26.19",
  dataDate: "2026-09-21",
  augments: [],
  items: {},
  history: [
    { snapshot: "20260922_000000", patch: "26.19", winRate, pickRate },
    ...(prev ? [{ snapshot: "20260920_000000", patch: prev.patch, winRate: prev.winRate, pickRate }] : []),
  ],
});

describe("moved since last patch", () => {
  test("a change inside the noise is not shown; one well beyond it is", () => {
    const movers = championMovers(
      {
        steady: row(52.2, 10, { patch: "26.18", winRate: 52.0 }),
        jumped: row(56.0, 10, { patch: "26.18", winRate: 51.0 }),
        dropped: row(46.0, 10, { patch: "26.18", winRate: 51.0 }),
      },
      "26.19",
      100_000,
    );
    expect(movers.map((m) => m.slug).sort()).toEqual(["dropped", "jumped"]);
    for (const m of movers) expect(Math.abs(m.z)).toBeGreaterThanOrEqual(MOVE_Z);
  });

  test("fewer games means a wider noise band: the same change can stop passing", () => {
    const champions = { c: row(53.5, 5, { patch: "26.18", winRate: 51.0 }) };
    expect(championMovers(champions, "26.19", 200_000)).toHaveLength(1);
    expect(championMovers(champions, "26.19", 5_000)).toHaveLength(0);
  });

  test("no previous patch in the history: nothing to compare, nothing shown", () => {
    expect(championMovers({ c: row(60, 10, null) }, "26.19", 1e6)).toEqual([]);
  });

  test("the empty state says no move beyond noise yet, in every locale", () => {
    for (const locale of ["en", "zh-TW", "zh-CN", "ja", "ko"]) {
      const home = JSON.parse(readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf-8")).home;
      expect(home.movedNone, locale).toEqual(expect.any(String));
    }
    const en = JSON.parse(readFileSync(path.join(process.cwd(), "messages/en.json"), "utf-8")).home.movedNone as string;
    expect(en).toMatch(/noise/);
    expect(en).not.toMatch(/nothing changed/i);
  });
});
