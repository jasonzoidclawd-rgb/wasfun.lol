/**
 * Phase 1 scoring tests (spec, Build order: "Scoring tests (phase 1)").
 * Each describe block names the acceptance box it checks.
 */
import { describe, expect, test } from "vitest";
import { carriedPrior, combineOnce, DRIFT_CHANGED, DRIFT_UNCHANGED } from "../score/carryover";
import { TAU_ASSUMED, unlistedSubtractionAllowed } from "../score/config";
import { pooledPairPosterior } from "../score/engine";
import { correctForRandomGrants, pandorasBoxForHoldings } from "../score/gambles";
import { bandOf, GRADE_INFLATE, pairwise, type Letter } from "../score/grade";
import { leaveOneOutLifts } from "../score/lift";
import { gaussian, Phi, rng } from "../score/normal";
import { misorderedSplitPairs, simulateSet } from "../score/sim";
import { debounce, groupingOf, patchDelta, synergy, type DebounceState } from "../score/stability";
import { rerollHints, rerollOdds, rerollPool, verdict } from "../score/verdict";

const RANK: Record<Letter, number> = { S: 4, A: 3, B: 2, C: 1, D: 0 };

describe("noise always uses the baseline rate: a 3–0 row is never treated as certain", () => {
  test("an option that won 3 of 3 carries the set's noise, not zero", () => {
    const set = leaveOneOutLifts([
      { id: "lucky", p: 0.001, w: 1.0, n: 3 },
      { id: "a", p: 0.5, w: 0.53, n: 50_000 },
      { id: "b", p: 0.499, w: 0.52, n: 50_000 },
    ]);
    // w(1 − w)/n would be 0 for the 3–0 row; the baseline rate gives ~29 pp.
    expect(set.ownSe[0]).toBeGreaterThan(25);
    expect(set.se2[0]).toBeGreaterThan(600);
  });
});

describe("unit guard: the unlisted-pair subtraction stays off until units are confirmed", () => {
  test("off with unconfirmed units, off when a listed share exceeds its global share, on only when both hold", () => {
    const shares = { listedShare: { a: 0.1 }, globalShare: { a: 0.2 } };
    expect(unlistedSubtractionAllowed({ unitsConfirmed: false, ...shares })).toBe(false);
    expect(unlistedSubtractionAllowed({ unitsConfirmed: true, listedShare: { a: 0.3 }, globalShare: { a: 0.2 } })).toBe(false);
    expect(unlistedSubtractionAllowed({ unitsConfirmed: true, ...shares })).toBe(true);
  });
});

describe("each day's snapshot is combined once with the carried-over prior, never chained", () => {
  test("drift is (0.5 pp)² unchanged and (3 pp)² + (1 pp)² changed", () => {
    expect(carriedPrior({ m: 1, v: 0.1 }, false).v).toBeCloseTo(0.1 + 0.25);
    expect(carriedPrior({ m: 1, v: 0.1 }, true).v).toBeCloseTo(0.1 + DRIFT_CHANGED);
    expect(DRIFT_UNCHANGED).toBe(0.25);
  });

  test("combining the cumulative day-7 snapshot once differs from chaining days 1..7", () => {
    const prior = { m: 0, v: 1 };
    const day = (d: number) => ({ kind: "patch-to-date" as const, snapshotDate: `d${d}`, l: 2, se2: 7 / d });
    const once = combineOnce(prior, day(7));
    let chained = prior;
    for (let d = 1; d <= 7; d++) chained = combineOnce(chained, day(d));
    // Chaining re-counts the early games every day: its variance is far too small.
    expect(chained.v).toBeLessThan(once.v / 2);
    expect(once.v).toBeCloseTo(1 / (1 + 1), 6);
  });

  test("only a patch-to-date snapshot is accepted as evidence", () => {
    expect(() => combineOnce({ m: 0, v: 1 }, { kind: "daily-increment", snapshotDate: "x", l: 0, se2: 1 } as never)).toThrow();
  });
});

describe("reliable tiers on the thin, typical and rich simulations", () => {
  // Spec: misordered split pairs stay at or below 15%, 12% and 8%.
  for (const [label, games, limit] of [
    ["thin (5,000 games, 18 options)", 5_000, 0.15],
    ["typical (20,000 games, 18 options)", 20_000, 0.12],
    ["rich (80,000 games, 18 options)", 80_000, 0.08],
  ] as const) {
    test(`${label}: misordered split pairs ≤ ${limit * 100}%`, { timeout: 120_000 }, () => {
      let split = 0;
      let bad = 0;
      // 300 seeded sets: fewer leave the thin estimate within sampling noise of its limit.
      for (let s = 0; s < 300; s++) {
        const r = misorderedSplitPairs(simulateSet(20000 + s, { options: 18, games }));
        split += r.split;
        bad += r.misordered;
      }
      expect(split).toBeGreaterThan(0);
      expect(bad / split).toBeLessThanOrEqual(limit);
    });
  }

  // "Stronger" means more extreme: conservative letters move toward B, so a
  // letter may understate an option (C shown for −4 pp) but never overstate it.
  const extremity = (l: Letter) => RANK[l] - 2; // S +2 … B 0 … D −2
  const overstates = (shown: Letter, own: Letter) =>
    extremity(shown) !== 0 &&
    (Math.sign(extremity(shown)) !== Math.sign(extremity(own)) || Math.abs(extremity(shown)) > Math.abs(extremity(own)));

  test("no well-measured option is shown with a letter stronger than its own estimate (0%)", () => {
    let firm = 0;
    let over = 0;
    for (const games of [5_000, 20_000, 80_000]) {
      for (let s = 0; s < 60; s++) {
        const set = simulateSet(5000 + s + games, { options: 18, games });
        set.graded.forEach((g, i) => {
          const o = set.options[i];
          if (o.thin) return;
          firm++;
          if (overstates(g.letter, bandOf(o.m))) over++;
        });
      }
    }
    expect(firm).toBeGreaterThan(500);
    expect(over).toBe(0);
  });
});

describe("posterior calibration (the reason grading inflates variances by GRADE_INFLATE)", () => {
  test("with the multiplier, about 5% of true values fall outside ±1.96 posterior sd", () => {
    let out = 0;
    let n = 0;
    for (const games of [5_000, 20_000, 80_000]) {
      for (let s = 0; s < 60; s++) {
        for (const o of simulateSet(1000 + s, { options: 18, games }).options) {
          n++;
          if (Math.abs(o.theta - o.m) / Math.sqrt(o.v * GRADE_INFLATE) > 1.96) out++;
        }
      }
    }
    expect(out / n).toBeLessThan(0.06);
    expect(out / n).toBeGreaterThan(0.02); // and not so inflated that letters turn into mush
  });
});

describe("close calls and verdict calibration", () => {
  test("close call appears exactly when P(θ1 > θ2 + 0.5 pp) < 0.8", () => {
    const at = (gap: number) => verdict([{ id: "a", m: gap, v: 0.5 }, { id: "b", m: 0, v: 0.5 }]);
    // P = Φ((gap − 0.5)/1): 0.8 at gap = 0.5 + 0.8416
    expect(at(0.5 + 0.84).closeCall).toBe(true);
    expect(at(0.5 + 0.85).closeCall).toBe(false);
    for (const gap of [0, 0.3, 1, 1.5, 2, 3]) {
      const v = at(gap);
      expect(v.closeCall).toBe((v.certainty as number) < 0.8);
      expect(v.certainty).toBeCloseTo(Phi(gap - 0.5), 6);
    }
  });

  /**
   * The engine grades every champion from GLOBAL rows (the provider has no
   * champion-specific outcomes). A champion's true value is g + ι with
   * ι ~ N(0, τ²). Verdicts shown without a close call must hold (the named
   * card truly beats the runner-up) at least 80% of the time in every
   * certainty bin — on a normal day and on patch day.
   */
  for (const [label, games] of [["typical day", 2_000_000], ["patch day", 60_000]] as const) {
    test(`${label}: verdicts without a close call hold ≥ 80% in every certainty bin`, () => {
      const bins = new Map<number, { n: number; held: number }>();
      const rand = rng(77);
      const gauss = gaussian(rand);
      for (let s = 0; s < 40; s++) {
        const set = simulateSet(9000 + s, { options: 40, games });
        for (let champ = 0; champ < 25; champ++) {
          const truth = set.options.map((o) => o.theta + TAU_ASSUMED * gauss());
          for (let offer = 0; offer < 8; offer++) {
            const idx = new Set<number>();
            while (idx.size < 3) idx.add(Math.floor(rand() * set.options.length));
            const cards = [...idx].map((i) => ({ id: String(i), m: set.options[i].m, v: set.options[i].v + TAU_ASSUMED ** 2 }));
            const v = verdict(cards);
            if (v.closeCall || v.certainty === null) continue;
            const bin = Math.min(Math.floor(v.certainty * 20) / 20, 0.95);
            const b = bins.get(bin) ?? { n: 0, held: 0 };
            b.n++;
            if (truth[Number(v.pick)] > truth[Number(v.runnerUp)]) b.held++;
            bins.set(bin, b);
          }
        }
      }
      expect(bins.size).toBeGreaterThan(0);
      for (const [bin, b] of bins) {
        if (b.n < 30) continue;
        expect(b.held / b.n, `bin ${bin}: ${b.held}/${b.n}`).toBeGreaterThanOrEqual(0.8);
      }
    });
  }
});

describe("set debounce", () => {
  const g = (order: string[], letters: Record<string, Letter>) => ({ order, letters });
  const A = g(["x", "y", "z"], { x: "S", y: "A", z: "B" });
  const B = g(["y", "x", "z"], { x: "A", y: "S", z: "B" });

  test("a new grouping shows only when it repeats; a one-day blip never shows", () => {
    let st: DebounceState = { published: null, pending: null };
    st = debounce(st, A);
    expect(st.published).toEqual(A);
    st = debounce(st, B); // day 1 of B: held
    expect(st.published).toEqual(A);
    st = debounce(st, A); // blip over
    expect(st.published).toEqual(A);
    st = debounce(st, B);
    st = debounce(st, B); // lasting: shows on day 2
    expect(st.published).toEqual(B);
  });

  test("letters never appear out of order: the held grouping keeps its own order", () => {
    let st: DebounceState = { published: A, pending: null };
    st = debounce(st, B);
    const shown = st.published!;
    const ranks = shown.order.map((id) => RANK[shown.letters[id]]);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  test("groupingOf follows the graded order", () => {
    const graded = [
      { id: "b", letter: "A" as Letter, tier: 2, order: 1, outlined: false, planEligible: true },
      { id: "a", letter: "S" as Letter, tier: 1, order: 0, outlined: false, planEligible: true },
    ];
    expect(groupingOf(graded)).toEqual({ order: ["a", "b"], letters: { a: "S", b: "A" } });
  });
});

describe("patch deltas fire on under 1% of rows when true values are unchanged", () => {
  test("3-sigma rule on two patches of the same truth", () => {
    const rand = rng(11);
    const gauss = gaussian(rand);
    let fired = 0;
    const rows = 20_000;
    for (let i = 0; i < rows; i++) {
      const se2New = 0.05 + rand() * 2;
      const se2Old = 0.05 + rand() * 2;
      const truth = 3 * gauss();
      const d = patchDelta({
        lNew: truth + Math.sqrt(se2New) * gauss(),
        se2New,
        lOld: truth + Math.sqrt(se2Old) * gauss(),
        se2Old,
        patchNamed: true,
        groupingRepeated: true,
      });
      if (d !== null && d !== 0) fired++;
    }
    expect(fired / rows).toBeLessThan(0.01);
  });

  test("no delta without a named patch or a repeated grouping", () => {
    const base = { lNew: 10, se2New: 0.01, lOld: 0, se2Old: 0.01 };
    expect(patchDelta({ ...base, patchNamed: false, groupingRepeated: true })).toBeNull();
    expect(patchDelta({ ...base, patchNamed: true, groupingRepeated: false })).toBeNull();
    expect(patchDelta({ ...base, patchNamed: true, groupingRepeated: true })).toBe(10);
  });
});

describe("the synergy flag fires on under 1% of pairs when there is no real interaction", () => {
  test("pooled pairs with own rows and ι = 0", () => {
    const rand = rng(21);
    const gauss = gaussian(rand);
    let fired = 0;
    const pairs = 20_000;
    for (let i = 0; i < pairs; i++) {
      const prior = { m: 2 * gauss(), v: 1.44 + 0.05 };
      const se2 = 0.05 + rand() * 4;
      const own = { l: prior.m + Math.sqrt(se2) * gauss(), se2 }; // truth = prior mean: no interaction
      const post = pooledPairPosterior(prior, own);
      if (synergy(post.m - prior.m, post.ownWeight, true)) fired++;
    }
    expect(fired / pairs).toBeLessThan(0.01);
  });

  test("a pair without champion-specific data never qualifies", () => {
    expect(synergy(5, 1, false)).toBe(false);
  });
});

describe("gambles", () => {
  const sources = [{ id: "pandora", takeRate: 0.03, produces: 3.5, pool: Array.from({ length: 70 }, (_, i) => `p${i}`) }];

  test("expected granted and transmuted appearances are subtracted before any use of pick rates (game-end counting)", () => {
    const out = correctForRandomGrants({ p0: 0.01, other: 0.2 }, sources, "game-end");
    expect(out.applied).toBe(true);
    expect(out.rates.p0).toBeCloseTo(0.01 - 0.0015, 6); // 0.15% of games, as in the spec's illustration
    expect(out.rates.other).toBe(0.2);
  });

  test("with pick-time or unknown counting nothing is subtracted (the correction's sign is unknown)", () => {
    expect(correctForRandomGrants({ p0: 0.01 }, sources, "unknown")).toEqual({ rates: { p0: 0.01 }, applied: false });
    expect(correctForRandomGrants({ p0: 0.01 }, sources, "pick").applied).toBe(false);
  });

  test("Pandora's Box moves with holdings: an S held turns it down, only C and D held turn it up", () => {
    const vPB = -3;
    const meanPrismatic = 0.5;
    expect(pandorasBoxForHoldings(vPB, meanPrismatic, [5])).toBeLessThan(vPB); // an S augment (+5) held
    expect(pandorasBoxForHoldings(vPB, meanPrismatic, [-2, -4])).toBeGreaterThan(vPB); // C and D held
  });
});

describe("reroll hints and odds", () => {
  const cards = [
    { id: "best", m: 3, v: 0.2 },
    { id: "mid", m: 1, v: 0.2 },
    { id: "low", m: -2, v: 0.2 },
  ];

  test("reroll every card except the current best", () => {
    const pool = [{ id: "x", m: 0, v: 0.2 }, { id: "y", m: -1, v: 0.2 }];
    expect(rerollHints(cards, pool)).toEqual({ reroll: ["mid", "low"], keep: "best" });
  });

  test("reroll the best too only when E[max(m, X)] exceeds its value", () => {
    const strongPool = [{ id: "x", m: 8, v: 0.2 }, { id: "y", m: 6, v: 0.2 }];
    expect(rerollHints(cards, strongPool).reroll).toContain("best");
  });

  test("odds average Φ((m′ − m)/√(v′ + v)) over the pool, which excludes everything seen or held", () => {
    const pool = rerollPool({ eligible: ["a", "b", "c", "d"], excluded: new Set(["a", "d"]) });
    expect(pool).toEqual(["b", "c"]);
    const odds = rerollOdds({ id: "mid", m: 1, v: 0.5 }, [{ id: "b", m: 1, v: 0.5 }, { id: "c", m: 3, v: 0.5 }]);
    expect(odds).toBeCloseTo((0.5 + Phi(2)) / 2, 6);
    expect(rerollOdds({ id: "mid", m: 1, v: 0.5 }, [])).toBeNull();
  });

  test("pairwise uses covariance", () => {
    expect(pairwise(2, 1, 0, 1, 0.9)).toBeGreaterThan(pairwise(2, 1, 0, 1, 0));
  });
});
