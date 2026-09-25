/**
 * DEVELOPMENT-ONLY tier-fixture mode for evaluating PR #46's in-game tier card.
 *
 * Enabled ONLY when both hold:
 *   1. the build is a dev build (`import.meta.env.DEV`), and
 *   2. the env flag `MAYHEM_OVERLAY_TIER_FIXTURE=1` is set.
 *
 * In a production Tauri build `import.meta.env.DEV` is false, so this is inert
 * regardless of the flag. It drives the REAL local overlay badge path with
 * statistics sourced from ARAMGG (`aramggSource.ts`) without changing the
 * member snapshot or unlocking the authenticated CoachPanel. Statistics are
 * NEVER synthetic and NEVER fall back to local `augments.json`: only card
 * geometry may be injected when live OCR detection is unavailable. It does not
 * touch OCR, calibration, positioning, collector consent, or production auth.
 */
import type {
  AugmentRound,
  DecisionCandidateResult,
  DecisionResult,
} from "../contracts/decision";
import type { AramggStat, MatchMethod, RiotTitleMethod } from "./aramggSource";
import type { TierLetter } from "../model/tier";

/** Pure enable predicate — separated from `import.meta` so it is unit-testable. */
export function tierFixtureEnabledFrom(input: {
  dev: boolean;
  flag: string | undefined;
}): boolean {
  return input.dev === true && input.flag === "1";
}

export function isTierFixtureEnabled(): boolean {
  // Read Vite's statically-injected env. The cast supplies the shape so this
  // typechecks under BOTH the overlay tsconfig (vite/client types) and the
  // repo-root Next tsconfig (which excludes overlay and lacks those types but
  // still traverses this file via the test import). Runtime is unchanged.
  const env = (import.meta as unknown as {
    env: { DEV: boolean; MAYHEM_OVERLAY_TIER_FIXTURE?: string };
  }).env;
  return tierFixtureEnabledFrom({
    dev: env.DEV,
    flag: env.MAYHEM_OVERLAY_TIER_FIXTURE,
  });
}

/** One offered card resolved to its canonical ARAMGG record. */
export interface AramggFixtureCard {
  slug: string;
  stat: AramggStat;
  method: MatchMethod | RiotTitleMethod;
}

/** A debug-panel row: full provenance for one rendered card. */
export interface AramggDebugRow {
  slug: string;
  augmentId: string;
  method: MatchMethod | RiotTitleMethod;
  rawWinRate: string;
  winRatePercent: string;
  numGames: string;
  upstreamTier: number;
  cardTier: TierLetter;
  statProvenance: AramggStat["provenance"];
  championId: string | null;
}

export interface AramggFixturePayload {
  result: DecisionResult;
  /** slug → exact percentage string (never a float); missing → null. */
  winRateDisplayBySlug: Record<string, string | null>;
  debugRows: AramggDebugRow[];
}

export function aramggStatScopeLabel(
  stat: Pick<AramggStat, "provenance">,
): "CHAMP" | "GLOBAL" {
  return stat.provenance === "champion" ? "CHAMP" : "GLOBAL";
}

/**
 * Confidence reflects ARAMGG's real sample size — this is a genuine
 * reliability signal, not an invented grade. Thresholds are presentation-only.
 */
function confidenceFromGames(numGames: string): DecisionCandidateResult["confidence"] {
  const n = Number(numGames);
  if (!Number.isFinite(n) || n < 5000) return "low";
  if (n < 50000) return "medium";
  return "high";
}

function toCandidate(card: AramggFixtureCard): DecisionCandidateResult {
  const { stat } = card;
  return {
    augmentSlug: card.slug,
    grade: stat.grade,
    // Ordering signal only: parsed from the exact percent string. The DISPLAYED
    // value always comes from `winRateDisplayBySlug` (the exact string).
    score: Number(stat.winRatePercent),
    percentile: 0,
    // ARAMGG supplies no pick probability; this placeholder is NEVER rendered —
    // the badge suppresses `P:` for ARAMGG-backed candidates (no fake model %).
    probability: { initialThree: 0, withNormalRerolls: 0 },
    warnings: [],
    reasons: [
      `aramgg:tier-${stat.tier}`,
      `aramgg:games-${stat.numGames}`,
      `aramgg:match-${card.method}`,
      `aramgg:scope-${stat.provenance}`,
    ],
    confidence: confidenceFromGames(stat.numGames),
    breakdown: { reliability: 0, synergy: 0, novelty: 0, penalties: 0, roundValue: 0 },
  };
}

/**
 * Build a DecisionResult from ARAMGG records, fed straight into the real PR #46
 * render path. Grade is derived from the upstream numeric tier so the real
 * `tierForGrade` presentation reproduces the relabeled ARAMGG tier (1→S+…5→C).
 */
export function buildAramggDecisionResult(
  cards: AramggFixtureCard[],
  round: AugmentRound,
): AramggFixturePayload {
  const winRateDisplayBySlug: Record<string, string | null> = {};
  const debugRows: AramggDebugRow[] = [];
  const candidates = cards.map((card) => {
    winRateDisplayBySlug[card.slug] = card.stat.winRatePercent;
    debugRows.push({
      slug: card.slug,
      augmentId: card.stat.augmentId,
      method: card.method,
      rawWinRate: card.stat.rawWinRate,
      winRatePercent: card.stat.winRatePercent,
      numGames: card.stat.numGames,
      upstreamTier: card.stat.tier,
      cardTier: card.stat.tierLetter,
      statProvenance: card.stat.provenance,
      championId: card.stat.championId,
    });
    return toCandidate(card);
  });

  return {
    winRateDisplayBySlug,
    debugRows,
    result: {
      modelVersion: "ARAMGG tier-fixture (dev only — upstream tier relabeled)",
      context: {
        championSlug: "fixture",
        round,
        screenRarity: "silver",
        mode: "competitive",
        ownedAugmentSlugs: [],
        currentItemIds: [],
        plannedItemIds: [],
        rerollsRemaining: 1,
        goldenRerollAvailable: false,
      },
      poolSize: candidates.length,
      candidates,
      reroll: { stance: "keep", reasons: ["aramgg-tier-fixture"] },
    },
  };
}
