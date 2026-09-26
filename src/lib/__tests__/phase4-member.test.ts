/**
 * Phase 4, Member features: This game, reroll odds from the game's log,
 * Pandora's Box graded for your game, Following with patch alerts, saved games,
 * last patch's letters and rank ranges. Each is off unless its flag is on, shows
 * for members only, and never puts a prompt on the Pick screen.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, test, vi } from "vitest";
import messages from "../../../messages/en.json";

const plan = vi.hoisted(() => ({ current: "free" as "free" | "member" | "vip" | null }));
vi.mock("@/lib/plans/usePlan", () => ({ usePlan: (active = true) => (active ? plan.current : null) }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
  usePathname: () => "/champions/yasuo",
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/ja/champions/yasuo" }));

import { PickScreen } from "@/components/pick/PickScreen";
import { FollowButton, pickPageFor } from "@/components/member/FollowButton";
import { MemberOnly } from "@/components/member/MemberOnly";
import { followedChampions } from "@/lib/member/following";
import { planFromEntitlement } from "@/lib/plans/plan";
import { bandOf } from "@/lib/score/grade";
import { loadChampionHistory, loadScorePack } from "@/lib/score/pack";
import { buildPickPayload, type PickCard } from "@/lib/score/pick-payload";
import { initialPickState, pickReducer, readScreen, type PickState } from "@/lib/score/pick-state";
import { rankRanges } from "@/lib/score/rank-range";
import { GAME_IDLE_MS, heldIds, isLive, logScreen, newGame, nextLevel, PANDORAS_BOX, seenIds, undoLast, type ThisGame } from "@/lib/score/this-game";
import type { Rarity } from "@/lib/score/engine";

afterEach(() => {
  vi.unstubAllEnvs();
  plan.current = "free";
});

type Card = PickCard & { rarity: Rarity };
function card(id: string, rarity: Rarity, m: number, v = 0.25): Card {
  return { id, rarity, m, v, name: id, icon: null, letter: bandOf(m), outlined: false, order: 0, plan: true, winRate: 50, pick: null, gamble: id === PANDORAS_BOX };
}
function screen(ids: string[], rarity: Rarity = "gold"): PickState {
  return ids.reduce((s, id) => pickReducer(s, { type: "tapCard", id }), initialPickState(rarity));
}

describe("This game: the log", () => {
  test("logs four screens at levels 3, 7, 11 and 15, each with every card offered, rerolled ones included", () => {
    let g: ThisGame = newGame("yasuo");
    g = logScreen(g, { rarity: "silver", onScreen: ["a", "b", "c"], rerolledAway: ["z"], taken: "a" });
    expect(g.screens[0]).toEqual({ level: 3, rarity: "silver", taken: "a", offered: ["a", "b", "c", "z"] });
    for (const t of ["d", "g", "j"]) g = logScreen(g, { rarity: "gold", onScreen: [t, `${t}1`, `${t}2`], rerolledAway: [], taken: t });
    expect(g.screens.map((s) => s.level)).toEqual([3, 7, 11, 15]);
    expect(nextLevel(g)).toBeNull();
    // a fifth screen is refused
    expect(logScreen(g, { rarity: "gold", onScreen: ["x", "y", "w"], rerolledAway: [], taken: "x" })).toBe(g);
    expect(heldIds(g)).toEqual(["a", "d", "g", "j"]);
    expect(seenIds(g)).toContain("z");
    expect(undoLast(g).screens).toHaveLength(3);
  });

  test("only a live game's log applies: same champion and patch, a screen to come, not idle", () => {
    const t0 = 1_000_000;
    const g = logScreen(newGame("yasuo", "26.19", t0), { rarity: "gold", onScreen: ["a", "b", "c"], rerolledAway: [], taken: "a" }, t0);
    expect(isLive(g, "yasuo", "26.19", t0 + 5 * 60_000)).toBe(true);
    expect(isLive(g, "lux", "26.19", t0)).toBe(false);
    expect(isLive(g, "yasuo", "26.20", t0)).toBe(false);
    expect(isLive(g, "yasuo", "26.19", t0 + GAME_IDLE_MS)).toBe(false);
    // a game stored before this rule (no patch or time) is never applied
    expect(isLive({ champion: "yasuo", screens: [] }, "yasuo", "26.19", t0)).toBe(false);
    let done = g;
    for (const t of ["d", "e", "f"]) done = logScreen(done, { rarity: "gold", onScreen: [t, `${t}1`, `${t}2`], rerolledAway: [], taken: t }, t0);
    expect(isLive(done, "yasuo", "26.19", t0)).toBe(false);
  });

  test("refuses a card that is not on screen, or one already held", () => {
    const g = logScreen(newGame("yasuo"), { rarity: "gold", onScreen: ["a", "b", "c"], rerolledAway: [], taken: "a" });
    expect(logScreen(g, { rarity: "gold", onScreen: ["d", "e", "f"], rerolledAway: [], taken: "a" })).toBe(g);
    expect(logScreen(g, { rarity: "gold", onScreen: ["a", "e", "f"], rerolledAway: [], taken: "a" })).toBe(g);
  });
});

describe("This game changes the reroll pool (The math, section 7)", () => {
  test("cards offered on earlier screens or held never count as a possible reroll", () => {
    const cards = new Map<string, Card>(
      [card("a", "gold", 0), card("b", "gold", -1), card("c", "gold", -2), card("strong", "gold", 5), card("weak", "gold", -5)].map((c) => [c.id, c]),
    );
    const s = screen(["a", "b", "c"]);
    const free = readScreen(s, cards, 0)!;
    // the strong card was offered earlier this game: only the weak one is left to draw
    const logged = readScreen(s, cards, 0, { seen: ["strong"], held: [] })!;
    expect(free.odds.a).toBeCloseTo(0.5, 1);
    expect(logged.odds.a).toBeLessThan(0.01);
  });
});

describe("Pandora's Box graded for your game (The math, section 11)", () => {
  const prismatic = [card(PANDORAS_BOX, "prismatic", 0.5), card("p1", "prismatic", 1), card("p2", "prismatic", -1), card("p3", "prismatic", 0)];
  const held = [card("s-aug", "gold", 4), card("c-aug", "gold", -2), card("d-aug", "silver", -4)];
  const cards = new Map<string, Card>([...prismatic, ...held].map((c) => [c.id, c]));
  const s = screen([PANDORAS_BOX, "p1", "p2"], "prismatic");

  test("an S held turns it down; only C and D held turn it up; nothing held leaves its own row", () => {
    const own = readScreen(s, cards, 0)!;
    expect(own.pandorasBox).toBeNull();
    const withS = readScreen(s, cards, 0, { seen: [], held: ["s-aug"] })!.pandorasBox!;
    const withCD = readScreen(s, cards, 0, { seen: [], held: ["c-aug", "d-aug"] })!.pandorasBox!;
    expect(withS.m).toBeLessThan(0.5);
    expect(bandOf(withS.m)).toBe("D");
    expect(withCD.m).toBeGreaterThan(0.5);
    expect(bandOf(withCD.m)).toBe("S");
    // the held lifts are uncertain: their variance adds
    expect(withCD.v).toBeGreaterThan(cards.get(PANDORAS_BOX)!.v);
  });

  test("the verdict follows the game's value", () => {
    expect(readScreen(s, cards, 0, { seen: [], held: ["c-aug", "d-aug"] })!.verdict!.pick).toBe(PANDORAS_BOX);
    expect(readScreen(s, cards, 0, { seen: [], held: ["s-aug"] })!.verdict!.pick).not.toBe(PANDORAS_BOX);
  });
});

describe("rank ranges", () => {
  test("well-separated options get tight ranges; overlapping ones share a wide range; seeded, so stable", () => {
    const r = rankRanges([
      { id: "top", m: 10, v: 0.01 },
      { id: "x", m: 0, v: 4 },
      { id: "y", m: 0.1, v: 4 },
      { id: "bottom", m: -10, v: 0.01 },
    ]);
    expect(r.get("top")).toEqual({ low: 1, high: 1 });
    expect(r.get("bottom")).toEqual({ low: 4, high: 4 });
    expect(r.get("x")).toEqual({ low: 2, high: 3 });
    expect(rankRanges([{ id: "a", m: 0, v: 1 }, { id: "b", m: 0.2, v: 1 }])).toEqual(rankRanges([{ id: "a", m: 0, v: 1 }, { id: "b", m: 0.2, v: 1 }]));
  });

  test("draws are joint: negative covariance (shared baselines) widens the ranges, never narrows them", () => {
    const opts = [
      { id: "a", m: 1.0, v: 0.25 },
      { id: "b", m: 0.0, v: 0.25 },
      { id: "c", m: -1.0, v: 0.25 },
    ];
    const width = (r: Map<string, { low: number; high: number }>) => [...r.values()].reduce((t, x) => t + x.high - x.low, 0);
    const independent = rankRanges(opts);
    const joint = rankRanges(opts, { cov: (i, j) => (i === j ? 0 : -0.1) });
    expect(width(joint)).toBeGreaterThanOrEqual(width(independent));
    expect(width(joint)).toBeGreaterThan(0);
  });

  test("on real data every champion's range contains its graded position", () => {
    const history = loadChampionHistory()!;
    expect(history.size).toBeGreaterThan(150);
    for (const h of history.values()) {
      expect(h.rank).not.toBeNull();
      expect(h.rank!.low).toBeLessThanOrEqual(h.rank!.high);
    }
  });
});

describe("Following: a patch alert needs a letter change AND a move past the noise test", () => {
  const history = new Map([
    ["a", { previous: { patch: "26.18", letter: "B" as const, outlined: false }, rank: null }],
    ["b", { previous: { patch: "26.18", letter: "B" as const, outlined: false }, rank: null }],
  ]);
  const up = (slug: string) => ({ slug, delta: 1.2 });
  const champs = [
    { slug: "a", name: "A", grade: "S" as const, outlined: false },
    { slug: "b", name: "B", grade: "S" as const, outlined: false },
  ];

  test("a letter change alone does not alert", () => {
    const [a, b] = followedChampions(champs, history, [up("a")], false);
    expect(a.alert).toBe(true);
    expect(b.alert).toBe(false);
  });

  test("champion letters reach the Home payload as `grade`, never `letter` (the kill-switch crawl counts a `letter` prop as a leak)", () => {
    const payload = JSON.stringify(followedChampions(champs, history, [up("a")], false));
    expect(payload).not.toMatch(/"letter"\s*:/);
    expect(payload).toMatch(/"grade":"S"/);
  });

  test("the letter and the win rate must move the same way", () => {
    const [a] = followedChampions(champs, history, [{ slug: "a", delta: -1.2 }], false);
    expect(a.alert).toBe(false);
  });

  test("while this patch's rows predate the patch there is no last-patch letter and no alert", () => {
    for (const c of followedChampions(champs, history, [up("a"), up("b")], true)) {
      expect(c.previous).toBeNull();
      expect(c.alert).toBe(false);
    }
  });
});

describe("members only, flags off by default, no prompt on Pick", () => {
  const icons = { augment: () => null, champion: () => null, item: () => null };
  function pickHtml(): string {
    const pack = loadScorePack()!;
    const payload = buildPickPayload({ pack, slug: "yasuo", locale: "en", championRecord: { name: "Yasuo" }, icons, items: { name: (s: string) => s } })!;
    return renderToStaticMarkup(
      createElement(
        NextIntlClientProvider as unknown as (props: { locale: string; messages: unknown }) => null,
        { locale: "en", messages },
        createElement(PickScreen, { payload }),
      ),
    );
  }

  test("This game shows for members with the flag on, and for nobody else", () => {
    plan.current = "member";
    expect(pickHtml()).not.toContain("pick-this-game");
    vi.stubEnv("NEXT_PUBLIC_WASFUN_MEMBER_PICK", "on");
    expect(pickHtml()).toContain("pick-this-game");
    plan.current = "free";
    const free = pickHtml();
    expect(free).not.toContain("pick-this-game");
    // and the Pick screen asks nobody to upgrade
    expect(free).not.toMatch(/\/plans|\bMember\b|see plans/);
  }, 120_000);

  test("MemberOnly renders nothing for free visitors, or while the flag is off", () => {
    const child = createElement("span", null, "extra");
    plan.current = "member";
    expect(renderToStaticMarkup(createElement(MemberOnly, null, child))).toBe("");
    vi.stubEnv("NEXT_PUBLIC_WASFUN_MEMBER_EXTRAS", "on");
    expect(renderToStaticMarkup(createElement(MemberOnly, null, child))).toContain("extra");
    plan.current = "free";
    expect(renderToStaticMarkup(createElement(MemberOnly, null, child))).toBe("");
  });

  test("Follow: a toggle for members; for free visitors one quiet line, only while Plans is on", () => {
    const render = () =>
      renderToStaticMarkup(
        createElement(
          NextIntlClientProvider as unknown as (props: { locale: string; messages: unknown }) => null,
          { locale: "en", messages },
          createElement(FollowButton, { slug: "yasuo", champion: "Yasuo" }),
        ),
      );
    vi.stubEnv("NEXT_PUBLIC_WASFUN_MEMBER_EXTRAS", "on");
    plan.current = "member";
    expect(render()).toContain("Follow Yasuo");
    plan.current = "free";
    expect(render()).toBe("");
    vi.stubEnv("NEXT_PUBLIC_WASFUN_PLANS", "on");
    expect(render()).toContain('href="/plans"');
  });

  test("following a champion caches its Pick page, in any locale", () => {
    expect(pickPageFor("/ja/champions/yasuo")).toBe("/ja/pick/yasuo");
    expect(pickPageFor("/champions/lux/")).toBe("/pick/lux");
    expect(pickPageFor("/tier-list/gold")).toBeNull();
  });

  test("a cached \"free\" plan never lets an ad load before the server answers", async () => {
    const { trustedCachedPlan } = await vi.importActual<typeof import("@/lib/plans/usePlan")>("@/lib/plans/usePlan");
    expect(trustedCachedPlan("free")).toBeNull();
    expect(trustedCachedPlan(null)).toBeNull();
    expect(trustedCachedPlan("member")).toBe("member");
    expect(trustedCachedPlan("vip")).toBe("vip");
  });

  test("overlay testers are not members: a download permission is not a plan", () => {
    expect(planFromEntitlement("overlay_tester")).toBe("free");
  });
});
