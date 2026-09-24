import { describe, expect, test } from "vitest";
import type { Rarity } from "../score/engine";
import type { PickCard } from "../score/pick-payload";
import { initialPickState, pickReducer, readScreen, type PickAction } from "../score/pick-state";

const card = (id: string, m: number, rarity: Rarity = "gold"): PickCard & { rarity: Rarity } => ({
  id,
  name: id,
  icon: null,
  letter: "B",
  outlined: false,
  order: 0,
  plan: true,
  m,
  v: 0.01,
  winRate: 55.1,
  pick: null,
  pickUnder: 5,
  gamble: false,
  rarity,
});
const cards = new Map(
  [card("a", 4), card("b", 1), card("c", -2), card("d", 0), card("e", 3), card("p", 6, "prismatic")].map((c) => [c.id, c]),
);
const run = (...actions: PickAction[]) => actions.reduce(pickReducer, initialPickState());

describe("three taps give a verdict", () => {
  test("no verdict before three cards, a named pick after the third tap", () => {
    const two = run({ type: "tapCard", id: "b" }, { type: "tapCard", id: "a" });
    expect(readScreen(two, cards, 1.2)).toBeNull();
    const three = pickReducer(two, { type: "tapCard", id: "c" });
    const reading = readScreen(three, cards, 1.2)!;
    expect(reading.verdict.pick).toBe("a");
    expect(reading.verdict.runnerUp).toBe("b");
  });

  test("a fourth tap is ignored; tapping an entered card takes it back (a correction, not a reroll)", () => {
    const full = run(...["a", "b", "c", "d"].map((id) => ({ type: "tapCard", id }) as PickAction));
    expect(full.slots.map((s) => s.id)).toEqual(["a", "b", "c"]);
    const corrected = pickReducer(full, { type: "tapCard", id: "b" });
    expect(corrected.slots.map((s) => s.id)).toEqual(["a", "c"]);
    expect(corrected.rerolledAway).toEqual([]);
  });
});

describe("rerolls", () => {
  test("tap ↻ on the old card, then the new card: it takes the slot with no reroll left", () => {
    let st = run(...["a", "b", "c"].map((id) => ({ type: "tapCard", id }) as PickAction));
    st = pickReducer(st, { type: "tapReroll", slot: 2 });
    expect(st.pendingReroll).toBe(2);
    st = pickReducer(st, { type: "tapCard", id: "e" });
    expect(st.slots[2]).toEqual({ id: "e", rerolled: true });
    expect(st.rerolledAway).toEqual(["c"]);
    // no reroll left on that slot
    expect(pickReducer(st, { type: "tapReroll", slot: 2 }).pendingReroll).toBeNull();
    const reading = readScreen(st, cards, 1.2)!;
    expect(reading.reroll.e).toBe(false);
    expect(reading.odds.e).toBeNull();
  });

  test("a card rerolled away cannot come back, and the reroll pool leaves out everything seen", () => {
    let st = run(...["a", "b", "c"].map((id) => ({ type: "tapCard", id }) as PickAction));
    st = pickReducer(st, { type: "tapReroll", slot: 1 });
    st = pickReducer(st, { type: "tapCard", id: "d" }); // b rerolled away
    st = pickReducer(st, { type: "tapReroll", slot: 0 });
    expect(pickReducer(st, { type: "tapCard", id: "b" }).slots.map((s) => s.id)).toEqual(["a", "d", "c"]);
  });

  test("rarities can mix after a Golden Reroll", () => {
    let st = run(...["a", "b", "c"].map((id) => ({ type: "tapCard", id }) as PickAction));
    st = pickReducer(st, { type: "tapReroll", slot: 2 });
    st = pickReducer(st, { type: "tapCard", id: "p" });
    expect(readScreen(st, cards, 1.2)!.verdict.pick).toBe("p");
  });

  test("hints: every card except the best is suggested for a reroll", () => {
    const st = run(...["a", "b", "c"].map((id) => ({ type: "tapCard", id }) as PickAction));
    const r = readScreen(st, cards, 1.2)!;
    expect(r.reroll).toEqual({ a: false, b: true, c: true });
    expect(r.odds.c).toBeGreaterThan(r.odds.a as number);
  });
});
