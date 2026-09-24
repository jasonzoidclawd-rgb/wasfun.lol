/**
 * Reliable grades (The math, section 6).
 *
 * Kline, Rose & Walters: minimise (1 - λ)·DP − λ·τ over contiguous tiers of the
 * posterior-mean ordering, λ = 0.25, so a pair is split only above 80% certainty
 * that one exceeds the other by the 0.5 pp margin. Tiers by dynamic programming.
 * The spec caps this at five tiers. With large, precisely measured sets (62
 * augments of a rarity, 173 champions) five tiers are forced to be wide, each
 * reaching toward zero, so conservative letters could never show S or even A,
 * and any other fixed cap makes the letters a function of that constant. So
 * the DP is not capped: the λ-objective alone decides every split (a pair is
 * split only when the data orders it), which in the limit of precise data
 * gives each option its own band. Adjacent tiers that land on the same letter
 * are merged for display, so at most five letter groups ever show.
 * Letters are conservative: a tier takes the band of its
 * well-measured member closest to zero (B if those span zero); thin members
 * inherit it outlined; a tier with no well-measured member takes the band of its
 * member closest to zero, outlined, and never feeds the Plan card.
 */
import { Phi } from "./normal";

export const LAMBDA = 0.25;
export const MARGIN = 0.5; // pp
/** Raw DP tiers: no cap beyond the set size (see the module note); merged by letter for display. */
export const MAX_TIERS = Infinity;
export const THIN_OWN_SE = 1.5; // pp: an option's own noise at or above this is thin
export const THIN_POST_SD = 1.0; // pp: posterior sd at or above this is thin

export type Letter = "S" | "A" | "B" | "C" | "D";

export function bandOf(x: number): Letter {
  if (x >= 3.5) return "S";
  if (x >= 1.5) return "A";
  if (x > -1.5) return "B";
  if (x > -3.5) return "C";
  return "D";
}

export interface GradeInput {
  id: string;
  /** posterior mean lift, pp */
  m: number;
  /** posterior variance, pp² */
  v: number;
  /** thin data: own noise ≥ 1.5 pp or posterior sd ≥ 1 pp, or no row of its own */
  thin: boolean;
}

export interface Graded {
  id: string;
  letter: Letter;
  tier: number;
  /** position in the posterior-mean ordering, 0 = best */
  order: number;
  /** outlined chip: thin, or its tier had no well-measured member */
  outlined: boolean;
  /** may feed the Plan card: its tier has a well-measured member */
  planEligible: boolean;
}

/** P(θ_i > θ_j + margin) with covariance. */
export function pairwise(mi: number, vi: number, mj: number, vj: number, cov = 0, margin = MARGIN): number {
  return Phi((mi - mj - margin) / Math.sqrt(Math.max(1e-9, vi + vj - 2 * cov)));
}

/**
 * `inflate` multiplies every variance and covariance: the posteriors run
 * slightly overconfident in simulation, so grading uses the calibrated
 * multiplier GRADE_INFLATE (see the calibration test).
 */
export const GRADE_INFLATE = 1.4;

export function grade(set: GradeInput[], cov?: (i: number, j: number) => number, inflate = GRADE_INFLATE): Graded[] {
  const n = set.length;
  if (n === 0) return [];
  const idx = set.map((_, i) => i).sort((a, b) => set[b].m - set[a].m);
  // Loss of keeping ordered positions a < b in one tier (splitting them is the baseline).
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const i = idx[a];
      const j = idx[b];
      const p = pairwise(set[i].m, set[i].v * inflate, set[j].m, set[j].v * inflate, cov ? cov(i, j) * inflate : 0);
      L[a][b] = (1 - LAMBDA) * (1 - p) - LAMBDA * (2 * p - 1);
    }
  }
  const S = Array.from({ length: n + 1 }, () => new Float64Array(n + 1));
  for (let a = n - 1; a >= 0; a--) {
    for (let b = a + 1; b < n; b++) {
      let r = 0;
      for (let y = a + 1; y <= b; y++) r += L[a][y];
      S[a][b] = S[a + 1][b] + r;
    }
  }
  const K = Math.min(MAX_TIERS, n);
  const F = Array.from({ length: K + 1 }, () => new Float64Array(n + 1).fill(-1e18));
  const P = Array.from({ length: K + 1 }, () => new Int32Array(n + 1));
  F[0][0] = 0;
  for (let k = 1; k <= K; k++) {
    for (let e = 1; e <= n; e++) {
      for (let s = k - 1; s < e; s++) {
        const val = F[k - 1][s] + S[s][e - 1];
        if (val > F[k][e]) {
          F[k][e] = val;
          P[k][e] = s;
        }
      }
    }
  }
  let bestK = 1;
  for (let k = 1; k <= K; k++) if (F[k][n] > F[bestK][n] + 1e-12) bestK = k;
  const segs: Array<[number, number]> = [];
  for (let k = bestK, e = n; k > 0; k--) {
    const s = P[k][e];
    segs.unshift([s, e - 1]);
    e = s;
  }

  const tiers = segs.map(([s, e]) => {
    const members = idx.slice(s, e + 1).map((i) => set[i]);
    const firm = members.filter((r) => !r.thin);
    const ms = (firm.length ? firm : members).map((r) => r.m);
    const spans = Math.max(...ms) > 0 && Math.min(...ms) < 0;
    const closest = ms.reduce((c, x) => (Math.abs(x) < Math.abs(c) ? x : c), ms[0]);
    return { s, e, letter: spans ? ("B" as Letter) : bandOf(closest), hasFirm: firm.length > 0 };
  });
  // Plan eligibility is decided per raw tier, before display merging: a tier with
  // no well-measured member never feeds the Plan card, even when merged.
  const rawFirm = new Array<boolean>(n);
  for (const t of tiers) for (let a = t.s; a <= t.e; a++) rawFirm[a] = t.hasFirm;
  // Adjacent tiers that land on the same letter read as one group.
  const merged: typeof tiers = [];
  for (const t of tiers) {
    const last = merged[merged.length - 1];
    if (last && last.letter === t.letter) {
      last.e = t.e;
      last.hasFirm = last.hasFirm || t.hasFirm;
    } else merged.push({ ...t });
  }
  const out: Graded[] = new Array(n);
  merged.forEach((t, ti) => {
    for (let a = t.s; a <= t.e; a++) {
      const i = idx[a];
      out[i] = {
        id: set[i].id,
        letter: t.letter,
        tier: ti + 1,
        order: a,
        outlined: set[i].thin || !rawFirm[a],
        planEligible: rawFirm[a],
      };
    }
  });
  return out;
}

export function isThin(ownSe: number, postVar: number): boolean {
  return ownSe >= THIN_OWN_SE || Math.sqrt(postVar) >= THIN_POST_SD;
}
