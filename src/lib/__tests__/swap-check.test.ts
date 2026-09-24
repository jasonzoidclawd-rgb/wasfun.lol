/**
 * Phase 3 acceptance: the Swap check names a champion only when it clears the
 * 0.5 pp margin with 80% certainty, and calls it close otherwise. It needs the
 * champions' own win rates only, so it stays on with the augment switch off.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadChampionLetters } from "../score/pack";
import { swapAnswer } from "../score/swap";
import { verdict } from "../score/verdict";
import { AUGMENT_STATS_ENV } from "../stats/kill-switch";

afterEach(() => vi.unstubAllEnvs());

describe("Swap check over the current feeds", () => {
  test("names the best of a clear pair, calls a near-tie close", () => {
    const letters = loadChampionLetters();
    expect(letters).not.toBeNull();
    const ranked = [...letters!.entries()].sort((a, b) => a[1].order - b[1].order);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    const clear = verdict([
      { id: worst[0], m: worst[1].m, v: worst[1].v },
      { id: best[0], m: best[1].m, v: best[1].v },
    ]);
    expect(clear.pick).toBe(best[0]);
    expect(clear.closeCall).toBe(false);
    // the tightest adjacent pair in the graded order is too close to separate
    let tight = ranked[0];
    let next = ranked[1];
    for (let i = 1; i < ranked.length - 1; i++) {
      if (Math.abs(ranked[i][1].m - ranked[i + 1][1].m) < Math.abs(tight[1].m - next[1].m)) [tight, next] = [ranked[i], ranked[i + 1]];
    }
    const close = verdict([
      { id: tight[0], m: tight[1].m, v: tight[1].v },
      { id: next[0], m: next[1].m, v: next[1].v },
    ]);
    expect(close.closeCall).toBe(true);
    for (const l of letters!.values()) expect(["S", "A", "B", "C", "D"]).toContain(l.letter);
  });

  test("champion letters stay on with the augment switch off", () => {
    vi.stubEnv(AUGMENT_STATS_ENV, "off");
    expect(loadChampionLetters()?.size).toBeGreaterThan(150);
  });

  test("keep or swap is decided against your champion, not between two bench champions", () => {
    const mine = { slug: "mine", m: -2, v: 0.01 };
    // two bench champions both clearly beat yours and tie with each other: swap, not "close call"
    const r = swapAnswer(mine, [{ slug: "a", m: 3, v: 0.01 }, { slug: "b", m: 3.05, v: 0.01 }])!;
    expect(r.kind).toBe("swap");
    expect(swapAnswer({ slug: "mine", m: 3, v: 0.01 }, [{ slug: "a", m: -2, v: 0.01 }])!.kind).toBe("keep");
    expect(swapAnswer({ slug: "mine", m: 1, v: 4 }, [{ slug: "a", m: 1.2, v: 4 }])!.kind).toBe("close");
    expect(swapAnswer(mine, [])).toBeNull();
  });
});

