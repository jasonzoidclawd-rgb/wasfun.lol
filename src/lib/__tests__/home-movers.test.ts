/**
 * Home "Moved since last patch": only changes well beyond noise are shown, with
 * the bar raised for testing every champion at once; rows that predate the
 * patch show nothing (undetermined), and an empty list never says "nothing changed".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ChampionRow } from "../score/engine";
import { championMovers, criticalZ, patchDataState } from "../score/movers";

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
const vol = (current: number, previous: number | null = current) => ({ current, previous: () => previous });

describe("moved since last patch", () => {
  test("a change inside the noise is not shown; one well beyond it is", () => {
    const movers = championMovers(
      {
        steady: row(52.2, 10, { patch: "26.18", winRate: 52.0 }),
        jumped: row(56.0, 10, { patch: "26.18", winRate: 51.0 }),
        dropped: row(46.0, 10, { patch: "26.18", winRate: 51.0 }),
      },
      "26.19",
      vol(100_000),
    );
    expect(movers.map((m) => m.slug).sort()).toEqual(["dropped", "jumped"]);
    for (const m of movers) expect(Math.abs(m.z)).toBeGreaterThanOrEqual(criticalZ(3));
  });

  test("the bar rises with the number of champions tested (Bonferroni over the 3σ rate)", () => {
    expect(criticalZ(1)).toBeCloseTo(3, 2);
    expect(criticalZ(173)).toBeGreaterThan(4.3);
    // a 3.5σ move passes alone but not among 173 champions
    const champions: Record<string, ChampionRow> = { c: row(53.0, 10, { patch: "26.18", winRate: 51.0 }) };
    const alone = championMovers(champions, "26.19", vol(150_000));
    expect(alone).toHaveLength(1);
    const z = alone[0].z;
    expect(z).toBeGreaterThan(3);
    expect(z).toBeLessThan(criticalZ(173));
    for (let i = 0; i < 172; i++) champions[`x${i}`] = row(51.0, 10, { patch: "26.18", winRate: 51.0 });
    expect(championMovers(champions, "26.19", vol(150_000)).map((m) => m.slug)).not.toContain("c");
  });

  test("each side uses its own patch's game count; an unknown count means not tested", () => {
    const champions = { c: row(55.0, 5, { patch: "26.18", winRate: 51.0 }) };
    expect(championMovers(champions, "26.19", vol(200_000, 200_000))).toHaveLength(1);
    expect(championMovers(champions, "26.19", vol(200_000, 2_000))).toHaveLength(0);
    expect(championMovers(champions, "26.19", vol(200_000, null))).toHaveLength(0);
  });

  test("no previous patch in the history: nothing to compare, nothing shown", () => {
    expect(championMovers({ c: row(60, 10, null) }, "26.19", vol(1e6))).toEqual([]);
  });

  test("rows dated before the patch began predate it: no patch-week line, no comparison", () => {
    expect(patchDataState("2026-09-21", "2026-09-22T18:00:00Z")).toEqual({ predates: true, days: null });
    // the start day itself holds at most hours of the patch, maybe none: still undetermined
    expect(patchDataState("2026-09-22", "2026-09-22T18:00:00Z")).toEqual({ predates: true, days: null });
    expect(patchDataState("2026-09-23", "2026-09-22T18:00:00Z")).toEqual({ predates: false, days: 1 });
    expect(patchDataState("2026-09-25", "2026-09-22T18:00:00Z")).toEqual({ predates: false, days: 3 });
    expect(patchDataState("not-a-date", "2026-09-22T18:00:00Z")).toEqual({ predates: true, days: null });
    expect(patchDataState("2026-09-23", undefined)).toEqual({ predates: true, days: null });
    const home = readFileSync(path.join(process.cwd(), "src/app/[locale]/page.tsx"), "utf-8");
    expect(home).toContain("volume && !state.predates ? championMovers(");
    expect(home).toContain("state.days !== null && state.days <= PATCH_WEEK_DAYS");
  });

  test("the empty and predates states never say nothing changed, in every locale", () => {
    for (const locale of ["en", "zh-TW", "zh-CN", "ja", "ko"]) {
      const home = JSON.parse(readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf-8")).home;
      expect(home.movedNone, locale).toEqual(expect.any(String));
      expect(home.movedPredates, locale).toEqual(expect.any(String));
    }
    const en = JSON.parse(readFileSync(path.join(process.cwd(), "messages/en.json"), "utf-8")).home;
    expect(en.movedNone).toMatch(/noise/);
    expect(en.movedPredates).toMatch(/not known yet/i);
    expect(`${en.movedNone} ${en.movedPredates}`).not.toMatch(/nothing changed/i);
  });
});
