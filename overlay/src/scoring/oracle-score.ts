/**
 * Oracle Score algorithm — ported from oracle_ghost.py
 *
 * Computes a composite score for an augment in the context of a specific champion
 * and the augments already picked in earlier rounds.
 *
 * score = champion_wr + set_tier_bonus + combo_bonus + trap_penalty
 *       + rarity_bonus + system_breaker_bonus
 *       + ability_type_synergy + attack_type_synergy + cc_synergy
 *       + mechanical_interaction
 */

import { SCORE_WEIGHTS, type AbilityProfile, type ChampionTag } from "./types";

export type AugmentRarity = "prismatic" | "gold" | "silver";
export type ComboTier = "S" | "A" | "B" | "C";
export type MechanicalInteractionType = "synergy" | "trap";

export interface MechanicalInteractionScoreSignal {
  type: MechanicalInteractionType;
  strength: 1 | 2 | 3;
}

export interface ScoredAugment {
  slug: string;
  name: string;
  type?: "ability" | "quest" | "standalone";
  name_zh_CN?: string;
  name_zh_TW?: string;
  name_ja?: string;
  name_ko?: string;
  rarity: AugmentRarity;
  win_rate: number | null;
  icon: string;
  set?: string;
  wikiSet?: string;
  description?: string;
  wikiDescription?: string;
  notes?: string[];
  kit_tags?: ChampionTag[];
  availability?: { status?: string };
  flags?: {
    system_breaker?: boolean;
    lifecycle?: string;
    /** Patch of an OBSERVED lifecycle transition. Absent when undated. */
    lifecycle_patch?: string;
    /** Which transition that patch refers to ("added" | "removed"). */
    lifecycle_event?: string;
  };
}

export interface OracleScoreInput {
  augment: ScoredAugment;
  /** Champion win rate (0–100), e.g. 56.29 */
  championWinRate?: number;
  /** Combo tier for this augment × champion pair, if known */
  comboTier?: ComboTier;
  /** Whether this augment is a system breaker (qualitative change / 質變增幅) */
  isSystemBreaker?: boolean;
  /** Champion ability profile from CommunityDragon */
  abilityProfile?: AbilityProfile;
  /** Strongest structured champion-kit interaction for this augment */
  mechanicalInteraction?: MechanicalInteractionScoreSignal;
  /** 26.12 ability/quest augment fit signal (see ability-augment-fit.ts) */
  abilityAugmentFit?: { strength: number };
}

export interface OracleScoreResult {
  total: number;
  breakdown: {
    championWr: number;
    tierBonus: number;
    comboBonus: number;
    trapPenalty: number;
    rarityBonus: number;
    systemBreakerBonus: number;
    abilityTypeSynergy: number;
    attackTypeSynergy: number;
    ccSynergy: number;
    tagMismatch: number;
    mechanicalInteraction: number;
    abilityAugmentFit: number;
  };
}

/** Detect what type of champion/playstyle an augment prefers from its description. */
function detectAugmentProfile(description: string): {
  prefersAP: boolean;
  prefersAD: boolean;
  prefersRanged: boolean;
  prefersMelee: boolean;
  enhancesCC: boolean;
  prefersTank: boolean;
} {
  const d = description.toLowerCase();
  // Conversion phrases flip the audience: "become ranged" targets melee, "become melee" targets ranged.
  const becomeMelee = /\bbecome melee\b/.test(d);
  const becomeRanged = /\bbecome ranged\b/.test(d);
  // Stat-conversion augments mention both source and target stats but only benefit one damage type.
  // Detect direction so we don't double-signal synergy for the source stat.
  const convertsApToAd = /(?:convert[sd]?|turn[sd]?)\b[^.]*(?:ability\s+power|\bap\b)[^.]*(?:attack\s+damage|\bad\b)/.test(d) ||
    /(?:ability\s+power|\bap\b)\s+(?:is\s+)?(?:converted|turned)\s+into\s+(?:attack\s+damage|\bad\b)/.test(d);
  const convertsAdToAp = /(?:convert[sd]?|turn[sd]?)\b[^.]*(?:attack\s+damage|\bad\b)[^.]*(?:ability\s+power|\bap\b)/.test(d) ||
    /(?:attack\s+damage|\bad\b)\s+(?:is\s+)?(?:converted|turned)\s+into\s+(?:ability\s+power|\bap\b)/.test(d);
  return {
    // For conversion augments, only signal the output stat so the source stat doesn't inflate synergy.
    prefersAP:     convertsAdToAp || (!convertsApToAd && /magic damage|ability power|\bap\b|spell damage/.test(d)),
    prefersAD:     convertsApToAd || (!convertsAdToAp && /attack damage|physical damage|\bad\b|attack speed|on-hit|auto-attack/.test(d)),
    prefersRanged: (/\branged\b/.test(d) && !becomeRanged) || becomeMelee,
    prefersMelee:  (/\bmelee\b/.test(d) && !becomeMelee) || becomeRanged,
    enhancesCC:    /crowd control|immobiliz|stun|root|\bslow\b/.test(d),
    prefersTank:   /bonus health|maximum health|bonus armor|bonus magic resist|increased size/.test(d),
  };
}

export function computeOracleScore(input: OracleScoreInput): OracleScoreResult {
  const {
    augment,
    championWinRate,
    comboTier,
    isSystemBreaker = false,
    abilityProfile,
    mechanicalInteraction: interactionSignal,
    abilityAugmentFit: fitSignal,
  } = input;

  // Validate rarity — malformed JSON can supply an unknown string, which would make
  // TIER_BONUS and RARITY_BONUS return undefined and silently corrupt the total.
  const rawRarity = augment.rarity;
  const safeRarity: AugmentRarity =
    rawRarity === "prismatic" || rawRarity === "gold" || rawRarity === "silver"
      ? rawRarity
      : "silver";

  // Validate comboTier — unknown values should produce no combo/trap effect rather than
  // silently losing the bonus (A/B tiers currently have no bonus, but bad data should not
  // be indistinguishable from valid A/B input).
  const safeComboTier: ComboTier | undefined =
    comboTier === "S" || comboTier === "A" || comboTier === "B" || comboTier === "C"
      ? comboTier
      : undefined;

  // Use augment's own win rate as base (not champion WR which is constant per champ).
  // Reject NaN/Infinity from malformed data so they can't propagate into total scores.
  // 26.12 preview neutrality: newly added augments launch without telemetry —
  // their 0/null win_rate means "no data", not "loses every game".
  const isPreviewWinRate =
    augment.flags?.lifecycle === "added" &&
    (augment.win_rate === 0 || augment.win_rate === null);
  const baseScore =
    !isPreviewWinRate &&
    typeof augment.win_rate === "number" &&
    Number.isFinite(augment.win_rate)
      ? augment.win_rate
      : 50;
  // Champion WR as minor adjustment: +-2 pts max around 50% baseline
  const wr = typeof championWinRate === "number" && Number.isFinite(championWinRate) ? championWinRate : 50;
  const championAdj = (wr - 50) * 0.1;
  const championWr = baseScore + championAdj;
  const tierBonus = SCORE_WEIGHTS.TIER_BONUS[safeRarity] ?? 0;
  const rarityBonus = SCORE_WEIGHTS.RARITY_BONUS[safeRarity] ?? 0;

  const comboBonus =
    safeComboTier === "S" ? SCORE_WEIGHTS.STRONG_COMBO_BONUS : 0;
  const trapPenalty =
    safeComboTier === "C" ? SCORE_WEIGHTS.TRAP_PENALTY : 0;

  const systemBreakerBonus = isSystemBreaker
    ? SCORE_WEIGHTS.SYSTEM_BREAKER_BONUS
    : 0;
  const interactionStrength =
    interactionSignal?.strength === 1 ||
    interactionSignal?.strength === 2 ||
    interactionSignal?.strength === 3
      ? interactionSignal.strength
      : 0;
  const mechanicalInteraction =
    interactionSignal?.type === "synergy"
      ? interactionStrength * SCORE_WEIGHTS.MECHANICAL_INTERACTION_PER_STRENGTH
      : interactionSignal?.type === "trap"
        ? -interactionStrength * SCORE_WEIGHTS.MECHANICAL_INTERACTION_PER_STRENGTH
        : 0;

  const rawFitStrength = fitSignal?.strength ?? 0;
  const fitStrength = Number.isFinite(rawFitStrength)
    ? Math.max(-3, Math.min(3, Math.trunc(rawFitStrength)))
    : 0;
  const abilityAugmentFit =
    fitStrength * SCORE_WEIGHTS.ABILITY_AUGMENT_FIT_PER_STRENGTH;

  // ���─ Ability profile synergy bonuses ──
  let abilityTypeSynergy = 0;
  let attackTypeSynergy = 0;
  let ccSynergy = 0;
  let tagMismatch = 0;

  const scoringText = `${augment.wikiDescription ?? ""} ${augment.description ?? ""}`.trim();
  if (abilityProfile && scoringText) {
    const aug = detectAugmentProfile(scoringText);

    // ── Positive synergy: augment matches champion's profile ──
    if (
      (aug.prefersAP && abilityProfile.damageType === "magic") ||
      (aug.prefersAD && abilityProfile.damageType === "physical")
    ) {
      abilityTypeSynergy = SCORE_WEIGHTS.ABILITY_TYPE_SYNERGY;
    }

    if (
      (aug.prefersRanged && abilityProfile.attackType === "ranged") ||
      (aug.prefersMelee && abilityProfile.attackType === "melee")
    ) {
      attackTypeSynergy = SCORE_WEIGHTS.ATTACK_TYPE_SYNERGY;
    }

    if (aug.enhancesCC && abilityProfile.playstyle.crowdControl >= 3) {
      ccSynergy = SCORE_WEIGHTS.CC_SYNERGY;
    }

    // ── Negative penalty: augment clearly mismatches champion ──
    // Pure AD augment for pure magic champion (or vice versa)
    // Mixed-damage champions get no penalty (they use both)
    if (abilityProfile.damageType !== "mixed") {
      if (aug.prefersAD && !aug.prefersAP && abilityProfile.damageType === "magic") {
        tagMismatch = SCORE_WEIGHTS.TAG_MISMATCH_PENALTY;
      }
      if (aug.prefersAP && !aug.prefersAD && abilityProfile.damageType === "physical") {
        tagMismatch = SCORE_WEIGHTS.TAG_MISMATCH_PENALTY;
      }
    }

    // Attack type mismatch (augment prefers ranged but champion is melee, etc.).
    // Penalty is negative — use Math.min so an existing damage-type penalty isn't erased back to 0.
    if (
      (aug.prefersRanged && !aug.prefersMelee && abilityProfile.attackType === "melee") ||
      (aug.prefersMelee && !aug.prefersRanged && abilityProfile.attackType === "ranged")
    ) {
      tagMismatch = Math.min(tagMismatch, SCORE_WEIGHTS.TAG_MISMATCH_PENALTY);
    }
  }

  const breakdown = {
    championWr,
    tierBonus,
    comboBonus,
    trapPenalty,
    rarityBonus,
    systemBreakerBonus,
    abilityTypeSynergy,
    attackTypeSynergy,
    ccSynergy,
    tagMismatch,
    mechanicalInteraction,
    abilityAugmentFit,
  };

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  return { total, breakdown };
}

/**
 * Baseline Oracle Score for an augment with no champion context.
 * Useful for sorting augments on the catalog page.
 * Uses the augment's global win rate as the champion_wr term.
 */
export function baselineOracleScore(augment: ScoredAugment): number {
  const result = computeOracleScore({
    augment,
    championWinRate: augment.win_rate ?? 50,
  });
  return Math.round(result.total * 10) / 10;
}
