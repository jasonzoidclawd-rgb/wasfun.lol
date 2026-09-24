import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadScorePack, resetScorePack } from "../score/pack";
import { AUGMENT_STATS_ENV } from "../stats/kill-switch";

afterEach(() => {
  vi.unstubAllEnvs();
  resetScorePack();
});

describe("score pack over the current feeds", () => {
  test("builds for every champion with a letter on every card of its pool", () => {
    const t0 = Date.now();
    const pack = loadScorePack();
    expect(pack).not.toBeNull();
    // a lower bound on the provider's volume, never a guessed count
    expect(pack!.meta.volume).toBeGreaterThan(1e4);
    expect(pack!.meta.carryOver).toBe(false);
    let cards = 0;
    for (const champ of pack!.champions) {
      const p = pack!.pack(champ.id);
      expect(p, champ.id).not.toBeNull();
      for (const set of Object.values(p!.sets)) {
        for (const card of set) {
          cards++;
          expect(["S", "A", "B", "C", "D"]).toContain(card.letter);
        }
      }
    }
    expect(cards).toBeGreaterThan(173 * 60);
    // one build computes every champion: keep it cheap enough for static generation
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  test("every augment the provider lists for a champion is on that champion's grid", () => {
    const pack = loadScorePack()!;
    const feed = JSON.parse(readFileSync(path.join(process.cwd(), "data/internal/champion-build-feed.json"), "utf-8"));
    const graded = new Set(Object.values(pack.tierLists).flatMap((set) => set.map((o) => o.id)));
    let checked = 0;
    for (const champ of pack.champions) {
      const p = pack.pack(champ.id)!;
      const onGrid = new Set(Object.values(p.sets).flatMap((set) => set.map((o) => o.id)));
      for (const a of feed.champions[champ.id].augments) {
        if (!a.augmentId || !graded.has(a.augmentId)) continue; // unresolved or not live: no letter anywhere
        checked++;
        expect(onGrid.has(a.augmentId), `${champ.id}: ${a.augmentId}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(2500);
  }, 120_000);

  test("a card's letter is the tier list's letter: graded across all champions, not within the pool", () => {
    const pack = loadScorePack()!;
    const tier = new Map(Object.values(pack.tierLists).flatMap((set) => set.map((o) => [o.id, o.letter] as const)));
    for (const slug of ["yasuo", "aatrox", "lux"]) {
      for (const set of Object.values(pack.pack(slug)!.sets)) for (const c of set) expect(c.letter, `${slug} ${c.id}`).toBe(tier.get(c.id));
    }
  }, 120_000);

  test("is null while the kill switch is off", () => {
    vi.stubEnv(AUGMENT_STATS_ENV, "off");
    resetScorePack();
    expect(loadScorePack()).toBeNull();
  });
});
