/**
 * The Pick screen's state machine (The math, section 7: "Only the cards on
 * screen count"). Pure, so the screen's behaviour is testable without a DOM.
 *
 * - A screen holds three cards. Tap a card on the grid to enter it; tap an
 *   entered card again to take it back (a correction, never a reroll).
 * - After a reroll the player taps ↻ on the old card, then the new card, which
 *   takes the old card's slot with no reroll left.
 * - Cards of different rarities can share a screen (after a Golden Reroll).
 */
import type { Rarity } from "./engine";
import { rerollHints, rerollOdds, rerollPool, verdict, type Posterior, type Verdict } from "./verdict";
import type { PickCard } from "./pick-payload";

export const SCREEN_SIZE = 3;

export interface Slot {
  id: string;
  /** this card arrived by a reroll: its slot has no reroll left */
  rerolled: boolean;
}

export interface PickState {
  rarity: Rarity;
  slots: Slot[];
  /** index of the slot whose ↻ was tapped, waiting for the new card */
  pendingReroll: number | null;
  /** cards rerolled away this screen: never offered again */
  rerolledAway: string[];
}

export type PickAction =
  | { type: "tab"; rarity: Rarity }
  | { type: "tapCard"; id: string }
  | { type: "tapReroll"; slot: number }
  | { type: "clear" };

export function initialPickState(rarity: Rarity = "gold"): PickState {
  return { rarity, slots: [], pendingReroll: null, rerolledAway: [] };
}

export function pickReducer(state: PickState, action: PickAction): PickState {
  switch (action.type) {
    case "tab":
      return { ...state, rarity: action.rarity };
    case "clear":
      return initialPickState(state.rarity);
    case "tapReroll": {
      const slot = state.slots[action.slot];
      if (!slot || slot.rerolled) return state;
      // Tapping ↻ again cancels the pending reroll.
      return { ...state, pendingReroll: state.pendingReroll === action.slot ? null : action.slot };
    }
    case "tapCard": {
      const at = state.slots.findIndex((s) => s.id === action.id);
      if (state.pendingReroll !== null) {
        if (at >= 0 || state.rerolledAway.includes(action.id)) return state; // already on screen or gone
        const old = state.slots[state.pendingReroll];
        const slots = state.slots.map((s, i) => (i === state.pendingReroll ? { id: action.id, rerolled: true } : s));
        return { ...state, slots, pendingReroll: null, rerolledAway: [...state.rerolledAway, old.id] };
      }
      if (at >= 0) return { ...state, slots: state.slots.filter((_, i) => i !== at) };
      if (state.slots.length >= SCREEN_SIZE) return state;
      return { ...state, slots: [...state.slots, { id: action.id, rerolled: false }] };
    }
  }
}

export interface ScreenReading {
  verdict: Verdict;
  /** per slot: suggest a reroll? (only for slots that still have one) */
  reroll: Record<string, boolean>;
  /** per slot, members: the chance a reroll beats this card */
  odds: Record<string, number | null>;
}

/**
 * Read a full screen. Each card's variance includes the champion-specific
 * spread τ² (the provider publishes no champion-specific outcomes).
 */
export function readScreen(state: PickState, cards: Map<string, PickCard & { rarity: Rarity }>, tau: number): ScreenReading | null {
  if (state.slots.length < SCREEN_SIZE) return null;
  const post = (c: PickCard): Posterior => ({ id: c.id, m: c.m, v: c.v + tau * tau });
  const onScreen = state.slots.map((s) => cards.get(s.id)).filter((c): c is PickCard & { rarity: Rarity } => !!c);
  const v = verdict(onScreen.map(post));
  const reroll: Record<string, boolean> = {};
  const odds: Record<string, number | null> = {};
  const excluded = new Set([...state.slots.map((s) => s.id), ...state.rerolledAway]);
  for (const slot of state.slots) {
    const card = cards.get(slot.id);
    if (!card || slot.rerolled) {
      reroll[slot.id] = false;
      odds[slot.id] = null;
      continue;
    }
    const poolIds = rerollPool({
      eligible: [...cards.values()].filter((c) => c.rarity === card.rarity).map((c) => c.id),
      excluded,
    });
    const pool = poolIds.map((id) => post(cards.get(id)!));
    const hints = rerollHints(onScreen.map(post), pool);
    reroll[slot.id] = hints.reroll.includes(slot.id);
    odds[slot.id] = rerollOdds(post(card), pool);
  }
  return { verdict: v, reroll, odds };
}
