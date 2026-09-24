/**
 * Phase 1 real-data backtests and engine checks, on a frozen provider snapshot
 * (fixtures/score/provider-2026-09-21.json) so the recorded numbers reproduce.
 */
import { describe, expect, test } from "vitest";
import fixture from "./fixtures/score/provider-2026-09-21.json";
import { carryOverBacktest, type SnapshotRow } from "../score/backtest";
import { CARRY_OVER_ENABLED, UNLISTED_ENVELOPE } from "../score/config";
import {
  augmentPosteriors,
  BUILD_FLOOR,
  bootsSet,
  buildOrders,
  championLetters,
  championSet,
  RARITIES,
  tierList,
  type ChampionRow,
  type Feeds,
} from "../score/engine";
import { estimateVolume } from "../score/volume";

const feeds = {
  augmentRows: fixture.augmentRows,
  champions: fixture.champions,
  championWinRates: fixture.championWinRates,
} as unknown as Feeds;
const histories = Object.values(fixture.champions).map((c) => (c as { history: SnapshotRow[] }).history);
const patchStarts = (fixture as unknown as { patchStarts: Record<string, string> }).patchStarts;
const volume = estimateVolume(histories, patchStarts, { patch: fixture.patch, dataDate: fixture.dataDate });

describe("noise scale from the provider's own snapshot history: a lower bound", () => {
  test("day-pairs disagree too much to report one rate, so the smallest is used", () => {
    expect(volume).not.toBeNull();
    expect(volume!.status).toBe("lower-bound");
    const rates = volume!.pairs.map((p) => p.gamesPerDay);
    expect(rates.length).toBeGreaterThanOrEqual(5);
    // Recorded 2026-09-24: 164k to 1.8M games a day across six day-pairs.
    expect(Math.max(...rates) / Math.min(...rates)).toBeGreaterThan(5);
    expect(volume!.gamesPerDay).toBe(Math.min(...rates));
    // This snapshot's data date (09-21) precedes its patch's start (09-22): flagged, floored at one day.
    expect(volume!.days).toBe(1);
    expect(volume!.note).toMatch(/before the start of patch 26\.19/);
    expect(volume!.games).toBeCloseTo(volume!.gamesPerDay, 6);
  });
});

describe("backtest, carry-over: day-early grades vs end-of-patch rows", () => {
  test("the switch follows the backtest: carry-over ships only if it beats the raw early snapshot", () => {
    const r = carryOverBacktest(histories, patchStarts, volume!.gamesPerDay, 0.25); // the spec's drift, unchanged entries
    expect(r.cases).toBeGreaterThan(300);
    expect(CARRY_OVER_ENABLED).toBe(r.rmseCarry < r.rmseRaw);
    // Recorded 2026-09-24: raw 0.153 pp, carry-over 0.324 pp, last patch alone 1.295 pp.
    expect(r.rmseRaw).toBeCloseTo(0.153, 2);
    expect(r.rmseLastPatch).toBeGreaterThan(1);
  });
});

describe("backtest, pooling: not runnable on provider data", () => {
  test("champion rows copy the global rows, so there is nothing to hold out", () => {
    expect(fixture.championWinRates).toBe("global-copy");
    const glob = new Map(fixture.augmentRows.map((r) => [r.sourceSlug, r.winRate]));
    const rows = Object.values(fixture.champions).flatMap((c) => (c as ChampionRow).augments);
    expect(rows.every((r) => glob.get(r.sourceSlug) === r.winRate)).toBe(true);
  });

  test("so a champion's values are exactly the global posteriors (no pooled path, no synergy)", () => {
    const opts = { volume: volume!.games };
    const global = augmentPosteriors(feeds, "gold", opts);
    const pool = global.slice(0, 20).map((p) => p.id);
    const set = championSet(global, pool);
    for (const o of set) {
      const g = global.find((p) => p.id === o.id)!;
      expect(o.m).toBe(g.m);
      expect(o.v).toBe(g.v);
    }
  });
});

describe("the engine on real rows", () => {
  const opts = { volume: volume!.games };

  test("every resolved live augment with a pick rate gets a letter, in every rarity", () => {
    for (const rarity of RARITIES) {
      const expected = fixture.augmentRows.filter(
        (r) => r.rarity === rarity && r.availability === "live" && r.augmentId && r.pickRate > 0,
      ).length;
      const list = tierList(feeds, rarity, opts);
      expect(list.length).toBe(expected);
      expect(list.every((o) => ["S", "A", "B", "C", "D"].includes(o.letter))).toBe(true);
    }
  });

  test("letters follow the posterior order and never overstate a well-measured row", () => {
    for (const rarity of RARITIES) {
      const list = [...tierList(feeds, rarity, opts)].sort((a, b) => a.order - b.order);
      const rank = { S: 4, A: 3, B: 2, C: 1, D: 0 };
      for (let i = 1; i < list.length; i++) expect(rank[list[i].letter]).toBeLessThanOrEqual(rank[list[i - 1].letter]);
      for (const o of list) {
        if (o.thin) continue;
        if (o.letter === "S") expect(o.m).toBeGreaterThanOrEqual(3.5);
        if (o.letter === "A") expect(o.m).toBeGreaterThanOrEqual(1.5);
        if (o.letter === "D") expect(o.m).toBeLessThanOrEqual(-3.5);
        if (o.letter === "C") expect(o.m).toBeLessThanOrEqual(-1.5);
      }
    }
  });

  test("the Swap check grades every champion with a pick rate", () => {
    const champs = championLetters(feeds, opts);
    expect(champs.length).toBe(Object.values(fixture.champions).filter((c) => (c as ChampionRow).pickRate).length);
    const yasuo = champs.find((c) => c.id === "yasuo")!;
    expect(["S", "A"]).toContain(yasuo.letter); // the field's top win rate, precisely measured
  });

  test("boots are graded; build orders are ranked by win rate among paths built in ≥1% of games, never graded", () => {
    const yasuo = fixture.champions.yasuo as unknown as ChampionRow;
    const boots = bootsSet(yasuo, opts)!;
    expect(boots.find((b) => b.id === "berserkers_greaves")!.letter).toMatch(/[SA]/);
    const { ranked } = buildOrders(yasuo, opts);
    expect(ranked.every((b) => b.pickRate >= BUILD_FLOOR)).toBe(true);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i].winRate).toBeLessThanOrEqual(ranked[i - 1].winRate);
    expect(ranked.filter((b) => b.mostBuilt)).toHaveLength(1);
    expect(ranked[0]).not.toHaveProperty("letter");
  });
});

describe("takers adjustment: the unlisted-share envelope does not assume a top-six listing", () => {
  test("the envelope runs from 0 to the mass cap, and no letter is stronger than under the old 0.25–0.75 envelope", () => {
    expect(UNLISTED_ENVELOPE[0]).toBe(0);
    const rank = (l: string) => "SABCD".indexOf(l);
    for (const r of RARITIES) {
      const wide = tierList(feeds, r, { volume: volume!.games });
      const narrow = new Map(tierList(feeds, r, { volume: volume!.games, unlistedEnvelope: [0.25, 0.75] }).map((o) => [o.id, o.letter]));
      for (const o of wide) {
        const before = narrow.get(o.id)!;
        // stronger means further from B than before, in the same direction
        const further = Math.abs(rank(o.letter) - 2) > Math.abs(rank(before) - 2) && Math.sign(rank(o.letter) - 2) === Math.sign(rank(before) - 2 || rank(o.letter) - 2);
        expect(further, `${r} ${o.id}: ${before} → ${o.letter}`).toBe(false);
      }
    }
  }, 120_000);
});
