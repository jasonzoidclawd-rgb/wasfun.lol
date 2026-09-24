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

  test("is null while the kill switch is off", () => {
    vi.stubEnv(AUGMENT_STATS_ENV, "off");
    resetScorePack();
    expect(loadScorePack()).toBeNull();
  });
});
