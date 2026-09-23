/**
 * Simulated decision sets for the phase 1 statistical tests. Seeded; mirrors
 * the spec's grading simulations: options with true lifts, pick shares from a
 * popularity process that partly herds onto good options, binomial outcomes at
 * a stated game volume, and the engine's own lift → CLOSE → grade path.
 */
import { closeNpmle } from "./close-npmle";
import { grade, isThin, type Graded } from "./grade";
import { leaveOneOutLifts, posteriorCov } from "./lift";
import { gaussian, rng } from "./normal";

export interface SimOption {
  id: string;
  theta: number; // true lift, pp
  p: number; // pick share
  m: number;
  v: number;
  ownSe: number;
  thin: boolean;
}

export interface SimSet {
  options: SimOption[];
  graded: Graded[];
}

function binomial(n: number, p: number, rand: () => number, gauss: () => number): number {
  if (n < 50) {
    let k = 0;
    for (let i = 0; i < n; i++) if (rand() < p) k++;
    return k;
  }
  // normal approximation, clipped
  return Math.min(n, Math.max(0, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * gauss())));
}

/** One decision set: `options` choices, `games` games for the whole set. */
export function simulateSet(seed: number, opts: { options: number; games: number; herd?: number; spread?: number }): SimSet {
  const rand = rng(seed);
  const gauss = gaussian(rand);
  const spread = opts.spread ?? 2.0;
  const herd = opts.herd ?? 0.5;
  const mu = 0.53;
  const theta = Array.from({ length: opts.options }, () => {
    const out = rand() < 0.03 ? (rand() < 0.5 ? -6 : 6) : 0;
    return spread * gauss() + out;
  });
  const logit = theta.map((t) => 0.9 * gauss() + (herd * t) / 2);
  const ex = logit.map(Math.exp);
  const total = ex.reduce((a, b) => a + b, 0);
  const p = ex.map((x) => x / total);
  const n = p.map((pi) => Math.max(1, Math.round(pi * opts.games)));
  const w = theta.map((t, i) => binomial(n[i], Math.min(Math.max(mu + t / 100, 0.01), 0.99), rand, gauss) / n[i]);
  const lifts = leaveOneOutLifts(theta.map((_, i) => ({ id: `o${i}`, p: p[i], w: w[i], n: n[i] })));
  // Truth on the estimand's scale: lift vs the pick-weighted mean of the others.
  const truth = theta.map((t, i) => {
    const rest = p.reduce((a, pj, j) => (j === i ? a : a + pj), 0);
    return t - theta.reduce((a, tj, j) => (j === i ? a : a + p[j] * tj), 0) / rest;
  });
  const post = closeNpmle(lifts.lift.map((l, i) => ({ id: `o${i}`, l, se2: lifts.se2[i], p: p[i] })));
  const options = post.map((q, i) => ({
    id: q.id,
    theta: truth[i],
    p: p[i],
    m: q.m,
    v: q.v,
    ownSe: lifts.ownSe[i],
    thin: isThin(lifts.ownSe[i], q.v),
  }));
  return { options, graded: grade(options.map((o) => ({ id: o.id, m: o.m, v: o.v, thin: o.thin })), posteriorCov(lifts, post)) };
}

/** Share of pairs placed in different tiers whose true order is the reverse. */
export function misorderedSplitPairs(set: SimSet): { split: number; misordered: number } {
  let split = 0;
  let misordered = 0;
  const g = set.graded;
  for (let i = 0; i < g.length; i++) {
    for (let j = 0; j < g.length; j++) {
      if (g[i].tier < g[j].tier) {
        split++;
        if (set.options[i].theta < set.options[j].theta) misordered++;
      }
    }
  }
  return { split, misordered };
}
