/**
 * The Pick verdict, close calls, reroll hints and reroll odds (The math, section 7).
 */
import { MARGIN, pairwise } from "./grade";
import { Phi } from "./normal";

export const CLOSE_CALL_BELOW = 0.8;

export interface Posterior {
  id: string;
  m: number;
  v: number;
  /** no row of its own: the verdict line says so */
  estimated?: boolean;
}

export interface Verdict {
  pick: string;
  estimated: boolean;
  /** true when P(θ1 > θ2 + 0.5 pp) < 0.8 for the top two */
  closeCall: boolean;
  /** the runner-up, when there is one */
  runnerUp: string | null;
  /** P(θ1 > θ2 + margin) actually computed (after variance inflation) */
  certainty: number | null;
}

/**
 * `inflate` multiplies every variance before the close-call test. Simulated
 * posteriors run overconfident, so variances stay inflated until the
 * calibration test passes; the default is the value that test settled on.
 */
export function verdict(cards: Posterior[], cov: (a: string, b: string) => number = () => 0, inflate = 1): Verdict {
  if (cards.length === 0) throw new Error("verdict needs at least one card");
  const ranked = [...cards].sort((a, b) => b.m - a.m);
  const [top, second] = ranked;
  if (!second) return { pick: top.id, estimated: !!top.estimated, closeCall: false, runnerUp: null, certainty: null };
  const p = pairwise(top.m, top.v * inflate, second.m, second.v * inflate, cov(top.id, second.id) * inflate, MARGIN);
  return { pick: top.id, estimated: !!top.estimated, closeCall: p < CLOSE_CALL_BELOW, runnerUp: second.id, certainty: p };
}

/**
 * Reroll hints: reroll every card except the current best. Reroll the best too
 * only if E[max(m, X)] exceeds its value, where m is the best of the other
 * cards and X a random card from the eligible pool (offers assumed even).
 */
export function rerollHints(cards: Posterior[], pool: Posterior[]): { reroll: string[]; keep: string } {
  const ranked = [...cards].sort((a, b) => b.m - a.m);
  const best = ranked[0];
  const reroll = ranked.slice(1).map((c) => c.id);
  if (pool.length > 0 && ranked.length > 1) {
    const m = ranked[1].m;
    const eMax = pool.reduce((t, x) => t + Math.max(m, x.m), 0) / pool.length;
    if (eMax > best.m) reroll.unshift(best.id);
  }
  return { reroll, keep: best.id };
}

/**
 * Reroll odds (members): the chance a reroll of `card` gives a stronger augment,
 * averaged over the eligible pool: mean of Φ((m′ − m)/√(v′ + v)).
 */
export function rerollOdds(card: Posterior, pool: Posterior[]): number | null {
  if (pool.length === 0) return null;
  return pool.reduce((t, x) => t + Phi((x.m - card.m) / Math.sqrt(Math.max(1e-9, x.v + card.v))), 0) / pool.length;
}

export interface PoolRules {
  /** every augment of this tier the champion can be offered */
  eligible: string[];
  /** on screen now, rerolled away, offered on an earlier screen, or held */
  excluded: Iterable<string>;
}

/** The reroll pool the game would draw from: eligible minus everything already seen or held. */
export function rerollPool(rules: PoolRules): string[] {
  const out = new Set(rules.excluded);
  return rules.eligible.filter((id) => !out.has(id));
}
