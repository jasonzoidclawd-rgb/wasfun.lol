/**
 * The Pick grid's pool: every live augment the game can offer a champion.
 *
 * Letters are graded across all champions, so a champion's grid is the whole
 * live rarity minus only what the game will not offer that champion. The
 * rules kept are the documented ones (GAME_MECHANICS.md): attack-type
 * augments (ranged-only, "become melee/ranged"), mana augments for champions
 * without mana, and ability augments the champion cannot use. Usefulness
 * guesses (hard CC, dashes, spins, heals, caster or AD fit, kit-tag overlap)
 * weight what Smart Tailoring shows; they do not make an augment impossible,
 * so they never hide a card here.
 */
import { abilityAugmentFit } from "@/lib/scoring/ability-augment-fit";
import { buildPoolProfile, isInAugmentPool, type ChampionPoolProfile } from "@/lib/scoring/augment-tailoring";
import { getChampionAugmentPool, type PoolAugmentInput } from "@/lib/scoring/pool-orchestrator";
import type { AbilityProfile, ChampionBaseStats, PoolRules } from "@/lib/types";

export type OfferExclusion = "attack-type-or-mana" | "mana-tag" | "ability-unusable";

/** Rules that are about usefulness, not about what the game offers. */
const FIT_LAYERS = new Set(["hard-exclusion", "ability-ineligible", "resource-mismatch", "tag-mismatch"]);

/** A profile under which only the attack-type and mana rules of isInAugmentPool can fire. */
function offerRulesOnly(profile: ChampionPoolProfile): ChampionPoolProfile {
  return {
    ...profile,
    hasHardCC: true,
    hasDash: true,
    hasSpinning: true,
    hasHealShield: true,
    hasOnHit: true,
    damageType: "mixed",
    totalApRatio: 1,
    totalAdRatio: 1,
  };
}

export function offerPool<T extends PoolAugmentInput>(args: {
  championSlug: string;
  augments: T[];
  abilityProfile?: AbilityProfile;
  baseStats?: ChampionBaseStats;
  poolRules: PoolRules;
  /**
   * catalog slugs the statistics source observes as live on the current patch:
   * that observation beats a stale catalog status (an augment being taken in
   * today's games is being offered)
   */
  observedLive?: ReadonlySet<string>;
}): { offered: T[]; excluded: { slug: string; reason: OfferExclusion }[] } {
  const { championSlug, augments, abilityProfile, baseStats, poolRules, observedLive } = args;
  // availability only: the orchestrator's non-offerable statuses, disabled and removed
  const unavailable = new Set(
    getChampionAugmentPool({ championSlug, augments, abilityProfile, baseStats, championKitTags: [], poolRules })
      .excluded.filter((e) => !FIT_LAYERS.has(e.reason) && !observedLive?.has(e.slug))
      .map((e) => e.slug),
  );
  const profile = offerRulesOnly(buildPoolProfile(championSlug, abilityProfile, baseStats));
  const offered: T[] = [];
  const excluded: { slug: string; reason: OfferExclusion }[] = [];
  for (const aug of augments) {
    if (unavailable.has(aug.slug)) continue;
    if (!isInAugmentPool({ slug: aug.slug, description: aug.wikiDescription ?? "" }, profile)) {
      excluded.push({ slug: aug.slug, reason: "attack-type-or-mana" });
      continue;
    }
    if ((aug.kit_tags ?? []).includes("mana") && profile.resource !== "mana") {
      excluded.push({ slug: aug.slug, reason: "mana-tag" });
      continue;
    }
    if (aug.type === "ability") {
      const fit = abilityAugmentFit({ slug: aug.slug, type: aug.type, wikiDescription: aug.wikiDescription }, abilityProfile);
      if (fit && fit.strength < 0) {
        excluded.push({ slug: aug.slug, reason: "ability-unusable" });
        continue;
      }
    }
    offered.push(aug);
  }
  return { offered, excluded };
}
