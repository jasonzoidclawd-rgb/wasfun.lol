/**
 * Rank ranges (members, off the clock): "usually #2–#4". Draws the set's true
 * values jointly from the posterior, ranks every draw, and reports the 10th to
 * 90th percentile of each option's rank.
 *
 * The draws use the same covariance and variance inflation as the grades.
 * Leave-one-out lifts share baselines, which makes their errors move against
 * each other (negative covariance, lift.ts): drawing them independently would
 * understate the noise in their differences and give ranges that are too
 * narrow, a stronger claim than the data holds.
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

/** Lower-triangular Cholesky factor of a symmetric matrix, with diagonal jitter until it is positive definite. */
export function cholesky(a: Float64Array[], n: number): Float64Array[] {
  for (let jitter = 0; ; jitter = jitter === 0 ? 1e-9 : jitter * 10) {
    const l = Array.from({ length: n }, () => new Float64Array(n));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = a[i][j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
        if (i === j) {
          if (s <= 0) {
            ok = false;
            break;
          }
          l[i][i] = Math.sqrt(s);
        } else l[i][j] = s / l[j][j];
      }
    }
    if (ok) return l;
    if (jitter > 1) throw new Error("covariance is not positive definite");
  }
}

export function rankRanges(
  options: { id: string; m: number; v: number }[],
  opts: { draws?: number; seed?: number; inflate?: number; cov?: (i: number, j: number) => number } = {},
): Map<string, RankRange> {
  const draws = opts.draws ?? RANK_DRAWS;
  const inflate = opts.inflate ?? GRADE_INFLATE;
  const cov = opts.cov ?? (() => 0);
  const normal = gaussian(rng(opts.seed ?? 1));
  const n = options.length;
  const sigma = options.map((o, i) => {
    const row = new Float64Array(n);
    for (let j = 0; j < n; j++) row[j] = inflate * (i === j ? o.v : cov(i, j));
    return row;
  });
  const l = cholesky(sigma, n);
  const ranks: Int32Array[] = options.map(() => new Int32Array(draws));
  const z = new Float64Array(n);
  const values = new Float64Array(n);
  const order = options.map((_, i) => i);
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < n; i++) z[i] = normal();
    for (let i = 0; i < n; i++) {
      let x = options[i].m;
      for (let k = 0; k <= i; k++) x += l[i][k] * z[k];
      values[i] = x;
    }
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
