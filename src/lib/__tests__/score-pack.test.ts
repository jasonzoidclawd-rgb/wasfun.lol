import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadScorePack, resetScorePack } from "../score/pack";
import { offerPool } from "../score/offer-pool";
import type { PoolAugmentInput } from "@/lib/scoring/pool-orchestrator";
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

  test("full pool: every graded augment of a rarity is on every champion's grid, unless the game can't offer it to that champion", () => {
    const pack = loadScorePack()!;
    const read = (f: string) => JSON.parse(readFileSync(path.join(process.cwd(), "data/internal", f), "utf-8"));
    const catalog = read("augments.json").augments as (PoolAugmentInput & { augmentId?: string })[];
    const abilities = read("abilities.json").profiles;
    const champs = new Map((read("champions.json").champions as { slug: string; baseStats?: never }[]).map((c) => [c.slug, c]));
    const poolRules = read("pool-rules.json");
    const slugOf = new Map(catalog.filter((a) => a.augmentId).map((a) => [a.augmentId as string, a.slug]));
    const listed = read("champion-build-feed.json").champions;
    const liveIds = new Set((read("augment-stats-feed.json").rows as { augmentId?: string; availability?: string }[]).filter((r) => r.availability === "live").map((r) => r.augmentId));
    const observedLive = new Set(catalog.filter((a) => liveIds.has(a.augmentId)).map((a) => a.slug));
    const reasons: Record<string, number> = {};
    let missingTotal = 0;
    for (const champ of pack.champions) {
      const { excluded } = offerPool({ championSlug: champ.id, augments: catalog, abilityProfile: abilities[champ.id], baseStats: champs.get(champ.id)?.baseStats, poolRules, observedLive });
      const rule = new Map(excluded.map((e) => [e.slug, e.reason]));
      const listedIds = new Set((listed[champ.id].augments as { augmentId?: string }[]).map((a) => a.augmentId));
      const p = pack.pack(champ.id)!;
      for (const r of ["prismatic", "gold", "silver"] as const) {
        const onGrid = new Set(p.sets[r].map((o) => o.id));
        for (const o of pack.tierLists[r]) {
          if (onGrid.has(o.id)) continue;
          missingTotal++;
          // only a game offer rule may keep a graded augment off a grid, and never one the champion was seen taking
          const why = rule.get(slugOf.get(o.id) ?? "");
          expect(why, `${champ.id}: ${o.id} missing without an offer rule`).toBeDefined();
          expect(listedIds.has(o.id), `${champ.id}: ${o.id} is listed for it`).toBe(false);
          reasons[why!] = (reasons[why!] ?? 0) + 1;
        }
      }
    }
    // record the exclusions so a change in the rules shows up in review
    console.info("offer-rule exclusions (champion × augment):", missingTotal, reasons);
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
