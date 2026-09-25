import type {
  AugmentRound,
  DecisionCandidateResult,
  DecisionResult,
} from "../../contracts/decision";
import type { TierLetter } from "../../model/tier";

export function isTierFixtureEnabled(): boolean {
  return false;
}

export interface AramggFixtureCard {
  slug: string;
  stat: {
    augmentId: string;
    grade: DecisionCandidateResult["grade"];
    winRatePercent: string;
    rawWinRate: string;
    numGames: string;
    tier: number;
    tierLetter: TierLetter;
    provenance: "global" | "champion";
    championId: string | null;
    championRank: string | null;
    topChampionsById: Map<string, AramggFixtureCard["stat"]>;
  };
  method: string;
}

export interface AramggDebugRow {
  slug: string;
  augmentId: string;
  method: string;
  rawWinRate: string;
  winRatePercent: string;
  numGames: string;
  upstreamTier: number;
  cardTier: TierLetter;
  statProvenance: "global" | "champion";
  championId: string | null;
}

export interface AramggFixturePayload {
  result: DecisionResult;
  winRateDisplayBySlug: Record<string, string | null>;
  debugRows: AramggDebugRow[];
}

export function aramggStatScopeLabel(
  stat: { provenance: "champion" | "global" },
): "CHAMP" | "GLOBAL" {
  return stat.provenance === "champion" ? "CHAMP" : "GLOBAL";
}

export function buildAramggDecisionResult(
  _cards: AramggFixtureCard[],
  _round: AugmentRound,
): AramggFixturePayload {
  void _cards;
  void _round;
  throw new Error("development fixture unavailable");
}
