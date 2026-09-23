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
 * - The global lift is takers-adjusted: an augment favoured by strong champions
 *   is not mistaken for a strong augment (The math, section 2, gₐ).
 * - Noise uses the set's baseline rate and the volume fitted from the
 *   provider's own snapshot history, never an assumed game count.
 * - The unlisted-pair subtraction is off: its units are unconfirmed (unit guard).
 */
import { carriedPrior, combineOnce, type Normal } from "./carryover";
import { closeNpmle } from "./close-npmle";
import { grade, isThin, MARGIN, pairwise, type Graded, type Letter } from "./grade";
import { leaveOneOutLifts } from "./lift";

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
}

export interface GradedOption extends AugmentPosterior {
  letter: Letter;
  tier: number;
  order: number;
  outlined: boolean;
  planEligible: boolean;
}

// ── augments ────────────────────────────────────────────────────────────────

/** Mean win rate of the champions who take each augment, weighted by how often they take it. */
export function takersBaseline(feeds: Feeds, rarity: Rarity, unlistedFraction: number): {
  byAugment: Map<string, number>;
  population: number;
} {
  const champs = Object.values(feeds.champions).filter((c) => (c.pickRate ?? 0) > 0);
  const popW = champs.reduce((t, c) => t + (c.pickRate as number), 0);
  const population = champs.reduce((t, c) => t + (c.pickRate as number) * c.winRate, 0) / popW;
  const mass = new Map<string, number>();
  const sum = new Map<string, number>();
  for (const c of champs) {
    const listed = c.augments.filter((r) => r.rarity === rarity);
    const bound = listed.length ? Math.min(...listed.map((r) => r.appearanceRate)) : 0;
    const listedKeys = new Set(listed.map((r) => r.sourceSlug));
    for (const row of feeds.augmentRows) {
      if (row.rarity !== rarity || row.availability !== "live") continue;
      const own = listed.find((r) => r.sourceSlug === row.sourceSlug);
      const share = own ? own.appearanceRate : listedKeys.size ? unlistedFraction * bound : 0;
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
  const takers = takersBaseline(feeds, rarity, opts.unlistedTakerFraction ?? 0.5);
  const shift = rows.map((r) => (takers.byAugment.get(r.sourceSlug) ?? takers.population) - takers.population);
  const lifts = leaveOneOutLifts(
    rows.map((r, i) => ({
      id: r.augmentId ?? `src:${r.sourceSlug}`,
      p: r.pickRate,
      w: (r.winRate - shift[i]) / 100,
      n: (r.pickRate / 100) * opts.volume,
    })),
  );
  const post = closeNpmle(rows.map((r, i) => ({ id: lifts.ids[i], l: lifts.lift[i], se2: lifts.se2[i], p: r.pickRate })));
  return rows.map((r, i) => {
    let { m, v } = post[i];
    let carried = false;
    const id = lifts.ids[i];
    const last = opts.carryOver?.posteriors[id];
    if (opts.carryOver && last) {
      const changed = opts.carryOver.changed === "all" || opts.carryOver.changed.has(id);
      const combined = combineOnce(carriedPrior(last, changed), {
        kind: "patch-to-date",
        snapshotDate: "current",
        l: lifts.lift[i],
        se2: lifts.se2[i],
      });
      m = combined.m;
      v = combined.v;
      carried = true;
    }
    return {
      id,
      rarity,
      resolved: !!r.augmentId,
      l: lifts.lift[i],
      se2: lifts.se2[i],
      ownSe: lifts.ownSe[i],
      m,
      v,
      thin: isThin(lifts.ownSe[i], v),
      winRate: r.winRate,
      pickRate: r.pickRate,
      takersShift: shift[i],
      carried,
    };
  });
}

/** Grade a set of posteriors (a tier list, or one champion's pool). */
export function gradeSet(options: AugmentPosterior[]): GradedOption[] {
  const graded: Graded[] = grade(options.map((o) => ({ id: o.id, m: o.m, v: o.v, thin: o.thin })));
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
  const g = grade(rows.map((r, i) => ({ id: r.id, m: post[i].m, v: post[i].v, thin: isThin(lifts.ownSe[i], post[i].v) })));
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
