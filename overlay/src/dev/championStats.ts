/**
 * DEVELOPMENT-ONLY champion-FIRST augment dataset model (PR #46 corrected).
 *
 * The correct relationship the overlay must answer is:
 *
 *   final in-game champion → canonical numeric Riot champion ID →
 *   that champion's complete ARAMGG augment table (/en/champion-stats/{id}) →
 *   offered augment canonical ID → champion-specific tier and win rate.
 *
 * This REPLACES the reversed `augmentId → global stat → topChampionsById`
 * model. ARAMGG embeds each champion's own augment table in the server-rendered
 * champion page as a Next.js flight payload:
 *
 *   {"augments":{"<augmentId>":{"tier","rank","win_rate","num_games",
 *     "pick_rate",...}}, "tier","win_rate",...}
 *
 * keyed by the SAME canonical numeric augment ID used by the catalog and the
 * global stats. `top_champions` is never consulted here: it answers "which
 * champions perform well for this augment", not "how does each offered augment
 * perform for this champion".
 *
 * Only pure functions live here so parsing/lookup/selection is unit-testable
 * without a browser. Global augment statistics remain available ONLY as an
 * explicitly-labeled `GLOBAL` fallback (see `selectAugmentStat`).
 */
import type { AramggStat } from "./aramggSource";
import { numericTierToGrade, numericTierToLetter, parseNumericTier } from "./aramggSource";
import type { TierLetter } from "../model/tier";
import { decimalShiftPercent } from "../winRateFormat";

// ─── Types (Section 2 model) ───

export interface ChampionAugmentStat {
  championId: string;
  augmentId: string;
  rawWinRate: string;
  winRatePercent: string;
  rawPickRate: string | null;
  pickRatePercent: string | null;
  tier: number;
  tierLetter: TierLetter;
  rank: number | null;
  numGames: string | null;
  patch: string | null;
}

export interface ChampionAugmentDataset {
  championId: string;
  patch: string | null;
  /** Provenance URL, e.g. https://aramgg.com/data/champion-augments/56.json. */
  source: string;
  /**
   * `complete` = the authoritative per-champion augment file (every augment this
   * champion has data for). `partial` = a subset (e.g. the champion page's
   * embedded top-augments table) that must NOT be read as proof of absence.
   */
  completeness: "partial" | "complete";
  /** Number of augment rows actually loaded (diagnostic + completeness signal). */
  loadedCount: number;
  statsByAugmentId: Map<string, ChampionAugmentStat>;
}

// ─── Parse one champion's embedded augment table ───

/** A single ARAMGG per-champion augment row is a record of decimal strings. */
function parseRow(
  championId: string,
  augmentId: string,
  raw: Record<string, unknown>,
  patch: string | null,
): ChampionAugmentStat | null {
  const rawWinRate = raw.win_rate;
  const tierRaw = raw.tier;
  if (typeof rawWinRate !== "string" || typeof tierRaw !== "string") return null;
  let tier: number;
  let winRatePercent: string;
  try {
    tier = parseNumericTier(tierRaw);
    winRatePercent = decimalShiftPercent(rawWinRate);
  } catch {
    return null;
  }
  const rawPickRate = typeof raw.pick_rate === "string" ? raw.pick_rate : null;
  let pickRatePercent: string | null = null;
  if (rawPickRate !== null) {
    try {
      pickRatePercent = decimalShiftPercent(rawPickRate);
    } catch {
      pickRatePercent = null;
    }
  }
  const rankRaw = typeof raw.rank === "string" ? raw.rank : null;
  const rank = rankRaw !== null && /^\d+$/.test(rankRaw) ? Number(rankRaw) : null;
  const numGames = typeof raw.num_games === "string" ? raw.num_games : null;
  return {
    championId,
    augmentId,
    rawWinRate,
    winRatePercent,
    rawPickRate,
    pickRatePercent,
    tier,
    tierLetter: numericTierToLetter(tierRaw),
    rank,
    numGames,
    patch,
  };
}

/**
 * Parse a champion detail object (the flight payload's decoded object) into a
 * champion-first dataset. Malformed augment rows are skipped, never coerced.
 */
export function parseChampionAugmentDataset(
  raw: unknown,
  opts: {
    championId: string;
    patch: string | null;
    source: string;
    /** Authoritative per-champion file → "complete" (default). A page subset is "partial". */
    completeness?: "partial" | "complete";
  },
): ChampionAugmentDataset {
  if (raw === null || typeof raw !== "object") {
    throw new Error("parseChampionAugmentDataset: expected a JSON object");
  }
  const augments = (raw as Record<string, unknown>).augments;
  if (augments === null || typeof augments !== "object") {
    throw new Error("parseChampionAugmentDataset: missing `augments` table");
  }
  const statsByAugmentId = new Map<string, ChampionAugmentStat>();
  for (const [augmentId, value] of Object.entries(augments as Record<string, unknown>)) {
    if (!/^\d+$/.test(augmentId) || value === null || typeof value !== "object") continue;
    const stat = parseRow(opts.championId, augmentId, value as Record<string, unknown>, opts.patch);
    if (stat) statsByAugmentId.set(augmentId, stat);
  }
  const completeness = opts.completeness ?? "complete";
  if (completeness === "complete" && statsByAugmentId.size === 0) {
    throw new Error("parseChampionAugmentDataset: complete dataset has zero usable augment rows");
  }
  return {
    championId: opts.championId,
    patch: opts.patch,
    source: opts.source,
    completeness,
    loadedCount: statsByAugmentId.size,
    statsByAugmentId,
  };
}

/** Direct champion-first lookup: the offered augment's row in THIS champion's table. */
export function lookupChampionAugmentStat(
  dataset: ChampionAugmentDataset,
  augmentId: string,
): ChampionAugmentStat | null {
  return dataset.statsByAugmentId.get(augmentId) ?? null;
}

// ─── Champion-ONLY selection (Section 2). No global fallback exists. ───
// PRODUCT POLICY: this overlay answers only "how does this augment perform for
// the champion currently being played?". The global augment record must never
// supply a tier, win rate, rank, sample count or provenance here. Absence is
// resolved to an explicit non-stat state, never to a global value.

export interface ResolvedStat {
  /** Always CHAMP — the only valid source for this overlay. */
  label: "CHAMP";
  championId: string;
  augmentId: string;
  tier: number;
  tierLetter: TierLetter;
  rawWinRate: string;
  winRatePercent: string;
  rank: number | null;
  numGames: string | null;
}

export type AugmentStatSelection =
  /** The champion's own row for this augment. */
  | { kind: "resolved"; stat: ResolvedStat }
  /** COMPLETE dataset genuinely has no row for this augment → NO CHAMP DATA. */
  | { kind: "no-champ-data"; augmentId: string }
  /** PARTIAL dataset lacks the row: absence is unproven, keep loading. */
  | { kind: "partial-pending"; augmentId: string };

/**
 * Select one offered augment's champion-specific statistic. There is NO global
 * fallback: a row present in this champion's table resolves; an absent row on a
 * COMPLETE dataset is NO CHAMP DATA; an absent row on a PARTIAL dataset is
 * unproven absence (`partial-pending`) and must keep loading, never publish
 * NO CHAMP DATA and never substitute a global value.
 */
export function selectAugmentStat(
  dataset: ChampionAugmentDataset,
  augmentId: string,
): AugmentStatSelection {
  const champ = lookupChampionAugmentStat(dataset, augmentId);
  if (champ) {
    return {
      kind: "resolved",
      stat: {
        label: "CHAMP",
        championId: champ.championId,
        augmentId: champ.augmentId,
        tier: champ.tier,
        tierLetter: champ.tierLetter,
        rawWinRate: champ.rawWinRate,
        winRatePercent: champ.winRatePercent,
        rank: champ.rank,
        numGames: champ.numGames,
      },
    };
  }
  if (dataset.completeness === "complete") return { kind: "no-champ-data", augmentId };
  return { kind: "partial-pending", augmentId };
}

/**
 * The published slot statistic status the render path maps to a chip. There is
 * no "global" outcome — the four states are the ONLY things a badge can be:
 *   resolved (champion row) · loading · no-champ-data · error.
 */
export type ChampionSlotStat =
  | { status: "resolved"; stat: ResolvedStat }
  | { status: "loading" }
  | { status: "no-champ-data" }
  | { status: "error" };

/**
 * Decide one slot's statistic from the champion dataset load status alone. No
 * global input exists. `dataset` must already be the ACTIVE champion's dataset
 * (champion id + patch matched) or null. Absence on a complete dataset is
 * no-champ-data; absence on a partial dataset (or no dataset yet) is loading;
 * a fetch error is error — never a global value.
 */
export function selectChampionSlotStat(
  dataStatus: "idle" | "loading" | "ready" | "error",
  dataset: ChampionAugmentDataset | null,
  augmentId: string,
): ChampionSlotStat {
  if (dataStatus === "error") return { status: "error" };
  if (!dataset) return { status: "loading" };
  const sel = selectAugmentStat(dataset, augmentId);
  if (sel.kind === "resolved") return { status: "resolved", stat: sel.stat };
  if (sel.kind === "no-champ-data") return { status: "no-champ-data" };
  return { status: "loading" }; // partial-pending: absence unproven
}

/**
 * Adapt a champion-resolved statistic to the `AramggStat` shape the render path
 * consumes. Provenance is ALWAYS "champion" — this overlay never publishes a
 * global-sourced statistic. Tier and win rate originate from the one champion
 * record.
 */
export function resolvedStatToAramggStat(sel: ResolvedStat): AramggStat {
  return {
    augmentId: sel.augmentId,
    rawWinRate: sel.rawWinRate,
    winRatePercent: sel.winRatePercent,
    numGames: sel.numGames ?? "0",
    pickRate: "",
    tier: sel.tier,
    tierLetter: sel.tierLetter,
    grade: numericTierToGrade(String(sel.tier)),
    provenance: "champion",
    championId: sel.championId,
    championRank: sel.rank !== null ? String(sel.rank) : null,
    topChampionsById: new Map(),
  };
}

// ─── Extract the embedded champion detail object from the page flight ───

/**
 * Pull the `{"augments":{…}, …}` champion detail object out of a server-rendered
 * champion page. Handles both the escaped form embedded in HTML
 * (`self.__next_f.push([1,"…\\"augments\\"…"])`) and the raw RSC flight stream
 * (`text/x-component`, unescaped JSON). Returns null when no augments block is
 * present. Never throws on malformed surrounding text — brace-balances the
 * first `{"augments"` object and JSON-parses exactly that slice.
 */
export function extractChampionFlightObject(pageText: string): unknown {
  if (typeof pageText !== "string" || pageText.length === 0) return null;
  // Escaped HTML form: decode the JS string literal region first.
  const escapedAt = pageText.indexOf('{\\"augments\\"');
  let text = pageText;
  if (escapedAt !== -1) {
    text = pageText.slice(escapedAt).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const start = text.indexOf('{"augments"');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
