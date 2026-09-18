// ─── Core data types for Mayhem Oracle ───
// These mirror the JSON cache structure from the data pipeline.

export type ChampionRole =
  | "assassin"
  | "fighter"
  | "mage"
  | "marksman"
  | "support"
  | "tank";

export type Tier = "god" | "strong" | "good" | "average" | "weak";

export type AugmentRarity = "prismatic" | "gold" | "silver";

/** 26.12 augment classes — ability/quest augments get dedicated scoring treatment. */
export type AugmentType = "ability" | "quest" | "standalone";

export interface Champion {
  id: string;           // e.g. "brand", "drmundo"
  name: string;         // English canonical name
  nameZh?: string;      // 繁體中文 name
  nameZhCn?: string;    // 简体中文 name
  nameJa?: string;      // 日本語 name
  nameKo?: string;      // 한국어 name
  iconId: number;       // CommunityDragon champion icon ID
  role: ChampionRole;
  tags: ChampionTag[];  // for Smart Tailoring pool filtering
  tier: Tier;
  rank: number;
  winRate: number;      // percentage, e.g. 56.29
  pickRate: number;     // percentage
  oracleScore: number;  // composite augment synergy score (average case)
  ceilingScore?: number;// best-case score if system breakers hit
  bestCombo?: string[]; // names of the dream augment combo
  comboProbability?: number; // P(assembling bestCombo) per game
}

// ─── Champion Tags (for Smart Tailoring pool filtering) ───
// These determine which augments a champion can see in their selection pool.
export type ChampionTag =
  | "attack"        // auto-attack focused
  | "ability"       // ability-damage focused
  | "on_hit"        // on-hit effect synergy
  | "crit"          // crit scaling
  | "movement"      // mobility-focused kit
  | "haste"         // cooldown-dependent
  | "tank"          // durability focused
  | "heal_shield"   // healing/shielding in kit
  | "dot"           // damage over time
  | "cc"            // crowd control heavy
  | "mana"          // uses mana resource
  | "manaless";     // no mana bar (filters OUT mana augments)

// ─── Augment Selection Mechanics ───
// Reflects the verified 3-slot independent reroll system.

export interface AugmentSelectionRound {
  round: 1 | 2 | 3 | 4;
  levelThreshold: 3 | 7 | 11 | 15;
  requiresDeath: boolean;
  tier: AugmentRarity;  // tier is synced across all 10 players
}

/** What the player sees in one selection round */
export interface AugmentSelectionState {
  round: AugmentSelectionRound;
  slots: [AugmentSlot, AugmentSlot, AugmentSlot];
}

export interface AugmentSlot {
  currentAugment: Augment;
  hasRerolled: boolean;   // each slot gets exactly 1 reroll
  previousAugment?: Augment; // what was showing before reroll
}

export interface Augment {
  id: string;
  name: string;
  nameZh?: string;
  nameZhCn?: string;
  nameJa?: string;
  nameKo?: string;
  rarity: AugmentRarity;
  type?: AugmentType;
  globalWinRate: number;
  description: string;
  setId?: string;           // augment set this belongs to
  tags: ChampionTag[];      // for Smart Tailoring matching
  isSystemBreaker: boolean; // qualitative change augment (質變增幅)
}

export interface ChampionAugment {
  augmentId: string;
  championId: string;
  winRate: number;       // champion-specific win rate with this augment
  oracleScore: number;   // computed: WR + set bonus + combo + trap penalty
  isStrong: boolean;     // from apexlol combo data
  isTrap: boolean;       // from apexlol combo data
}

export interface Combo {
  id: string;
  championId: string;
  title: string;
  description: string;
  augments: string[];    // augment IDs involved
  rating: "SS" | "S" | "A" | "B" | "C" | "D";
  type: "synergy" | "trap" | "fun" | "bug";
}

// ─── Patch notes (official Riot article + deterministic Mayhem Oracle linking) ───

export type ChangeKind =
  | "buffed"
  | "nerfed"
  | "changed"
  | "mechanism"
  | "added"
  | "removed"
  | "fixed"
  | "hotfix";

export type PatchSectionId =
  | "highlights"
  | "general"
  | "new_items"
  | "augments"
  | "champions"
  | "bugfixes"
  | string; // unknown locale-only ids tolerated

export type PatchLocale = "en" | "zh-tw" | "zh-cn" | "ja-jp" | "ko-kr";

export type PatchSourceStatus = "fresh" | "stale" | "unavailable" | "not_yet_confirmed";

export type PatchEntityType =
  | "champion"
  | "ability"
  | "augment"
  | "item"
  | "system"
  | "unknown";

export interface PatchEntityRef {
  type: PatchEntityType;
  slug: string;
  name: string;
  known: boolean;
  href?: string;
  roleTags?: string[];
  kitTags?: string[];
  categories?: string[];
  rarity?: AugmentRarity;
  availability?: string;
  lifecycle?: string;
  offerable?: boolean;
  names?: Partial<Record<PatchLocale, string>>;
  championSlug?: string;
  abilityKey?: string;
}

export interface PatchMetricChange {
  label: string;
  before: string;
  after: string;
  numericDirection?: "increase" | "decrease" | "flat";
}

export interface PatchImpact {
  damageRelevant: boolean;
  modelSignals: string[];
  engineRefs: string[];
}

export interface PatchChange {
  /** Locale-keyed subject (augment name, champion, system area). May be empty. */
  subject: Partial<Record<PatchLocale, string>>;
  /** Locale-keyed change body. en is always present. */
  text: Partial<Record<PatchLocale, string>> & { en: string };
  /** Ability/stat subheading from Riot notes, e.g. "E - Conflagration". */
  detail?: string;
  /** Official Riot context paragraph for the subject block, English canonical. */
  context?: string;
  /** Champion slug if this change targets a single champion (Champion Balance section). */
  subjectSlug?: string;
  sourceType?: "new_champion_preview" | string;
  /** Source observation timestamp from the CDragon event, not a prose claim. */
  detectedAt?: string;
  /** Same-patch CDragon change after the numbered notes were published. */
  isHotfix?: boolean;
  /** A reconciled PBE preview whose target values now exist in latest. */
  landedFromPbe?: boolean;
  kind: ChangeKind;
  targets?: PatchEntityRef[];
  relatedEntities?: PatchEntityRef[];
  metrics?: PatchMetricChange[];
  labels?: string[];
  impact?: PatchImpact;
}

export interface PatchSection {
  id: PatchSectionId;
  /** Section heading from the source page (English; locale-substituted in render via i18n). */
  title: string;
  changes: PatchChange[];
}

/**
 * Whether a patch-adjacent structural diff was actually computed for a patch.
 * "unavailable" is NOT zero changes: it means nothing was measured, so no
 * count may be rendered. Absent (legacy payloads) is treated as unavailable.
 */
export type PatchStructuredDiffState = "available" | "unavailable";

export interface PatchNote {
  version: string;          // "26.8"
  title: string;            // raw card title from source
  released: string;         // raw date string ("Released: April 14, 2026")
  sourceUrl?: string;
  publishedAt?: string;
  authors?: string[];
  intro?: string;
  structuredDiff?: PatchStructuredDiffState;
  /** Present only when `structuredDiff` is "available". */
  summary?: {
    totalChanges: number;
    byKind: Partial<Record<ChangeKind, number>>;
    byEntityType: Partial<Record<PatchEntityType, number>>;
    byLabel: Record<string, number>;
    damageRelevant: number;
  };
  sections: PatchSection[];
}

export interface PatchNotesData {
  patch: string;
  scraped_at?: string;
  status?: PatchSourceStatus;
  source: string;
  sourceKind?: string;
  sourceUrl?: string;
  patches: PatchNote[];
}

// ─── Champion ability profile (from CommunityDragon) ───

export interface AbilityStats {
  baseDamage?: number[];     // per rank [rank1..rank5]
  apRatio?: number;          // AP scaling coefficient
  adRatio?: number;          // bonus AD scaling
  totalAdRatio?: number;     // total AD scaling
  hpRatio?: number;          // HP scaling
  cooldown?: number[];       // per rank
  manaCost?: number[];       // per rank (single element = flat)
  range?: number;
  ccType?: string;           // stun, root, slow, knockup, charm, etc.
  ccDuration?: number;       // seconds
  damageType?: "magic" | "physical" | "true";
  isAoe?: boolean;
  isDot?: boolean;
  isOnHit?: boolean;
  tags?: string[];           // e.g. Trait_ImmobilizingCCSpell
  // 26.12 ability-augment fit flags (set only when true)
  projectile?: boolean;
  knockback?: boolean;
  knockup?: boolean;
  recast?: boolean;
  heal?: boolean;
  shield?: boolean;
  dash?: boolean;
  longRange?: boolean;
}

export interface AbilityEntry {
  key: "passive" | "Q" | "W" | "E" | "R";
  name: string;
  name_zh_TW?: string;
  name_zh_CN?: string;
  name_ja?: string;
  name_ko?: string;
  icon: string;
  description: string;
  description_zh_TW?: string;
  description_zh_CN?: string;
  description_ja?: string;
  description_ko?: string;
  stats?: AbilityStats;
  // Wiki-sourced detailed fields
  wikiDescription?: string;
  cost?: string;
  cooldown?: string;
  castTime?: string;
  range?: string;
  effectRadius?: string;
  width?: string;
  speed?: string;
  damageFormula?: string;
  apRatio?: string;
}

export interface AbilityProfile {
  damageType: "magic" | "physical" | "mixed";
  attackType: "ranged" | "melee";
  playstyle: {
    damage: number;       // 1–5
    durability: number;   // 1–5
    crowdControl: number; // 1–5
    mobility: number;     // 1–5
    utility: number;      // 1–5
  };
  abilities: AbilityEntry[];
}

// ─── Champion base stats (from Riot Data Dragon) ───

export interface ChampionBaseStats {
  baseHP: number;
  hpGrowth: number;
  baseArmor: number;
  armorGrowth: number;
  baseMR: number;
  mrGrowth: number;
  baseAD: number;
  adGrowth: number;
  baseAS: number;
  /** Attack speed growth as a percentage, e.g. 3.3 = 3.3% */
  asGrowth: number;
  attackRange: number;
  moveSpeed: number;
  baseMP: number;
  mpGrowth: number;
  baseHPRegen: number;
  hpRegenGrowth: number;
  baseMPRegen?: number;
  mpRegenGrowth?: number;
  missileSpeed?: number;
}

// ─── Item types ───

export type ItemTier = "starter" | "basic" | "epic" | "legendary" | "boots";

export interface Item {
  id?: number;
  /** Present on mayhemExclusive items; absent on catalog items (id >= 200 000) */
  slug?: string;
  name: string;
  name_zh_TW?: string;
  name_zh_CN?: string;
  name_ja?: string;
  name_ko?: string;
  cost: number;
  description: string;
  icon: string;
  categories?: string[];
  stats?: string;
  /** Build-path component names from the LoL wiki (standard SR values — Mayhem paths may differ) */
  recipe?: string[];
  /** Item quality tier from the LoL wiki Item list page */
  tier?: ItemTier;
  mayhemTag?: "exclusive" | "modified" | "quest-reward";
  /** @deprecated stripped by enrich_wiki.py — wiki shows standard-mode values, not Mayhem values */
  wikiStats?: string[];
  /** Passive/active blocks from the LoL wiki */
  wikiPassives?: { label: string; text: string }[];
  /** Bullet-point gameplay notes from the wiki Notes section */
  wikiNotes?: string[];
}

// ─── Structured numeric stats (parsed from wikiStats or description) ───

export interface ItemStats {
  // Offense — flat
  attackDamage?: number;
  abilityPower?: number;
  lethality?: number;
  // Offense — percent (stored as 0–1 decimals)
  armorPenPct?: number;
  magicPenFlat?: number;
  magicPenPct?: number;
  critChance?: number;
  /** Bonus crit damage multiplier addend (e.g. 0.35 for IE's "+35% bonus crit") */
  critDamage?: number;
  attackSpeed?: number;
  // Sustain (0–1 decimals)
  lifeSteal?: number;
  omnivamp?: number;
  // Utility
  abilityHaste?: number;
  moveSpeedFlat?: number;
  moveSpeedPct?: number;
  tenacity?: number;
  // Defense
  health?: number;
  armor?: number;
  magicResist?: number;
  mana?: number;
  healthRegen?: number;
  manaRegen?: number;
}

export interface DamageProfile {
  /** AD after armor mitigation vs targetArmor */
  effectiveAD: number;
  /** Single crit auto-attack physical damage */
  critAutoHit: number;
  /** Expected damage multiplier per auto (weighted by crit chance) */
  critExpectedMultiplier: number;
  /** Armor value the profile was computed against */
  targetArmor: number;
}

export interface MagicDamageProfile {
  ap: number;
  /** 100 / (100 + effectiveMR) — fraction of magic damage that gets through */
  magicMultiplier: number;
  effectiveMR: number;
  targetMR: number;
}

// ─── Augment set membership (9 Hextech Augment Synergies) ───

export type AugmentSet =
  | "Archmage" | "Dive Bomb" | "Firecracker" | "Fully Automated"
  | "High Roller" | "Make it Rain" | "Snowday" | "Stackosaurus Rex" | "Wee Woo Wee Woo";

export interface AugmentFlags {
  system_breaker: boolean;
  lifecycle: "active" | "added" | "removed";
}

export type AugmentAvailabilityStatus =
  | "confirmed_live"
  | "candidate_registry_present"
  | "disabled"
  | "removed"
  | "unverified_legacy"
  | "conflict";

// ─── Pool rules (patch-sensitive, generated by generate_pool_rules.py) ───

export interface PoolItemExclusion {
  augment: string;
  blocked_by_item: string;
}

export interface PoolAllyExclusion {
  source: string;
  skips_allies_with: string;
}

export interface PoolRules {
  patch: string;
  scraped_at: string;
  availability?: {
    offerable?: Record<string, AugmentAvailabilityStatus>;
    non_offerable?: Record<string, AugmentAvailabilityStatus | "placeholder">;
  };
  disabled: string[];
  mutually_exclusive: [string, string][];
  item_exclusions: PoolItemExclusion[];
  ally_exclusions: PoolAllyExclusion[];
  lifecycle: { added: Record<string, string>; removed: Record<string, string> };
}

// ─── Oracle Score algorithm constants ───
// Ported from oracle_ghost.py scoring system
export const SCORE_WEIGHTS = {
  TIER_BONUS: { prismatic: 14, gold: 10, silver: 6 },
  STRONG_COMBO_BONUS: 12,
  TRAP_PENALTY: -15,
  RARITY_BONUS: { prismatic: 3, gold: 1, silver: 0 },
  // Qualitative change augments (質變增幅) get a special multiplier
  // because they rewrite champion mechanics, not just boost numbers.
  SYSTEM_BREAKER_BONUS: 20,
  // Ability profile synergy bonuses
  ABILITY_TYPE_SYNERGY: 6,  // augment damage type matches champion damage type
  ATTACK_TYPE_SYNERGY: 4,   // augment specifies melee/ranged and matches champion
  CC_SYNERGY: 4,            // CC-enhancing augment + champion crowdControl >= 4
  // Mismatch penalty (applied as negative) — augment clearly doesn't fit champion
  TAG_MISMATCH_PENALTY: -8,
  // Strongest structured champion-kit interaction only; strength is 1-3.
  MECHANICAL_INTERACTION_PER_STRENGTH: 3,
  // 26.12 ability/quest augment fit; strength is -3..3.
  // HYPOTHESIS weight — validate against live win rates once 26.12 telemetry
  // lands (plan §3); change both twins together.
  ABILITY_AUGMENT_FIT_PER_STRENGTH: 3,
} as const;

// ─── Augment Selection Constants ───
// Verified reroll mechanics from ARAM Mayhem
export const AUGMENT_SELECTION = {
  /** Slots shown per selection round */
  SLOTS_PER_ROUND: 3,
  /** Max rerolls per slot */
  REROLLS_PER_SLOT: 1,
  /** Max unique augments viewable per round (3 + 3 rerolls) */
  MAX_VIEWABLE_PER_ROUND: 6,
  /** Selection round level thresholds */
  ROUND_LEVELS: [3, 7, 11, 15] as const,
  /** Total selection rounds per game */
  TOTAL_ROUNDS: 4,
} as const;
