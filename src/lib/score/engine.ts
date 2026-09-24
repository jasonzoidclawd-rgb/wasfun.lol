/**
 * The v3 scoring engine: provider feeds → graded decision sets.
 *
 * What the provider's data supports decides what this computes (see
 * docs/research/2026-09-24-statistics-feeds-phase0-results.md):
 *
 * - Augment outcomes exist only as ONE global row per augment. The champion
 *   rows copy it (semantics "global-copy"), so there is no champion-specific
 *   outcome to pool: the kit slope β and the interaction ι stay at their prior
 *   (β = 0, no synergy flags) and every champion's augment values are the
 *   global posterior. If the feed ever reports champion-specific rows, the
 *   pooled path (pooledPairPosterior) applies instead.
 * - The global lift is takers-adjusted (section 2, gₐ), from the champions'
 *   own appearance rates (real, not copies); the adjustment's spread between
 *   plausible unlisted shares enters each augment's variance.
 * - The kit covariate is never fitted: the champion rows' win rates are
 *   copies, so a slope fitted on them would learn champion baselines, not kit
 *   fit. It stays off until real per-champion outcomes exist.
 * - Noise uses the set's baseline rate and a LOWER BOUND on the provider's
 *   volume, fitted from its own snapshot history (volume.ts).
 * - Grading uses the lifts' pairwise covariance (section 1) on every surface.
 * - The unlisted-pair subtraction is off: its units are unconfirmed (unit guard).
 */
import { carriedPrior, combineOnce, type Normal } from "./carryover";
import { TAKERS_ADJUSTMENT } from "./config";
import { closeNpmle } from "./close-npmle";
import { grade, isThin, MARGIN, pairwise, type Graded, type Letter } from "./grade";
import { leaveOneOutLifts, type LiftSet } from "./lift";

export type Rarity = "prismatic" | "gold" | "silver";
export const RARITIES: Rarity[] = ["prismatic", "gold", "silver"];

// ── feed shapes (the parts the engine reads) ────────────────────────────────

export interface GlobalAugmentRow {
  sourceSlug: string;
  augmentId: string | null;
  name: string;
  rarity: Rarity;
  availability: string;
  winRate: number; // percent
  pickRate: number; // percent (units unconfirmed; used only as relative weights and for volume shares)
}

export interface ChampionAugmentRow {
  rarity: Rarity;
  sourceSlug: string;
  augmentId: string | null;
  appearanceRate: number; // percent
  winRate: number; // percent
}

export interface ItemRow {
  items: { sourceSlug: string; name?: string }[] | string[];
  pickRate: number;
  winRate: number;
}

export interface ChampionRow {
  winRate: number;
  pickRate: number | null;
  patch: string;
  dataDate: string;
  augments: ChampionAugmentRow[];
  items: Record<string, ItemRow[]>;
  history?: { snapshot: string; patch: string; winRate: number; pickRate: number }[];
}

export interface Feeds {
  augmentRows: GlobalAugmentRow[];
  champions: Record<string, ChampionRow>;
  /** semantics of the champion rows' augment win rates */
  championWinRates: "global-copy" | "champion-specific" | "mixed" | "unknown";
}

export interface EngineOptions {
  /** games behind the provider's snapshot, fitted by estimateVolume */
  volume: number;
  /**
   * Weight of the unlisted takers of an augment, as a fraction of the upper
   * bound (a champion's least-picked listed augment of that rarity). The truth
   * lies between 0 and 1; 0.5 is the midpoint, and the sensitivity is recorded.
   */
  unlistedTakerFraction?: number;
  /** sensitivity only: scales the per-champion total the unlisted shares are capped by */
  takersTotalScale?: number;
  /** carry-over: last patch's final posteriors, keyed by augment id */
  carryOver?: { fromPatch: string; posteriors: Record<string, Normal>; changed: Set<string> | "all" } | null;
}

// ── output shapes ───────────────────────────────────────────────────────────

export interface AugmentPosterior {
  id: string; // augmentId, or "src:<slug>" for unresolved rows (count in baselines, never shown)
  rarity: Rarity;
  resolved: boolean;
  /** raw leave-one-out lift on takers-adjusted win rates, pp */
  l: number;
  /** its noise variance, pp² */
  se2: number;
  ownSe: number;
  /** posterior mean and variance, pp / pp² */
  m: number;
  v: number;
  thin: boolean;
  /** provider numbers, shown under the letter */
  winRate: number;
  pickRate: number;
  /** percentage points the takers adjustment moved this augment */
  takersShift: number;
  carried: boolean;
  /** share of the posterior mean that comes from the option's own data */
  ownWeight: number;
  /** the lift set it belongs to and its index there, for pairwise covariance (not serialized) */
  lifts?: LiftSet;
  liftIndex?: number;
}

export interface GradedOption extends AugmentPosterior {
  letter: Letter;
  tier: number;
  order: number;
  outlined: boolean;
  planEligible: boolean;
}

// ── augments ────────────────────────────────────────────────────────────────

/**
 * Mean win rate of the champions who take each augment, weighted by how often
 * they take it (section 2, gₐ). The champions' appearance rates are their own
 * (unlike their augment win rates, they are not copies of the global row), but
 * only the six most-picked per rarity are listed. An unlisted augment's share
 * for a champion is below that champion's least-picked listed one; it is set to
 * `unlistedFraction` of that bound, capped so that the champion's unlisted
 * augments together take no more than the mass left after its listed ones.
 * That total per rarity is the global pick rates' sum / 10 (share-of-games
 * units, 10 players a game: a hypothesis, see the phase 0 units table).
 * Caveat: the champions' win rates include the augment's own effect, which
 * slightly attenuates the shift.
 */
export function takersBaseline(feeds: Feeds, rarity: Rarity, unlistedFraction: number, totalScale = 1): {
  byAugment: Map<string, number>;
  population: number;
} {
  const champs = Object.values(feeds.champions).filter((c) => (c.pickRate ?? 0) > 0);
  const popW = champs.reduce((t, c) => t + (c.pickRate as number), 0);
  const population = champs.reduce((t, c) => t + (c.pickRate as number) * c.winRate, 0) / popW;
  const mass = new Map<string, number>();
  const sum = new Map<string, number>();
  const live = feeds.augmentRows.filter((r) => r.rarity === rarity && r.availability === "live");
  const perChampionTotal = (totalScale * live.reduce((t, r) => t + r.pickRate, 0)) / 10;
  for (const c of champs) {
    const listed = c.augments.filter((r) => r.rarity === rarity);
    const bound = listed.length ? Math.min(...listed.map((r) => r.appearanceRate)) : 0;
    const listedKeys = new Set(listed.map((r) => r.sourceSlug));
    const unlistedCount = live.filter((r) => !listedKeys.has(r.sourceSlug)).length;
    const remaining = Math.max(0, perChampionTotal - listed.reduce((t, r) => t + r.appearanceRate, 0));
    const unlistedShare = unlistedCount ? Math.min(unlistedFraction * bound, remaining / unlistedCount) : 0;
    for (const row of live) {
      const own = listed.find((r) => r.sourceSlug === row.sourceSlug);
      const share = own ? own.appearanceRate : listedKeys.size ? unlistedShare : 0;
      const w = (c.pickRate as number) * share;
      mass.set(row.sourceSlug, (mass.get(row.sourceSlug) ?? 0) + w);
      sum.set(row.sourceSlug, (sum.get(row.sourceSlug) ?? 0) + w * c.winRate);
    }
  }
  const byAugment = new Map<string, number>();
  for (const [slug, m] of mass) byAugment.set(slug, m > 0 ? (sum.get(slug) as number) / m : population);
  return { byAugment, population };
}

export function augmentPosteriors(feeds: Feeds, rarity: Rarity, opts: EngineOptions): AugmentPosterior[] {
  const rows = feeds.augmentRows.filter((r) => r.rarity === rarity && r.availability === "live" && r.pickRate > 0);
  if (rows.length < 2) return [];
  // The shift at the central assumptions, and its spread over the plausible
  // envelope: unlisted share 0.25–0.75 of the bound × the per-champion total
  // ×0.5–×1.5 (the unit hypothesis). Half that range, squared, is the
  // adjustment's own uncertainty and enters each augment's variance, so grades
  // and close calls never lean on it more than it deserves.
  const shiftAt = (f: number, scale: number) => {
    const t = takersBaseline(feeds, rarity, f, scale);
    return rows.map((r) => (t.byAugment.get(r.sourceSlug) ?? t.population) - t.population);
  };
  const zero = rows.map(() => 0);
  const shift = TAKERS_ADJUSTMENT ? shiftAt(opts.unlistedTakerFraction ?? 0.5, opts.takersTotalScale ?? 1) : zero;
  const corners = TAKERS_ADJUSTMENT
    ? [shiftAt(0.25, 0.5), shiftAt(0.25, 1.5), shiftAt(0.75, 0.5), shiftAt(0.75, 1.5), shift]
    : [zero];
  const systematic = rows.map((_, i) => {
    const xs = corners.map((c) => c[i]);
    return ((Math.max(...xs) - Math.min(...xs)) / 2) ** 2; // pp²
  });
  const lifts = leaveOneOutLifts(
    rows.map((r, i) => ({
      id: r.augmentId ?? `src:${r.sourceSlug}`,
      p: r.pickRate,
      w: (r.winRate - shift[i]) / 100,
      n: (r.pickRate / 100) * opts.volume,
    })),
  );
  const se2 = rows.map((_, i) => lifts.se2[i] + systematic[i]);
  const post = closeNpmle(rows.map((r, i) => ({ id: lifts.ids[i], l: lifts.lift[i], se2: se2[i], p: r.pickRate })));
  return rows.map((r, i) => {
    let { m, v } = post[i];
    let ownWeight = post[i].ownWeight;
    let carried = false;
    const id = lifts.ids[i];
    const last = opts.carryOver?.posteriors[id];
    if (opts.carryOver && last) {
      const changed = opts.carryOver.changed === "all" || opts.carryOver.changed.has(id);
      const combined = combineOnce(carriedPrior(last, changed), {
        kind: "patch-to-date",
        snapshotDate: "current",
        l: lifts.lift[i],
        se2: se2[i],
      });
      m = combined.m;
      v = combined.v;
      ownWeight = combined.v / se2[i];
      carried = true;
    }
    return {
      id,
      rarity,
      resolved: !!r.augmentId,
      l: lifts.lift[i],
      se2: se2[i],
      ownSe: lifts.ownSe[i],
      m,
      v,
      thin: isThin(lifts.ownSe[i], v),
      winRate: r.winRate,
      pickRate: r.pickRate,
      takersShift: shift[i],
      carried,
      ownWeight,
      lifts,
      liftIndex: i,
    };
  });
}

/** Pairwise covariance of two posteriors from the same lift set (0 across sets). */
export function posteriorCovariance(a: AugmentPosterior, b: AugmentPosterior): number {
  if (!a.lifts || a.lifts !== b.lifts || a.liftIndex === undefined || b.liftIndex === undefined) return 0;
  return a.ownWeight * b.ownWeight * a.lifts.cov(a.liftIndex, b.liftIndex);
}

/** Grade a set of posteriors (a tier list, or one champion's pool). */
export function gradeSet(options: AugmentPosterior[]): GradedOption[] {
  const graded: Graded[] = grade(
    options.map((o) => ({ id: o.id, m: o.m, v: o.v, thin: o.thin })),
    (i, j) => posteriorCovariance(options[i], options[j]),
  );
  return options.map((o, i) => ({ ...o, ...graded[i], id: o.id }));
}

/** Tier list for one rarity: every resolved live augment, across all champions. */
export function tierList(feeds: Feeds, rarity: Rarity, opts: EngineOptions): GradedOption[] {
  return gradeSet(augmentPosteriors(feeds, rarity, opts).filter((p) => p.resolved));
}

/**
 * One champion's decision set for a rarity: the augments in its pool. With
 * global-copy rows every value is the global posterior; the letters can still
 * differ from the tier list because the set being graded is the champion's own.
 */
export function championSet(global: AugmentPosterior[], poolIds: Iterable<string>): GradedOption[] {
  const pool = new Set(poolIds);
  return gradeSet(global.filter((p) => pool.has(p.id)));
}

/**
 * The pooled path for champion-specific rows (not used while rows are global
 * copies): prior gₐ + βk with variance τ² + var(gₐ), shrunk toward the
 * champion's own lift by its precision. Unlisted pairs get the prior alone.
 */
export function pooledPairPosterior(prior: Normal, own: { l: number; se2: number } | null): Normal & { ownWeight: number } {
  if (!own) return { ...prior, ownWeight: 0 };
  const s = prior.v / (prior.v + own.se2);
  return { m: prior.m + s * (own.l - prior.m), v: s * own.se2, ownWeight: s };
}

// ── champions (Swap check), boots, build orders ─────────────────────────────

export interface GradedRow {
  id: string;
  winRate: number;
  pickRate: number;
  l: number;
  m: number;
  v: number;
  ownSe: number;
  thin: boolean;
  letter: Letter;
  tier: number;
  order: number;
  outlined: boolean;
}

function gradeRows(rows: { id: string; p: number; w: number; n: number }[], shrink = true): GradedRow[] {
  const lifts = leaveOneOutLifts(rows);
  const post = shrink
    ? closeNpmle(rows.map((r, i) => ({ id: r.id, l: lifts.lift[i], se2: lifts.se2[i], p: r.p })))
    : rows.map((r, i) => ({ m: lifts.lift[i], v: lifts.se2[i] }));
  const weight = post.map((q) => ("ownWeight" in q ? (q as { ownWeight: number }).ownWeight : 1));
  const g = grade(
    rows.map((r, i) => ({ id: r.id, m: post[i].m, v: post[i].v, thin: isThin(lifts.ownSe[i], post[i].v) })),
    (i, j) => weight[i] * weight[j] * lifts.cov(i, j),
  );
  return rows.map((r, i) => ({
    id: r.id,
    winRate: r.w * 100,
    pickRate: r.p,
    l: lifts.lift[i],
    m: post[i].m,
    v: post[i].v,
    ownSe: lifts.ownSe[i],
    thin: isThin(lifts.ownSe[i], post[i].v),
    letter: g[i].letter,
    tier: g[i].tier,
    order: g[i].order,
    outlined: g[i].outlined,
  }));
}

/** Champion letters vs the field (Swap check). Baseline: pick-weighted mean of the other champions. */
export function championLetters(feeds: Feeds, opts: EngineOptions): GradedRow[] {
  const rows = Object.entries(feeds.champions)
    .filter(([, c]) => (c.pickRate ?? 0) > 0)
    .map(([slug, c]) => ({ id: slug, p: c.pickRate as number, w: c.winRate / 100, n: ((c.pickRate as number) / 100) * opts.volume }));
  return gradeRows(rows);
}

/** Boots on one champion: a decision set whose pick rates must sum to 1.02 or less. */
export function bootsSet(champion: ChampionRow, opts: EngineOptions): GradedRow[] | null {
  const boots = champion.items.boots ?? [];
  const total = boots.reduce((t, b) => t + b.pickRate, 0);
  if (boots.length < 2 || total > 102 || !champion.pickRate) return null;
  const games = (champion.pickRate / 100) * opts.volume;
  return gradeRows(
    boots.map((b) => ({ id: itemKey(b), p: b.pickRate, w: b.winRate / 100, n: (b.pickRate / 100) * games })),
  );
}

export function itemKey(row: ItemRow): string {
  return row.items.map((i) => (typeof i === "string" ? i : i.sourceSlug)).join(">");
}

export interface BuildOrder {
  id: string;
  winRate: number;
  pickRate: number;
  rank: number;
  mostBuilt: boolean;
  /** the noise can't separate it from the path ranked just above */
  closeCallWithAbove: boolean;
  thin: boolean;
}

export const BUILD_FLOOR = 1.0; // % of the champion's games
export const COMPLETION_CAVEAT =
  "Win rate counts only games that finished the path, so compare paths with each other, not with the champion's overall win rate.";

/**
 * Build orders: ranked by win rate among paths built in at least 1% of the
 * champion's games; pick rate shown; the most-built path tagged; neighbours the
 * noise can't separate (baseline-rate noise, the 0.5 pp margin) marked close
 * calls. Never graded: a path's win rate counts only games that finished it.
 */
export function buildOrders(champion: ChampionRow, opts: EngineOptions): { ranked: BuildOrder[]; rare: string[] } {
  const core = champion.items.core ?? [];
  if (!champion.pickRate || core.length === 0) return { ranked: [], rare: [] };
  const b0 = champion.winRate / 100;
  const games = (champion.pickRate / 100) * opts.volume;
  const se = (p: number) => Math.sqrt((b0 * (1 - b0)) / Math.max(1, (p / 100) * games)) * 100;
  const most = core.reduce((a, b) => (b.pickRate > a.pickRate ? b : a));
  const eligible = core.filter((b) => b.pickRate >= BUILD_FLOOR).sort((a, b) => b.winRate - a.winRate);
  const ranked = eligible.map((b, i) => {
    const up = eligible[i - 1];
    const close = !!up && pairwise(up.winRate, se(up.pickRate) ** 2, b.winRate, se(b.pickRate) ** 2, 0, MARGIN) < 0.8;
    return {
      id: itemKey(b),
      winRate: b.winRate,
      pickRate: b.pickRate,
      rank: i + 1,
      mostBuilt: b === most,
      closeCallWithAbove: close,
      thin: se(b.pickRate) >= 1.5,
    };
  });
  const rare = core.filter((b) => b.pickRate < BUILD_FLOOR).map(itemKey);
  return { ranked, rare };
}
