/**
 * This game (members, The math, sections 7 and 11): a log of one game's augment
 * screens. Each logged screen keeps the card taken, every card offered on it
 * (rerolled ones included) and its level. Pure, so it is testable without a DOM;
 * the Pick screen stores it in the browser only.
 *
 * What the log changes:
 * - The reroll pool drops every card offered on an earlier screen, and every
 *   card held (an augment offered once is never offered again that game).
 * - Pandora's Box is graded for the game: each held augment's lift is swapped
 *   for an average random Prismatic's (gambles.ts). The rarity premium is zero
 *   until first-party data can estimate it.
 */
import type { Rarity } from "./engine";
import { pandorasBoxForHoldings } from "./gambles";
import type { Posterior } from "./verdict";

/** Augment offers come at these levels, one screen each. */
export const OFFER_LEVELS = [3, 7, 11, 15] as const;
export type OfferLevel = (typeof OFFER_LEVELS)[number];

export const PANDORAS_BOX = "ARAM_PandorasBox";

export interface LoggedScreen {
  level: OfferLevel;
  rarity: Rarity;
  /** the card taken */
  taken: string;
  /** every card that was on this screen, including the ones rerolled away */
  offered: string[];
}

export interface ThisGame {
  champion: string;
  screens: LoggedScreen[];
}

export function newGame(champion: string): ThisGame {
  return { champion, screens: [] };
}

/** The level the next screen is at, or null once all four are logged. */
export function nextLevel(game: ThisGame): OfferLevel | null {
  return OFFER_LEVELS[game.screens.length] ?? null;
}

/**
 * Log a full screen with the card taken. Returns the game unchanged when the
 * game is complete, the taken card isn't on screen, or it was logged before.
 */
export function logScreen(
  game: ThisGame,
  screen: { rarity: Rarity; onScreen: string[]; rerolledAway: string[]; taken: string },
): ThisGame {
  const level = nextLevel(game);
  if (level === null || !screen.onScreen.includes(screen.taken)) return game;
  if (heldIds(game).includes(screen.taken)) return game;
  const offered = [...new Set([...screen.onScreen, ...screen.rerolledAway])];
  return { ...game, screens: [...game.screens, { level, rarity: screen.rarity, taken: screen.taken, offered }] };
}

/** Remove the last logged screen (a mis-tap). */
export function undoLast(game: ThisGame): ThisGame {
  return { ...game, screens: game.screens.slice(0, -1) };
}

export function heldIds(game: ThisGame): string[] {
  return game.screens.map((s) => s.taken);
}

/** Every card offered on a logged screen or held: never offered again this game. */
export function seenIds(game: ThisGame): string[] {
  return [...new Set(game.screens.flatMap((s) => s.offered))];
}

/**
 * Pandora's Box's posterior for this game. Every held augment turns into a
 * random Prismatic from the champion's pool, so its mean moves by
 * Σ (θ̄_Prismatic − θ_h). The held lifts are uncertain, so their variances add;
 * the pool mean's own noise is small beside them and is left out.
 * Returns null when nothing is held (the card's own row applies).
 */
export function pandorasBoxForGame(box: Posterior, held: Posterior[], prismaticPool: Posterior[]): Posterior | null {
  if (held.length === 0 || prismaticPool.length === 0) return null;
  const mean = prismaticPool.reduce((t, p) => t + p.m, 0) / prismaticPool.length;
  return {
    id: box.id,
    m: pandorasBoxForHoldings(box.m, mean, held.map((h) => h.m)),
    v: box.v + held.reduce((t, h) => t + h.v, 0),
  };
}
