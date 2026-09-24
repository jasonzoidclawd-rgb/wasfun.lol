/**
 * Leave-one-out lifts with baseline-rate noise (The math, section 1).
 *
 *   ℓ_i = w_i − Σ_{j≠i} p_j w_j / Σ_{j≠i} p_j
 *   se²(ℓ_i) = μ(1−μ)/n_i + Σ_{j≠i} p_j² μ(1−μ)/n_j / (Σ_{j≠i} p_j)²
 *
 * Noise uses the SET's baseline rate μ (pick-weighted mean), never the
 * option's own observed rate: with w(1−w)/n a 3–0 row looks certain.
 * Lifts and variances are in percentage points.
 */

export interface LiftInput {
  id: string;
  /** pick weight within the set (any positive scale) */
  p: number;
  /** win rate, fraction */
  w: number;
  /** games behind the win rate */
  n: number;
}

export interface LiftSet {
  ids: string[];
  /** set baseline μ, fraction */
  mu: number;
  /** lift, pp */
  lift: number[];
  /** the option's own noise sd, pp: sqrt(μ(1−μ)/n) */
  ownSe: number[];
  /** full lift variance including the baseline's noise, pp² */
  se2: number[];
  /** covariance of lifts i and k, pp² */
  cov: (i: number, k: number) => number;
}

export function leaveOneOutLifts(rows: LiftInput[]): LiftSet {
  const P = rows.reduce((t, r) => t + r.p, 0);
  const mu = rows.reduce((t, r) => t + r.p * r.w, 0) / P;
  const varOf = rows.map((r) => ((mu * (1 - mu)) / Math.max(r.n, 1)) * 1e4);
  // ℓ_i = Σ_j C_ij w_j with C_ii = 1, C_ij = −p_j / (P − p_i)
  const coef = (i: number, j: number) => (i === j ? 1 : -rows[j].p / (P - rows[i].p));
  const lift = rows.map((r, i) => {
    const rest = P - r.p;
    const base = rows.reduce((t, q, j) => (j === i ? t : t + q.p * q.w), 0) / rest;
    return (r.w - base) * 100;
  });
  const se2 = rows.map((_, i) => rows.reduce((t, _q, j) => t + coef(i, j) ** 2 * varOf[j], 0));
  const cov = (i: number, k: number) =>
    i === k ? se2[i] : rows.reduce((t, _q, j) => t + coef(i, j) * coef(k, j) * varOf[j], 0);
  return { ids: rows.map((r) => r.id), mu, lift, ownSe: varOf.map(Math.sqrt), se2, cov };
}

/**
 * Covariance of two posterior means, from the lift covariance scaled by how
 * much of each posterior comes from its own data (section 1: the grades'
 * pairwise tests use it). Shared baselines make popular options' errors move
 * against each other, so ignoring this understates the variance of a difference.
 */
export function posteriorCov(lifts: LiftSet, post: { ownWeight: number }[]): (i: number, j: number) => number {
  return (i: number, j: number) => post[i].ownWeight * post[j].ownWeight * lifts.cov(i, j);
}
