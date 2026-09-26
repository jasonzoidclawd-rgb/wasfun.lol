/**
 * Rank ranges (members, off the clock): "usually #2–#4". Draws each option's
 * true value from its posterior, ranks every draw, and reports the 10th to 90th
 * percentile of each option's rank.
 *
 * Draws are independent. The options in a set share a baseline, which makes
 * their errors positively correlated; leaving that out overstates the noise in
 * their differences, so the ranges come out wider, never narrower. Variances
 * carry the same inflation the grades use. A range is a weaker claim than a
 * letter, so it can only keep or weaken what the letter says.
 */
import { GRADE_INFLATE } from "./grade";
import { gaussian, rng } from "./normal";

export interface RankRange {
  /** 1-based ranks */
  low: number;
  high: number;
}

export const RANK_DRAWS = 2000;
const LOW_Q = 0.1;
const HIGH_Q = 0.9;

export function rankRanges(
  options: { id: string; m: number; v: number }[],
  opts: { draws?: number; seed?: number; inflate?: number } = {},
): Map<string, RankRange> {
  const draws = opts.draws ?? RANK_DRAWS;
  const inflate = opts.inflate ?? GRADE_INFLATE;
  const normal = gaussian(rng(opts.seed ?? 1));
  const n = options.length;
  const ranks: Int32Array[] = options.map(() => new Int32Array(draws));
  const values = new Float64Array(n);
  const order = options.map((_, i) => i);
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < n; i++) values[i] = options[i].m + Math.sqrt(options[i].v * inflate) * normal();
    order.sort((a, b) => values[b] - values[a]);
    for (let r = 0; r < n; r++) ranks[order[r]][d] = r + 1;
  }
  const out = new Map<string, RankRange>();
  options.forEach((o, i) => {
    const sorted = Array.from(ranks[i]).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(draws - 1, Math.floor(q * draws))];
    out.set(o.id, { low: at(LOW_Q), high: at(HIGH_Q) });
  });
  return out;
}
