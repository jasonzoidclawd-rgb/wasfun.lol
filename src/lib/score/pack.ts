/**
 * Score pack: the engine run once over the current feeds, shaped for pages.
 *
 * Server-only (reads data/internal). Memoized per process, so a build computes
 * it once. Returns null while the augment-statistics kill switch is off, and
 * every page that shows a letter or an augment number gets its data here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PoolAugmentInput } from "@/lib/scoring/pool-orchestrator";
import { offerPool } from "./offer-pool";
import { augmentStatsEnabled } from "@/lib/stats/kill-switch";
import type { AbilityProfile, ChampionBaseStats, ChampionTag, PoolRules } from "@/lib/types";
import { CARRY_OVER_ENABLED, TAU_ASSUMED } from "./config";
import {
  augmentPosteriors,
  bootsSet,
  buildOrders,
  championLetters,
  COMPLETION_CAVEAT,
  gradeSet,
  RARITIES,
  type AugmentPosterior,
  type BuildOrder,
  type ChampionRow,
  type Feeds,
  type GradedOption,
  type GradedRow,
  type Rarity,
} from "./engine";
import type { Letter } from "./grade";
import { estimateVolume } from "./volume";

const DATA = path.join(process.cwd(), "data", "internal");

function read<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(DATA, file), "utf-8")) as T;
}

export interface CatalogAugment extends PoolAugmentInput {
  augmentId?: string;
  name: string;
  names?: Record<string, string>;
  [key: string]: unknown;
}

interface ChampionCatalogRow {
  slug: string;
  name: string;
  kit_tags?: ChampionTag[];
  baseStats?: ChampionBaseStats;
  [key: string]: unknown;
}

export interface ScorePackMeta {
  patch: string;
  /** the provider's observation date */
  dataDate: string;
  provider: string;
  /** a LOWER BOUND on the games behind the provider's snapshot (volume.ts) */
  volume: number;
  volumeNote?: string;
  tau: number;
  carryOver: boolean;
  /** the provider's champion augment rows copy the global rows */
  championWinRates: Feeds["championWinRates"];
  buildCaveat: string;
}

export interface ChampionPack {
  slug: string;
  winRate: number;
  pickRate: number | null;
  letter: Letter | null;
  /** the champion's letter is sensitive to the unit assumption: shown outlined */
  letterOutlined: boolean;
  /** the champion's decision set per rarity: its pool, graded */
  sets: Record<Rarity, GradedOption[]>;
  /** the champion's own appearance rate for the augments the provider lists, by augment id */
  listed: Record<string, number>;
  boots: GradedRow[] | null;
  builds: { ranked: BuildOrder[]; rare: string[] };
}

export interface ScorePack {
  meta: ScorePackMeta;
  tierLists: Record<Rarity, GradedOption[]>;
  champions: GradedRow[];
  catalog: Map<string, CatalogAugment>;
  pack: (slug: string) => ChampionPack | null;
}

let cached: ScorePack | null | undefined;

/** For tests: drop the memoized pack (for example after changing the kill switch). */
export function resetScorePack(): void {
  cached = undefined;
}

export function loadScorePack(): ScorePack | null {
  if (!augmentStatsEnabled()) return null;
  if (cached !== undefined) return cached;
  cached = buildScorePack();
  return cached;
}

function buildScorePack(): ScorePack | null {
  const statsFeed = read<{ rows: Feeds["augmentRows"]; dataDate?: string }>("augment-stats-feed.json");
  const buildFeed = read<{
    patch: string;
    dataDate: string;
    champions: Record<string, ChampionRow>;
    semantics?: { "augments[].winRate"?: { status?: Feeds["championWinRates"] } };
  }>("champion-build-feed.json");
  const feeds: Feeds = {
    augmentRows: statsFeed.rows,
    champions: buildFeed.champions,
    championWinRates: buildFeed.semantics?.["augments[].winRate"]?.status ?? "unknown",
  };
  const patchStarts = Object.fromEntries(
    read<{ patches?: { version: string; publishedAt?: string }[] }>("patch-metadata.json")
      .patches?.filter((p) => p.publishedAt)
      .map((p) => [p.version, p.publishedAt as string]) ?? [],
  );
  const volume = estimateVolume(
    Object.values(buildFeed.champions).map((c) => c.history ?? []),
    patchStarts,
    { patch: buildFeed.patch, dataDate: buildFeed.dataDate },
  );
  if (!volume) return null; // no fitted noise scale: grade nothing rather than assume one
  const opts = { volume: volume.games, carryOver: null };

  const catalogRows = read<{ augments: CatalogAugment[] }>("augments.json").augments;
  const catalog = new Map<string, CatalogAugment>();
  for (const a of catalogRows) if (a.augmentId && !catalog.has(a.augmentId)) catalog.set(a.augmentId, a);
  const abilities = read<{ profiles: Record<string, AbilityProfile> }>("abilities.json").profiles;
  const championCatalog = new Map(
    read<{ champions: ChampionCatalogRow[] }>("champions.json").champions.map((c) => [c.slug, c]),
  );
  const poolRules = read<PoolRules>("pool-rules.json");

  const global = Object.fromEntries(
    RARITIES.map((r) => [r, augmentPosteriors(feeds, r, opts)]),
  ) as Record<Rarity, AugmentPosterior[]>;
  const tierLists = Object.fromEntries(
    RARITIES.map((r) => [r, gradeSet(global[r].filter((p) => p.resolved))]),
  ) as Record<Rarity, GradedOption[]>;
  const champions = championLetters(feeds, opts);
  const letterOf = new Map(champions.map((c) => [c.id, { letter: c.letter, outlined: c.outlined }]));

  // Pool construction works on catalog slugs; posteriors are keyed by augment id.
  const liveIds = new Set(statsFeed.rows.filter((r) => r.availability === "live" && r.augmentId).map((r) => r.augmentId as string));
  const observedLive = new Set(catalogRows.filter((a) => a.augmentId && liveIds.has(a.augmentId)).map((a) => a.slug));
  const idBySlug = new Map(catalogRows.filter((a) => a.augmentId).map((a) => [a.slug, a.augmentId as string]));
  const packs = new Map<string, ChampionPack | null>();

  function championPack(slug: string): ChampionPack | null {
    const row = buildFeed.champions[slug];
    const champ = championCatalog.get(slug);
    if (!row || !champ) return null;
    // every live augment the game can offer this champion (offer-pool.ts)
    const { offered } = offerPool({
      championSlug: slug,
      augments: catalogRows,
      abilityProfile: abilities[slug],
      baseStats: champ.baseStats,
      poolRules,
      observedLive,
    });
    const sets = {} as Record<Rarity, GradedOption[]>;
    for (const r of RARITIES) {
      const listedRows = row.augments.filter((a) => a.rarity === r);
      // an augment the provider lists for this champion was offered to it, whatever the rules say
      const ids = new Set(offered.filter((a) => a.rarity === r).map((a) => idBySlug.get(a.slug)).filter((id): id is string => !!id));
      for (const a of listedRows) if (a.augmentId) ids.add(a.augmentId);
      // letters are the tier list's (graded across all champions), not re-graded within the pool
      sets[r] = tierLists[r].filter((o) => ids.has(o.id));
    }
    const listed: Record<string, number> = {};
    for (const a of row.augments) if (a.augmentId) listed[a.augmentId] = a.appearanceRate;
    return {
      slug,
      winRate: row.winRate,
      pickRate: row.pickRate,
      letter: letterOf.get(slug)?.letter ?? null,
      letterOutlined: letterOf.get(slug)?.outlined ?? false,
      sets,
      listed,
      boots: bootsSet(row, opts),
      builds: buildOrders(row, opts),
    };
  }

  return {
    meta: {
      patch: buildFeed.patch,
      dataDate: buildFeed.dataDate,
      provider: "arammayhem.com",
      volume: volume.games,
      ...(volume.note ? { volumeNote: volume.note } : {}),
      tau: TAU_ASSUMED,
      carryOver: CARRY_OVER_ENABLED,
      championWinRates: feeds.championWinRates,
      buildCaveat: COMPLETION_CAVEAT,
    },
    tierLists,
    champions,
    catalog,
    pack(slug: string) {
      if (!packs.has(slug)) packs.set(slug, championPack(slug));
      return packs.get(slug) ?? null;
    },
  };
}

export interface ChampionLetter {
  letter: Letter;
  outlined: boolean;
  /** position in the graded order, 0 = best */
  order: number;
  m: number;
  v: number;
}

let championCache: Map<string, ChampionLetter> | null | undefined;

/**
 * Champion letters against the field (the Swap check, the champions list, Home
 * and the champion page header). They grade the champions' own win rates, not
 * augment statistics, so the augment kill switch leaves them on.
 */
export function loadChampionLetters(): Map<string, ChampionLetter> | null {
  if (championCache !== undefined) return championCache;
  const buildFeed = read<{ patch: string; dataDate: string; champions: Record<string, ChampionRow> }>("champion-build-feed.json");
  const patchStarts = Object.fromEntries(
    read<{ patches?: { version: string; publishedAt?: string }[] }>("patch-metadata.json")
      .patches?.filter((p) => p.publishedAt)
      .map((p) => [p.version, p.publishedAt as string]) ?? [],
  );
  const volume = estimateVolume(
    Object.values(buildFeed.champions).map((c) => c.history ?? []),
    patchStarts,
    { patch: buildFeed.patch, dataDate: buildFeed.dataDate },
  );
  if (!volume) return (championCache = null);
  const feeds = { augmentRows: [], champions: buildFeed.champions, championWinRates: "unknown" as const };
  championCache = new Map(
    championLetters(feeds, { volume: volume.games }).map((c) => [c.id, { letter: c.letter, outlined: c.outlined, order: c.order, m: c.m, v: c.v }]),
  );
  return championCache;
}
