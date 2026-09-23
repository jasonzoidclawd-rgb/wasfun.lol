/**
 * CLOSE-NPMLE prior and posterior (The math, section 5).
 *
 * Chen's CLOSE: when precision predicts the parameter (popular options are
 * better AND better measured), standard shrinkage toward one mean can select
 * worse than no shrinkage. So the prior's location and scale are smooth
 * functions of log pick rate, and its shape is the nonparametric maximum-
 * likelihood prior (Kiefer–Wolfowitz, as Gu & Koenker use it), fitted by EM on
 * a grid, so a genuinely broken option stays visible.
 *
 *   ℓ_i = θ_i + ε_i,  ε_i ~ N(0, se²_i)
 *   θ_i = m(x_i) + s(x_i)·η_i,  x_i = log p_i,  η ~ G (NPMLE)
 *
 * Guards (from the v2 review):
 * - fitted noise only: se² comes from the fitted noise scale, never inflated
 *   "to be safe" (inflation collapses the fitted spread);
 * - spread floor: s(x) never falls below the median s among the most-picked half;
 * - variance floor: the NPMLE prior is discrete, so a posterior can collapse
 *   onto one grid atom with near-zero variance, and with few noisy options the
 *   fitted scale can sit at its lower bound (the overconfidence the spec's
 *   calibration test catches). Each posterior variance is floored at Morris's
 *   empirical-Bayes variance for a normal prior with the fitted location and
 *   scale, which adds the uncertainty of the fitted location and a term that
 *   grows with the option's distance from it:
 *     se²(1 − B) + B²·Var(m̂_i) + 2/(k − 4)·B²·(ℓ_i − m̂_i)²,   B = se²/(se² + s²).
 *   The NPMLE keeps the mean, so a broken option still stands out.
 */
import { median } from "./normal";

export interface CloseInput {
  id: string;
  /** observed lift, pp */
  l: number;
  /** its noise variance, pp² (fitted noise) */
  se2: number;
  /** pick weight, > 0 */
  p: number;
}

export interface ClosePosterior {
  id: string;
  /** posterior mean, pp */
  m: number;
  /** posterior variance, pp² */
  v: number;
  /** prior location and scale at this option's pick rate */
  priorM: number;
  priorS: number;
  /** share of the posterior mean's pull that comes from the option's own data */
  ownWeight: number;
}

const GRID = 241;
const EM_STEPS = 400;

function linfit(x: number[], y: number[], w?: number[]): { a: number; b: number } {
  const ww = w ?? x.map(() => 1);
  const sw = ww.reduce((t, v) => t + v, 0);
  const mx = x.reduce((t, v, i) => t + ww[i] * v, 0) / sw;
  const my = y.reduce((t, v, i) => t + ww[i] * v, 0) / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i++) {
    sxx += ww[i] * (x[i] - mx) ** 2;
    sxy += ww[i] * (x[i] - mx) * (y[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

export function closeNpmle(rows: CloseInput[]): ClosePosterior[] {
  const n = rows.length;
  if (n === 0) return [];
  const x = rows.map((r) => Math.log(Math.max(r.p, 1e-9)));
  const xMean = x.reduce((t, v) => t + v, 0) / n;
  const l = rows.map((r) => r.l);

  // Location m(x) = a + b·x and scale s(x) = exp(c0 + c1·x), fitted jointly by
  // marginal likelihood: ℓ_i ~ N(m(x_i), s(x_i)² + se²_i). Alternating: WLS for
  // the location given the scale, then a grid search for the scale.
  let m = x.map(() => 0);
  let s = x.map(() => 1);
  let c0 = 0;
  let c1 = 0;
  for (let iter = 0; iter < 6; iter++) {
    const loc = linfit(x, l, rows.map((r, i) => 1 / (s[i] * s[i] + r.se2)));
    m = x.map((xi) => loc.a + loc.b * xi);
    let best = -Infinity;
    for (let a = Math.log(0.1); a <= Math.log(12); a += 0.05) {
      for (let b = -0.6; b <= 0.6001; b += 0.05) {
        let ll = 0;
        for (let i = 0; i < n; i++) {
          const v = Math.exp(2 * (a + b * (x[i] - xMean))) + rows[i].se2;
          ll -= 0.5 * (Math.log(v) + (l[i] - m[i]) ** 2 / v);
        }
        if (ll > best) {
          best = ll;
          c0 = a;
          c1 = b;
        }
      }
    }
    s = x.map((xi) => Math.exp(c0 + c1 * (xi - xMean)));
  }
  // Spread floor: never below the median scale among the most-picked half.
  const pMed = median(rows.map((r) => r.p));
  const floor = median(s.filter((_, i) => rows[i].p >= pMed));
  s = s.map((si) => Math.max(si, floor));
  const priorM = m;
  // Covariance of the fitted location (a, b) for the Morris term.
  const wLoc = rows.map((r, i) => 1 / (s[i] * s[i] + r.se2));
  let S0 = 0, S1 = 0, S2 = 0;
  for (let i = 0; i < n; i++) {
    S0 += wLoc[i];
    S1 += wLoc[i] * x[i];
    S2 += wLoc[i] * x[i] * x[i];
  }
  const det = S0 * S2 - S1 * S1;
  const varLoc = (xi: number) => (det > 1e-12 ? (S2 - 2 * S1 * xi + S0 * xi * xi) / det : 1 / Math.max(S0, 1e-12));
  const morrisK = 2 / Math.max(n - 4, 1);

  // Standardized problem: z_i = (ℓ_i − m_i)/s_i with noise sd ν_i = se_i/s_i.
  const z = l.map((li, i) => (li - m[i]) / s[i]);
  const nu = rows.map((r, i) => Math.sqrt(r.se2) / s[i]);
  const lo = Math.min(...z.map((zi, i) => zi - 3 * nu[i]), -4);
  const hi = Math.max(...z.map((zi, i) => zi + 3 * nu[i]), 4);
  const grid = Array.from({ length: GRID }, (_, k) => lo + ((hi - lo) * k) / (GRID - 1));
  let w: number[] = grid.map(() => 1 / GRID);
  // Likelihood matrix (unnormalised Gaussian densities).
  const L = z.map((zi, i) => grid.map((u) => Math.exp(-0.5 * ((zi - u) / nu[i]) ** 2) / nu[i]));
  for (let step = 0; step < EM_STEPS; step++) {
    const next = new Array(GRID).fill(0);
    for (let i = 0; i < n; i++) {
      let den = 0;
      for (let k = 0; k < GRID; k++) den += w[k] * L[i][k];
      if (den <= 0) continue;
      for (let k = 0; k < GRID; k++) next[k] += (w[k] * L[i][k]) / den;
    }
    w = next.map((v) => v / n);
  }

  return rows.map((r, i) => {
    let den = 0;
    let m1 = 0;
    let m2 = 0;
    for (let k = 0; k < GRID; k++) {
      const pk = w[k] * L[i][k];
      den += pk;
      m1 += pk * grid[k];
      m2 += pk * grid[k] * grid[k];
    }
    const eta = den > 0 ? m1 / den : 0;
    const varEta = den > 0 ? Math.max(m2 / den - eta * eta, 0) : 1;
    const post = m[i] + s[i] * eta;
    const pull = l[i] - m[i];
    const B = r.se2 / (r.se2 + s[i] * s[i]);
    const normalVar = r.se2 * (1 - B) + B * B * varLoc(x[i]) + morrisK * B * B * (l[i] - priorM[i]) ** 2;
    return {
      id: r.id,
      m: post,
      v: Math.max(s[i] * s[i] * varEta, normalVar),
      priorM: m[i],
      priorS: s[i],
      ownWeight: Math.abs(pull) > 1e-9 ? Math.min(Math.max((post - m[i]) / pull, 0), 1) : 0,
    };
  });
}
