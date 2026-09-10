/**
 * DEVELOPMENT-ONLY ARAMGG data adapter for evaluating PR #46's tier card.
 *
 * ARAMGG (aramgg.com) is the CANONICAL, non-synthetic source of augment win
 * rate, sample size and tier for the dev tier-fixture. This module fetches and
 * parses ARAMGG's public static JSON and resolves each League/CDragon augment
 * identity to an ARAMGG record. It NEVER invents statistics and NEVER falls
 * back to local `augments.json` win rates: an augment that cannot be matched to
 * a live ARAMGG record simply has no stat (diagnosed, never faked).
 *
 * Only pure functions and an injectable `loadAramggSource(fetch)` live here so
 * the parsing/matching/formatting logic is unit-testable without a browser or
 * `import.meta`. The DEV+flag gate lives in `tierFixture.ts`.
 */
import type { DecisionGrade } from "../contracts/decision";
import type { TierLetter } from "../model/tier";
import { decimalShiftPercent } from "../winRateFormat";

// Canonical source URLs, recorded verbatim for provenance display. At dev
// runtime the overlay fetches these THROUGH the Vite dev proxy
// (`/aramgg-dev` → https://aramgg.com, see vite.config.ts) so the request is
// same-origin and satisfies the webview's `connect-src 'self'` CSP without
// weakening it. Production builds never import this module's loader.
export const ARAMGG_SOURCE = {
  origin: "https://aramgg.com",
  stats: "/data/augments-stats-raw.json",
  catalog: "/data/aram-mayhem-augments.zh_cn.json",
  // Riot-localized zh-TW catalog (same numeric augment IDs + canonical ARAM_*
  // names as the zh_cn file, displayName in Traditional Chinese). This is the
  // canonical-language bridge for zh-TW OCR titles: OCR title → zh-TW catalog
  // → canonical numeric ID → ARAMGG stats. OCR text is never compared against
  // the Simplified Chinese catalog first.
  catalogZhTw: "/data/aram-mayhem-augments.zh_tw.json",
  changelog: "/data/augments-changelog/index.json",
} as const;

/** Dev-only proxy prefix; forwarded server-side by Vite to ARAMGG_SOURCE.origin. */
export const ARAMGG_DEV_PROXY_PREFIX = "/aramgg-dev";

// ─── Types ───

export interface AramggStat {
  augmentId: string;
  /** Raw win rate string exactly as ARAMGG supplies it, e.g. "0.563213". */
  rawWinRate: string;
  /** Exact percentage via string decimal shift (×100), e.g. "56.3213". */
  winRatePercent: string;
  numGames: string;
  pickRate: string;
  /** Upstream numeric tier (1 = best … 5 = worst). */
  tier: number;
  /** Presentation-relabeled card tier (ARAMGG upstream tier, relabeled). */
  tierLetter: TierLetter;
  /** Decision grade whose `tierForGrade` yields the same letter. */
  grade: DecisionGrade;
  /** Whether this row is the augment-wide value or an ARAMGG top-champion row. */
  provenance: "global" | "champion";
  /** Numeric Riot champion key for champion rows; null for the global row. */
  championId: string | null;
  championRank: string | null;
  /** Sparse ARAMGG top-champion rows, keyed by numeric Riot champion ID. */
  topChampionsById: Map<string, AramggStat>;
}

export interface AramggCatalogEntry {
  augmentId: string;
  /** Language-independent CDragon/API canonical name, e.g. "ARAM_ImTheJuggernaut". */
  canonicalName: string | null;
  /** Localized (zh_cn) display name. */
  displayName: string | null;
  /** Normalized CDragon icon-asset base (the canonical bridge key). */
  iconBase: string | null;
}

export interface AramggCatalogIndex {
  entries: Map<string, AramggCatalogEntry>;
  /** normalized icon base → augmentId[] (collision list). */
  byIconBase: Map<string, string[]>;
  /** normalized display name → augmentId[] (collision list). */
  byName: Map<string, string[]>;
  /** normalized canonical name → augmentId[] (collision list). */
  byCanonicalName: Map<string, string[]>;
}

export type MatchMethod =
  | "cdragon-icon" // priority 2: language-independent CDragon asset (unambiguous)
  | "cdragon-icon+zh-tiebreak" // ambiguous icon disambiguated by localized name
  | "canonical-name" // priority 2: ARAM_* canonical name (when the caller has it)
  | "localized-name"; // priority 3: last resort (explicitly logged)

export interface AramggResolution {
  augmentId: string;
  method: MatchMethod;
}

export interface AramggResolutionFailure {
  augmentId: null;
  reason: "ambiguous-icon" | "ambiguous-name" | "unmatched";
  detail?: string;
}

export interface AramggSource {
  statsById: Map<string, AramggStat>;
  catalog: AramggCatalogIndex;
  /** Riot-localized zh-TW title index (the canonical-language OCR bridge). */
  titleIndex: RiotTitleIndex;
  /** ARAMGG data patch, e.g. "16.13" (site displays "26.13"). */
  patch: string;
  fetchedAt: number;
  sourceUrls: { stats: string; catalog: string; catalogZhTw: string; changelog: string };
}

// ─── Riot zh-TW title bridge: OCR title → canonical augment ID ───

export interface RiotTitleEntry {
  augmentId: string;
  /** Language-independent canonical name, e.g. "ARAM_SpecializedRecursion". */
  canonicalName: string | null;
  /** Riot zh-TW display name, e.g. "疾速追擊". */
  zhTwName: string | null;
  /** Riot zh-CN display name (logged last-resort bridge only). */
  zhCnName: string | null;
}

export interface RiotTitleIndex {
  entries: Map<string, RiotTitleEntry>;
  /** normalized zh-TW display name → augmentId[] (collision list). */
  byZhTwName: Map<string, string[]>;
  /** normalized zh-CN display name → augmentId[] (collision list). */
  byZhCnName: Map<string, string[]>;
}

export type RiotTitleMethod =
  | "riot-zh-tw-exact" // canonical path: exact zh-TW display name
  | "riot-zh-tw-fuzzy" // one-character OCR drift against zh-TW names, unambiguous
  | "riot-zh-cn-exact"; // LAST RESORT (logged): exact zh-CN display name

export interface RiotTitleResolution {
  augmentId: string;
  canonicalName: string | null;
  zhTwName: string | null;
  method: RiotTitleMethod;
  confidence: number;
}

export type RiotTitleRejection =
  | { augmentId: null; reason: "empty-title" }
  | { augmentId: null; reason: "ambiguous-zh-tw-name"; detail: string }
  | { augmentId: null; reason: "ambiguous-zh-tw-fuzzy"; detail: string }
  | { augmentId: null; reason: "ambiguous-zh-cn-name"; detail: string }
  | { augmentId: null; reason: "riot-catalog-unmatched" };

export function buildRiotTitleIndex(
  zhTwCatalog: unknown,
  zhCnCatalog: unknown,
): RiotTitleIndex {
  const entries = new Map<string, RiotTitleEntry>();
  const byZhTwName = new Map<string, string[]>();
  const byZhCnName = new Map<string, string[]>();

  const readCatalog = (catalog: unknown, assign: (id: string, name: string | null, canonical: string | null) => void) => {
    if (catalog === null || typeof catalog !== "object") {
      throw new Error("buildRiotTitleIndex: expected a JSON object catalog");
    }
    for (const [augmentId, value] of Object.entries(catalog as Record<string, unknown>)) {
      if (!/^\d+$/.test(augmentId) || value === null || typeof value !== "object") continue;
      const rec = value as Record<string, unknown>;
      const displayName = typeof rec.displayName === "string" ? rec.displayName : null;
      const canonicalName = typeof rec.name === "string" ? rec.name : null;
      assign(augmentId, displayName, canonicalName);
    }
  };

  readCatalog(zhTwCatalog, (augmentId, displayName, canonicalName) => {
    entries.set(augmentId, {
      augmentId,
      canonicalName,
      zhTwName: displayName,
      zhCnName: null,
    });
    const nn = normalizeName(displayName);
    if (nn) byZhTwName.set(nn, [...(byZhTwName.get(nn) ?? []), augmentId]);
  });
  readCatalog(zhCnCatalog, (augmentId, displayName, canonicalName) => {
    const existing = entries.get(augmentId);
    if (existing) {
      existing.zhCnName = displayName;
      if (!existing.canonicalName) existing.canonicalName = canonicalName;
    } else {
      entries.set(augmentId, {
        augmentId,
        canonicalName,
        zhTwName: null,
        zhCnName: displayName,
      });
    }
    const nn = normalizeName(displayName);
    if (nn) byZhCnName.set(nn, [...(byZhCnName.get(nn) ?? []), augmentId]);
  });

  return { entries, byZhTwName, byZhCnName };
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Resolve one OCR card title to a canonical Riot augment ID.
 *
 * Path (per the identity contract): zh-TW OCR title → Riot zh-TW catalog →
 * canonical numeric augment ID. The card icon is NEVER consulted — quest cards
 * replace or obscure the ordinary augment icon, and generic icon assets are
 * shared across many augments. Ambiguous matches are rejected, never guessed.
 * The zh-CN exact name is an explicitly-separated last resort (the caller must
 * log it); OCR text is never fuzzy-matched against Simplified Chinese.
 */
export function resolveOcrTitle(
  ocrTitle: string | null | undefined,
  index: RiotTitleIndex,
): RiotTitleResolution | RiotTitleRejection {
  const normalized = normalizeName(ocrTitle);
  if (!normalized) return { augmentId: null, reason: "empty-title" };

  const finish = (
    augmentId: string,
    method: RiotTitleMethod,
    confidence: number,
  ): RiotTitleResolution => {
    const entry = index.entries.get(augmentId);
    return {
      augmentId,
      canonicalName: entry?.canonicalName ?? null,
      zhTwName: entry?.zhTwName ?? null,
      method,
      confidence,
    };
  };

  // 1. Exact zh-TW display name (canonical path).
  const exact = index.byZhTwName.get(normalized);
  if (exact) {
    if (exact.length === 1) return finish(exact[0], "riot-zh-tw-exact", 1);
    return {
      augmentId: null,
      reason: "ambiguous-zh-tw-name",
      detail: `${exact.length} augmentIds share zh-TW name "${normalized}"`,
    };
  }

  // 2. One-character OCR drift against zh-TW names (unambiguous only).
  let fuzzyIds: string[] = [];
  for (const [name, ids] of index.byZhTwName) {
    if (Math.abs(name.length - normalized.length) > 1) continue;
    if (name.length < 3 || normalized.length < 3) continue;
    if (levenshtein(name, normalized) === 1) {
      fuzzyIds = [...new Set([...fuzzyIds, ...ids])];
    }
  }
  if (fuzzyIds.length === 1) return finish(fuzzyIds[0], "riot-zh-tw-fuzzy", 0.9);
  if (fuzzyIds.length > 1) {
    return {
      augmentId: null,
      reason: "ambiguous-zh-tw-fuzzy",
      detail: `${fuzzyIds.length} zh-TW names within one-character drift`,
    };
  }

  // 3. LAST RESORT (caller logs): exact zh-CN display name only.
  const zhCn = index.byZhCnName.get(normalized);
  if (zhCn) {
    if (zhCn.length === 1) return finish(zhCn[0], "riot-zh-cn-exact", 0.8);
    return {
      augmentId: null,
      reason: "ambiguous-zh-cn-name",
      detail: `${zhCn.length} augmentIds share zh-CN name "${normalized}"`,
    };
  }

  return { augmentId: null, reason: "riot-catalog-unmatched" };
}

// ─── Win-rate percentage via exact string decimal shift ───
// The shift lives in the PRODUCTION module (chips consume it in release
// builds, where dev/ is stubbed out); re-exported here for existing dev/test
// importers.
export { decimalShiftPercent };

// ─── Pure: numeric tier → letter / grade ───

const TIER_LETTER_BY_NUM: Record<number, TierLetter> = {
  1: "S+",
  2: "S",
  3: "A",
  4: "B",
  5: "C",
};

// 1→hot(S+) 2→strong(S) 3→steady(A) 4→average(B) 5→weak(C) so the real
// `tierForGrade` presentation reproduces the relabeled ARAMGG tier exactly.
const GRADE_BY_NUM: Record<number, DecisionGrade> = {
  1: "hot",
  2: "strong",
  3: "steady",
  4: "average",
  5: "weak",
};

export function parseNumericTier(tier: string): number {
  if (typeof tier !== "string" || !/^[1-5]$/.test(tier.trim())) {
    throw new Error(`parseNumericTier: malformed tier "${tier}"`);
  }
  return Number(tier.trim());
}

export function numericTierToLetter(tier: string): TierLetter {
  return TIER_LETTER_BY_NUM[parseNumericTier(tier)];
}

export function numericTierToGrade(tier: string): DecisionGrade {
  return GRADE_BY_NUM[parseNumericTier(tier)];
}

// ─── Pure: identity normalization (the canonical bridge) ───

export function normalizeIconBase(iconPath: string | null | undefined): string | null {
  if (!iconPath) return null;
  let b = iconPath.split(/[\\/]/).pop() ?? iconPath;
  b = b.replace(/\.(png|jpg|jpeg|webp)$/i, "");
  b = b.replace(/_(large|small)$/i, "");
  let x = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Mayhem CDragon icons sometimes carry a "MayhemAugment"/"Augment" suffix
  // that ARAMGG's catalog omits; strip it so the bases align.
  x = x.replace(/mayhemaugment$/, "").replace(/augment$/, "");
  return x.length > 0 ? x : null;
}

export function normalizeName(name: string | null | undefined): string | null {
  if (!name) return null;
  // Keep CJK code points (localized names) and alphanumerics; drop punctuation
  // and whitespace so display-name matching is stable across separators.
  const x = name.toLowerCase().replace(/[^0-9a-z㐀-鿿]/g, "");
  return x.length > 0 ? x : null;
}

// ─── Pure: parse ARAMGG stats list ───

/**
 * ARAMGG stats are a list of `[augmentId, statsJSONString]` pairs where the
 * second element is a JSON STRING that must be parsed a second time. Entry
 * lengths are not uniform (an observed first entry had length 5), so iterate
 * defensively: take element 0 as the id and the first string element as the
 * blob. Every record is validated; malformed records are skipped and counted,
 * never coerced.
 */
export function parseStatsList(raw: unknown): {
  stats: Map<string, AramggStat>;
  skipped: number;
  skippedChampionStats: number;
} {
  const stats = new Map<string, AramggStat>();
  let skipped = 0;
  let skippedChampionStats = 0;
  if (!Array.isArray(raw)) {
    throw new Error("parseStatsList: expected a JSON array");
  }
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) {
      skipped++;
      continue;
    }
    const augmentId = String(entry[0]);
    // The stats blob is reliably element 1 (true even for the observed length-5
    // entry, whose trailing elements are metadata); fall back to the first
    // string after the id if element 1 is not a string. A wrong pick fails
    // validation below and is skipped, never coerced.
    const blob = (
      typeof entry[1] === "string"
        ? entry[1]
        : entry.find((e, i) => i > 0 && typeof e === "string")
    ) as string | undefined;
    if (!augmentId || !/^\d+$/.test(augmentId) || !blob) {
      skipped++;
      continue;
    }
    try {
      const parsed = JSON.parse(blob) as Record<string, unknown>;
      const rawWinRate = parsed.win_rate;
      const numGames = parsed.num_games;
      const tierRaw = parsed.tier;
      if (
        typeof rawWinRate !== "string" ||
        typeof numGames !== "string" ||
        typeof tierRaw !== "string"
      ) {
        skipped++;
        continue;
      }
      const tier = parseNumericTier(tierRaw); // throws on malformed → caught
      const globalStat: AramggStat = {
        augmentId,
        rawWinRate,
        winRatePercent: decimalShiftPercent(rawWinRate), // throws → caught
        numGames,
        pickRate: typeof parsed.pick_rate === "string" ? parsed.pick_rate : "",
        tier,
        tierLetter: TIER_LETTER_BY_NUM[tier],
        grade: GRADE_BY_NUM[tier],
        provenance: "global",
        championId: null,
        championRank: null,
        topChampionsById: new Map(),
      };

      if (Array.isArray(parsed.top_champions)) {
        for (const candidate of parsed.top_champions) {
          if (candidate === null || typeof candidate !== "object") {
            skippedChampionStats++;
            continue;
          }
          try {
            const champion = candidate as Record<string, unknown>;
            const championId = String(champion.champion_id ?? "");
            const championRank = String(champion.champion_rank ?? "");
            const championWinRate = champion.win_rate;
            const championNumGames = champion.num_games;
            const championTierRaw = champion.tier;
            if (
              !/^\d+$/.test(championId) ||
              championRank.length === 0 ||
              typeof championWinRate !== "string" ||
              typeof championNumGames !== "string" ||
              typeof championTierRaw !== "string"
            ) {
              skippedChampionStats++;
              continue;
            }
            const championTier = parseNumericTier(championTierRaw);
            globalStat.topChampionsById.set(championId, {
              augmentId,
              rawWinRate: championWinRate,
              winRatePercent: decimalShiftPercent(championWinRate),
              numGames: championNumGames,
              pickRate: typeof champion.pick_rate === "string" ? champion.pick_rate : "",
              tier: championTier,
              tierLetter: TIER_LETTER_BY_NUM[championTier],
              grade: GRADE_BY_NUM[championTier],
              provenance: "champion",
              championId,
              championRank,
              topChampionsById: new Map(),
            });
          } catch {
            skippedChampionStats++;
          }
        }
      }

      stats.set(augmentId, globalStat);
    } catch {
      skipped++;
    }
  }
  return { stats, skipped, skippedChampionStats };
}

// NOTE: the former `selectAramggStat` / `selectAramggStatsForChampion`
// (the reversed global-stat → sparse top_champions model) were removed with the
// global-fallback policy change — this overlay reads champion-specific data only
// via the complete per-champion file (see championStats.ts / championDataset.ts).

// ─── Pure: build catalog index ───

export function buildCatalogIndex(catalog: unknown): AramggCatalogIndex {
  const entries = new Map<string, AramggCatalogEntry>();
  const byIconBase = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const byCanonicalName = new Map<string, string[]>();
  if (catalog === null || typeof catalog !== "object") {
    throw new Error("buildCatalogIndex: expected a JSON object");
  }
  for (const [augmentId, value] of Object.entries(catalog as Record<string, unknown>)) {
    if (!/^\d+$/.test(augmentId) || value === null || typeof value !== "object") {
      continue;
    }
    const rec = value as Record<string, unknown>;
    const iconBase = normalizeIconBase(
      (typeof rec.iconLarge === "string" && rec.iconLarge) ||
        (typeof rec.iconSmall === "string" && rec.iconSmall) ||
        null,
    );
    const displayName = typeof rec.displayName === "string" ? rec.displayName : null;
    const canonicalName = typeof rec.name === "string" ? rec.name : null;
    entries.set(augmentId, { augmentId, canonicalName, displayName, iconBase });
    if (iconBase) byIconBase.set(iconBase, [...(byIconBase.get(iconBase) ?? []), augmentId]);
    const nn = normalizeName(displayName);
    if (nn) byName.set(nn, [...(byName.get(nn) ?? []), augmentId]);
    const cn = normalizeName(canonicalName);
    if (cn) byCanonicalName.set(cn, [...(byCanonicalName.get(cn) ?? []), augmentId]);
  }
  return { entries, byIconBase, byName, byCanonicalName };
}

// ─── Pure: resolve a League/CDragon augment identity → ARAMGG augmentId ───

/**
 * Matching priority (never silently accepts an ambiguous localized name):
 *   1. numeric canonical augment ID — Mayhem augment data carries none, so
 *      unavailable from the caller; the loop begins at priority 2.
 *   2. language-independent identity: the ARAM_* canonical name if the caller
 *      supplies one, else the normalized CDragon icon-asset base. An icon base
 *      shared by >1 augmentId is ambiguous → disambiguated only by an exact
 *      localized-name tie-break, otherwise rejected.
 *   3. normalized localized display name — explicitly-logged last resort.
 */
export function resolveAugmentId(
  input: {
    numericId?: string | null;
    canonicalName?: string | null;
    iconBase?: string | null;
    localizedName?: string | null;
  },
  index: AramggCatalogIndex,
): AramggResolution | AramggResolutionFailure {
  // Priority 1: numeric canonical augment ID (direct catalog key).
  if (input.numericId && index.entries.has(String(input.numericId))) {
    return { augmentId: String(input.numericId), method: "canonical-name" };
  }
  // Priority 2a: ARAM_* canonical name (language-independent).
  const cn = normalizeName(input.canonicalName);
  if (cn) {
    const ids = index.byCanonicalName.get(cn);
    if (ids && ids.length === 1) return { augmentId: ids[0], method: "canonical-name" };
  }
  // Priority 2b: CDragon icon-asset base (language-independent).
  if (input.iconBase) {
    const ids = index.byIconBase.get(input.iconBase);
    if (ids && ids.length === 1) {
      return { augmentId: ids[0], method: "cdragon-icon" };
    }
    if (ids && ids.length > 1) {
      const nn = normalizeName(input.localizedName);
      const tie = nn
        ? ids.filter((id) => normalizeName(index.entries.get(id)?.displayName) === nn)
        : [];
      if (tie.length === 1) {
        return { augmentId: tie[0], method: "cdragon-icon+zh-tiebreak" };
      }
      return {
        augmentId: null,
        reason: "ambiguous-icon",
        detail: `${ids.length} augmentIds share icon base "${input.iconBase}"`,
      };
    }
  }
  // Priority 3: localized display-name last resort (logged by the caller).
  const nn = normalizeName(input.localizedName);
  if (nn) {
    const ids = index.byName.get(nn);
    if (ids && ids.length === 1) return { augmentId: ids[0], method: "localized-name" };
    if (ids && ids.length > 1) {
      return {
        augmentId: null,
        reason: "ambiguous-name",
        detail: `${ids.length} augmentIds share localized name`,
      };
    }
  }
  return { augmentId: null, reason: "unmatched" };
}

// ─── Async: load the live ARAMGG source ───

/** The four raw JSON payloads — plain, fully serializable (cacheable). */
export interface AramggRaws {
  stats: unknown;
  catalog: unknown;
  catalogZhTw: unknown;
  changelog: unknown;
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`ARAMGG fetch failed: ${url} → HTTP ${res.status}`);
  }
  return res.json();
}

/** Fetch all four ARAMGG files through the dev proxy. Throws on any HTTP error. */
export async function fetchAramggRaws(
  fetchImpl: typeof fetch = fetch,
): Promise<AramggRaws> {
  const url = (path: string) => `${ARAMGG_DEV_PROXY_PREFIX}${path}`;
  const [stats, catalog, catalogZhTw, changelog] = await Promise.all([
    fetchJson(fetchImpl, url(ARAMGG_SOURCE.stats)),
    fetchJson(fetchImpl, url(ARAMGG_SOURCE.catalog)),
    fetchJson(fetchImpl, url(ARAMGG_SOURCE.catalogZhTw)),
    fetchJson(fetchImpl, url(ARAMGG_SOURCE.changelog)),
  ]);
  return { stats, catalog, catalogZhTw, changelog };
}

/**
 * Parse raw ARAMGG payloads into a resolved source. Fails EXPLICITLY (throws)
 * on any parse failure — the caller surfaces the diagnostic and stops; it must
 * never substitute invented or local statistics.
 */
export function parseAramggSource(raws: AramggRaws, fetchedAt: number): AramggSource {
  const {
    stats: statsRaw,
    catalog: catalogRaw,
    catalogZhTw: catalogZhTwRaw,
    changelog: changelogRaw,
  } = raws;

  const { stats } = parseStatsList(statsRaw);
  if (stats.size === 0) {
    throw new Error("ARAMGG stats parsed to zero valid records");
  }
  const catalog = buildCatalogIndex(catalogRaw);
  if (catalog.entries.size === 0) {
    throw new Error("ARAMGG catalog parsed to zero valid entries");
  }
  const titleIndex = buildRiotTitleIndex(catalogZhTwRaw, catalogRaw);
  if (titleIndex.byZhTwName.size === 0) {
    throw new Error("Riot zh-TW catalog parsed to zero localized titles");
  }
  const patch =
    changelogRaw !== null &&
    typeof changelogRaw === "object" &&
    typeof (changelogRaw as Record<string, unknown>).latest === "string"
      ? ((changelogRaw as Record<string, unknown>).latest as string)
      : "unknown";

  return {
    statsById: stats,
    catalog,
    titleIndex,
    patch,
    fetchedAt,
    sourceUrls: {
      stats: `${ARAMGG_SOURCE.origin}${ARAMGG_SOURCE.stats}`,
      catalog: `${ARAMGG_SOURCE.origin}${ARAMGG_SOURCE.catalog}`,
      catalogZhTw: `${ARAMGG_SOURCE.origin}${ARAMGG_SOURCE.catalogZhTw}`,
      changelog: `${ARAMGG_SOURCE.origin}${ARAMGG_SOURCE.changelog}`,
    },
  };
}

/**
 * Fetch and parse all three ARAMGG files. Fails EXPLICITLY (throws) on any
 * retrieval or parse failure — the caller surfaces the diagnostic and stops.
 */
export async function loadAramggSource(
  fetchImpl: typeof fetch = fetch,
): Promise<AramggSource> {
  return parseAramggSource(await fetchAramggRaws(fetchImpl), Date.now());
}
