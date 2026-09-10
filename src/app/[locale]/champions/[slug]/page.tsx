import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireActiveEntitlement } from "@/lib/entitlements/server";
import { MembershipGate } from "@/components/membership/MembershipGate";
import Image from "next/image";
import { notFound } from "next/navigation";
import { computeOracleScore, type ComboTier } from "@/lib/scoring/oracle-score";
import type { AbilityProfile, AbilityEntry, AbilityStats, ChampionBaseStats } from "@/lib/types";
import { Tooltip } from "@/components/ui/Tooltip";
import { buildPoolProfile } from "@/lib/scoring/augment-tailoring";
import { getChampionAugmentPool } from "@/lib/scoring/pool-orchestrator";
import { analyzeInteractions, type MechanicalInteraction, type AugmentMechanic } from "@/lib/scoring/augment-interactions";
import { localizedDescription, localizedName } from "@/lib/i18n/localized-name";
import { buildComboTierLookup, resolveChampionCombos } from "@/lib/data/combo-lookup";
import { readChampionsFile } from "@/lib/data/read-public-file";
import { routing, type Locale } from "@/i18n/routing";
import { ChampionMatrixClient } from "@/components/champions/ChampionMatrixClient";
import {
  loadChampionDetailData,
  type ChampionDetailAugment,
  type ChampionDetailChampion,
} from "@/lib/champions/detail-data";
import { buildChampionDetailJsonLd } from "@/lib/seo/champion-detail";
import {
  PoolConstructionSection,
  type PoolLayer,
  type PoolProfileChip,
  type PoolRaritySummary,
  type TailoredHighlight,
} from "@/components/champions/PoolConstructionSection";
import type { DecisionGrade } from "@/lib/contracts/decision";
import { JsonLd } from "@/components/seo/JsonLd";
import { languageAlternates, localizedUrl } from "@/lib/site";

type ChampionData = ChampionDetailChampion;
type AugmentData = ChampionDetailAugment;

type PillLabels = {
  tier: string;
  combo: string;
  trap: string;
  rarity: string;
  dmgType: string;
  atkType: string;
  cc: string;
  mismatch: string;
};

type MechanicLabels = Record<AugmentMechanic, string>;

type AbilityStatLabels = {
  damage: string;
  ap: string;
  bonusAd: string;
  totalAd: string;
  health: string;
  cooldown: string;
  cost: string;
  range: string;
  dot: string;
  aoe: string;
  onHit: string;
  radius: string;
  width: string;
  speed: string;
  cast: string;
};

// ─── Static params for all current-patch champions ───────────────────────────

export const dynamicParams = false;

export async function generateStaticParams() {
  const { champions } = await readChampionsFile<{ champions: ChampionData[] }>();

  return routing.locales.flatMap((locale) =>
    champions.map((c) => ({ locale, slug: c.slug }))
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: "champion" });
  const data = await loadChampionDetailData("public");
  const champ = data.champions.find((c) => c.slug === slug);
  if (!champ) notFound();

  const name = localizedName(champ, locale);
  const route = `/champions/${champ.slug}`;
  const tierLabel = champ.tier ?? t("statisticsUnavailableShort");
  const title = t("metaDetailTitle", { name, tier: tierLabel, patch: data.patch });
  const description = t("metaDetailDescription", { name, tier: tierLabel, patch: data.patch });
  const url = localizedUrl(route, locale as Locale);

  return {
    title,
    description,
    alternates: {
      canonical: url,
      languages: languageAlternates(route),
    },
    openGraph: { title, description, url, locale },
    twitter: { card: "summary_large_image", title, description },
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function ChampionPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("champion");
  const tm = await getTranslations("membership");
  const tg = await getTranslations("grades");

  // Resolve the slug against public data and 404 unknown slugs BEFORE the
  // entitlement gate below. The gate reads cookies(), which makes this route
  // dynamically rendered when Supabase env is configured (production); a
  // notFound() thrown after that point no longer yields a 404 status, so
  // unknown slugs must be rejected while the response is still unstarted.
  const publicData = await loadChampionDetailData("public");
  const { champions, patch } = publicData;
  const champ = champions.find((c) => c.slug === slug);
  if (!champ) notFound();

  // Member decision content (pool construction, scored rankings) is gated on an
  // active entitlement — not merely being signed in. A logged-in non-member
  // must not receive server-rendered scores or breakdowns.
  const { isAuthenticated, isMember } = await (async () => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      return { isAuthenticated: false, isMember: false };
    }
    const gate = await requireActiveEntitlement();
    if (gate.ok) return { isAuthenticated: true, isMember: true };
    return { isAuthenticated: gate.reason !== "unauthenticated", isMember: false };
  })();

  const memberData = isMember ? await loadChampionDetailData("member") : null;
  const activeData = memberData ?? publicData;
  const { augments, combos, poolRules, abilities } = activeData;
  const activeChamp = activeData.champions.find((c) => c.slug === slug) ?? champ;
  const champName = localizedName(champ, locale);
  const localizedAugmentDescription = (augment: AugmentData): string =>
    localizedDescription(augment, locale) || augment.wikiDescription || augment.description || "";
  const displayAugment = (augment: AugmentData): AugmentData => {
    const description = localizedAugmentDescription(augment);
    return {
      ...augment,
      name: localizedName(augment, locale),
      description,
      wikiDescription: description,
    };
  };

  const championStatisticsAvailable =
    typeof activeChamp.win_rate === "number" &&
    typeof activeChamp.pick_rate === "number";
  const champWr = championStatisticsAvailable ? activeChamp.win_rate : null;
  const abilityProfile: AbilityProfile | undefined = abilities[slug];

  // Build combo lookup for this champion: augment-slug → tier
  const champCombos = resolveChampionCombos(slug, combos, augments);
  const comboBySlug = isMember
    ? buildComboTierLookup(slug, combos, augments)
    : new Map<string, ComboTier>();
  const augmentBySlug = new Map(augments.map((augment) => [augment.slug, augment]));

  const poolProfile = buildPoolProfile(slug, abilityProfile, activeChamp.baseStats);
  const pool = isMember
    ? getChampionAugmentPool({
        championSlug: slug,
        augments,
        abilityProfile,
        baseStats: activeChamp.baseStats,
        championKitTags: activeChamp.kit_tags ?? [],
        poolRules,
      })
    : null;
  const poolAugments = pool ? [...pool.silver, ...pool.gold, ...pool.prismatic] : [];

  const scoredAugments = championStatisticsAvailable && champWr !== null
    ? poolAugments
      .map((aug) => {
        const comboTier = comboBySlug.get(aug.slug);
        const result = computeOracleScore({
          augment: aug,
          championWinRate: champWr,
          comboTier,
          abilityProfile,
          isSystemBreaker: aug.flags?.system_breaker === true,
        });
        return { aug, score: result.total, breakdown: result.breakdown, comboTier };
      })
      .sort((a, b) => b.score - a.score)
    : [];

  const excludedByReason = pool
    ? pool.excluded.reduce<Record<string, number>>((accumulator, entry) => {
        accumulator[entry.reason] = (accumulator[entry.reason] ?? 0) + 1;
        return accumulator;
      }, {})
    : {};
  const countExcluded = (...reasons: string[]) =>
    reasons.reduce((total, reason) => total + (excludedByReason[reason] ?? 0), 0);

  let poolLayerRemainder = pool?.total ?? augments.length;
  const poolLayers: PoolLayer[] = [
    {
      key: "source",
      label: t("poolStepSource"),
      detail: t("poolStepSourceDetail"),
      kept: poolLayerRemainder,
      removed: 0,
    },
  ];
  const appendPoolLayer = (key: string, label: string, detail: string, removed: number) => {
    poolLayerRemainder -= removed;
    poolLayers.push({ key, label, detail, kept: poolLayerRemainder, removed });
  };

  if (pool) {
    appendPoolLayer(
      "lifecycle",
      t("poolStepLifecycle"),
      t("poolStepLifecycleDetail"),
      countExcluded("disabled", "removed"),
    );
    appendPoolLayer(
      "hard",
      t("poolStepHard"),
      t("poolStepHardDetail"),
      countExcluded("hard-exclusion"),
    );
    appendPoolLayer(
      "tags",
      t("poolStepTags"),
      t("poolStepTagsDetail"),
      countExcluded("tag-mismatch"),
    );
    appendPoolLayer(
      "items",
      t("poolStepItems"),
      t("poolStepItemsDetail"),
      countExcluded("item-exclusion"),
    );
  }

  // Pre-compute translated damage/attack type labels
  const damageTypeLabel: Record<string, string> = {
    magic:    t("magicDamage"),
    physical: t("physicalDamage"),
    mixed:    t("mixedDamage"),
  };
  const attackTypeLabel: Record<string, string> = {
    ranged: t("ranged"),
    melee:  t("melee"),
  };

  const poolProfileChips: PoolProfileChip[] = [
    {
      label: t("poolChipResource"),
      value:
        poolProfile.resource === "none"
          ? t("resourceNone")
          : poolProfile.resource === "energy"
            ? t("resourceEnergy")
            : t("resourceMana"),
    },
    {
      label: t("attackType"),
      value: attackTypeLabel[poolProfile.attackType] ?? poolProfile.attackType,
    },
    {
      label: t("damageType"),
      value: damageTypeLabel[poolProfile.damageType] ?? poolProfile.damageType,
    },
    {
      label: t("poolChipTags"),
      value: (champ.kit_tags ?? []).length > 0 ? (champ.kit_tags ?? []).join(", ") : t("poolUniversal"),
    },
  ];

  const poolRaritySummary: PoolRaritySummary[] = [
    {
      key: "silver",
      label: t("silver"),
      count: pool?.silver.length ?? augments.filter((augment) => augment.rarity === "silver").length,
    },
    {
      key: "gold",
      label: t("gold"),
      count: pool?.gold.length ?? augments.filter((augment) => augment.rarity === "gold").length,
    },
    {
      key: "prismatic",
      label: t("prismatic"),
      count: pool?.prismatic.length ?? augments.filter((augment) => augment.rarity === "prismatic").length,
    },
  ];

  const tailoredHighlights: TailoredHighlight[] = scoredAugments.slice(0, 6).map(({ aug, score, comboTier }) => ({
    aug: displayAugment(aug),
    score,
    comboTier,
  }));

  const strongCombos = champCombos.filter((c) => c.tier === "S");
  const avoidCombos = champCombos.filter((c) => c.tier === "C");

  // ── Mechanical Interaction Analysis ──
  let mechanicalSynergies: MechanicalInteraction[] = [];
  let mechanicalTraps: MechanicalInteraction[] = [];

  if (isMember && abilityProfile && activeChamp.baseStats) {
    const allInteractions = analyzeInteractions(
      {
        name: localizedName(activeChamp, locale),
        slug: activeChamp.slug,
        baseStats: activeChamp.baseStats,
        abilityProfile,
      },
      poolAugments.map((a) => ({
        slug: a.slug,
        name: localizedName(a, locale),
        description: localizedAugmentDescription(a),
        wikiDescription: localizedAugmentDescription(a),
      })),
    );
    // Show strength 3 always, top strength 2 (capped at 8 each), skip strength 1
    const synAll = allInteractions.filter((i) => i.type === "synergy");
    const trapAll = allInteractions.filter((i) => i.type === "trap");
    const pickTop = (arr: MechanicalInteraction[], limit: number) => {
      const s3 = arr.filter((i) => i.strength === 3);
      const s2 = arr.filter((i) => i.strength === 2);
      return [...s3, ...s2].slice(0, limit);
    };
    mechanicalSynergies = pickTop(synAll, 12);
    mechanicalTraps = pickTop(trapAll, 8);
  }

  // Top augments — show top 20 from filtered pool
  const topAugments = scoredAugments.slice(0, 20);

  // Pre-compute translated pill labels
  const pillLabels: PillLabels = {
    tier:     t("pillTier"),
    combo:    t("pillCombo"),
    trap:     t("pillTrap"),
    rarity:   t("pillRarity"),
    dmgType:  t("pillDmgType"),
    atkType:  t("pillAtkType"),
    cc:       t("pillCC"),
    mismatch: t("pillMismatch"),
  };

  // Pre-compute translated playstyle labels
  const playstyleItems: Array<[keyof AbilityProfile["playstyle"], string]> = [
    ["damage",       t("playstyleDamage")],
    ["durability",   t("playstyleDurability")],
    ["crowdControl", t("playstyleCrowdControl")],
    ["mobility",     t("playstyleMobility")],
    ["utility",      t("playstyleUtility")],
  ];
  const baseStatsCopy = {
    title: t("baseStatsTitle"),
    stat: t("baseStatsStat"),
    base: t("baseStatsBase"),
    growth: t("baseStatsGrowth"),
    at18: t("baseStatsAt18"),
    rows: {
      health: t("statHealth"),
      mana: t("statMana"),
      hpRegen: t("statHpRegen"),
      mpRegen: t("statMpRegen"),
      armor: t("statArmor"),
      magicResist: t("statMagicResist"),
      attackDamage: t("statAttackDamage"),
      attackSpeed: t("statAttackSpeed"),
      attackSpeedGrowth: t("statAttackSpeedGrowth"),
      attackRange: t("statAttackRange"),
      moveSpeed: t("statMoveSpeed"),
      missileSpeed: t("statMissileSpeed"),
    },
  };
  const mechanicLabels: MechanicLabels = {
    ABILITY_CRIT: t("mechanicAbilityCrit"),
    ON_HIT: t("mechanicOnHit"),
    ATTACK_SPEED: t("mechanicAttackSpeed"),
    DOT_SYNERGY: t("mechanicDotSynergy"),
    ULT_POWER: t("mechanicUltPower"),
    ULT_SEALED: t("mechanicUltSealed"),
    ABILITY_HASTE: t("mechanicAbilityHaste"),
    ON_CAST: t("mechanicOnCast"),
    DASH_SYNERGY: t("mechanicDash"),
    EXECUTE: t("mechanicExecute"),
    LIFESTEAL: t("mechanicLifesteal"),
    TRUE_DAMAGE: t("mechanicTrueDamage"),
    MANA_SCALING: t("mechanicManaScaling"),
    SIZE_CHANGE: t("mechanicSizeChange"),
    SHIELD: t("mechanicShield"),
    SUMMON_REPLACE: t("mechanicSummoner"),
    MELEE_CONVERT: t("mechanicMeleeConvert"),
    AD_SCALING: t("mechanicAdScaling"),
    AP_SCALING: t("mechanicApScaling"),
    IMMOBILIZE_TRIGGER: t("mechanicImmobilize"),
  };
  const abilityStatLabels: AbilityStatLabels = {
    damage: t("abilityStatDamage"),
    ap: t("abilityStatAp"),
    bonusAd: t("abilityStatBonusAd"),
    totalAd: t("abilityStatTotalAd"),
    health: t("abilityStatHealth"),
    cooldown: t("abilityStatCooldown"),
    cost: t("abilityStatCost"),
    range: t("abilityStatRange"),
    dot: t("abilityStatDot"),
    aoe: t("abilityStatAoe"),
    onHit: t("abilityStatOnHit"),
    radius: t("abilityStatRadius"),
    width: t("abilityStatWidth"),
    speed: t("abilityStatSpeed"),
    cast: t("abilityStatCast"),
  };

  const championRoute = `/champions/${champ.slug}`;
  const championJsonLd = buildChampionDetailJsonLd(champ, locale, {
    url: localizedUrl(championRoute, locale as Locale),
    homeUrl: localizedUrl("/", locale as Locale),
    championsUrl: localizedUrl("/champions", locale as Locale),
    championsLabel: t("indexTitle"),
    name: champName,
    patch,
    tierLabel: champ.tier ?? t("statisticsUnavailableShort"),
    tagLabels: champ.tags,
    classLabels: champ.classes,
    kitTagLabels: champ.kit_tags,
  });

  return (
    <div className="py-4 sm:py-8 max-w-4xl">
      <JsonLd data={championJsonLd} />
      {/* ─── Header ─── */}
      <div className="flex items-center gap-3 sm:gap-5 mb-4 sm:mb-6">
        <div className="relative w-14 h-14 sm:w-20 sm:h-20 rounded-full overflow-hidden border-2 border-[var(--color-neon-primary)]/40 shrink-0">
          <Image
            src={champ.icon}
            alt={champName}
            fill
            className="object-cover"
            sizes="(max-width: 640px) 56px, 80px"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <h1 className="text-xl sm:text-3xl font-bold truncate">{champName}</h1>
            {champ.rank && (
              <span className="text-sm sm:text-base text-[var(--color-text-muted)] font-medium shrink-0">
                {champ.rank}/{champions.length}
              </span>
            )}
            {champ.tier ? (
              <TierBadge tier={champ.tier} />
            ) : (
              <span className="text-xs font-semibold text-[var(--color-text-muted)]">
                {t("statisticsUnavailableShort")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-sm text-[var(--color-text-secondary)]">
            {championStatisticsAvailable ? (
              <>
                <span className="font-bold text-[var(--color-wr-high)]">
                  {activeChamp.win_rate!.toFixed(1)}% {t("winRateAbbr")}
                </span>
                <span className="text-xs">
                  {activeChamp.pick_rate!.toFixed(1)}% {t("pickRateAbbr")}
                </span>
              </>
            ) : (
              <span className="font-medium text-amber-300">
                {t("statisticsUnavailable")}
              </span>
            )}
            <span className="text-[10px] text-[var(--color-text-muted)]">{t("patchLabel", { patch })}</span>
          </div>
          <div className="flex gap-1 mt-1.5 flex-wrap">
            {(champ.classes ?? champ.tags).map((cl) => (
              <span
                key={cl}
                className="px-1.5 py-0.5 text-[10px] font-medium rounded border border-[var(--color-border-default)] text-[var(--color-text-secondary)] capitalize"
              >
                {cl}
              </span>
            ))}
          </div>
          {(champ.kit_tags ?? []).length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {(champ.kit_tags ?? []).map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 text-[10px] rounded border border-[var(--color-neon-primary)]/30 bg-[var(--color-neon-primary)]/5 text-[var(--color-neon-primary)]/70"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Neon divider */}
      <div className="h-0.5 mb-4 rounded-full bg-gradient-to-r from-[var(--color-neon-primary)] to-[var(--color-neon-secondary)]" />

      {/* ─── Strong combos + Traps ─── */}
      {(strongCombos.length > 0 || avoidCombos.length > 0) && (
        <section className="glass-card p-4 mb-3 sm:mb-6">
          {strongCombos.length > 0 && (
            <div className={avoidCombos.length > 0 ? "mb-4" : ""}>
              <h2 className="text-sm font-bold mb-2 text-green-400 border-l-2 border-green-400 pl-2">
                {t("strongCombos")}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {strongCombos.map((c) => {
                  const aug = augmentBySlug.get(c.augmentSlug);
                  const augName = aug ? localizedName(aug, locale) : c.augment;
                  const augDescription = aug ? localizedAugmentDescription(aug) : undefined;
                  return (
                    <Tooltip key={`${c.champion}-${c.augmentSlug}-${c.tier}`} content={augDescription}>
                      <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-green-400/30 bg-green-400/5 cursor-default">
                        {aug && (
                          <Image
                            src={aug.icon}
                            alt={augName}
                            width={24}
                            height={24}
                            className="rounded"
                            unoptimized
                          />
                        )}
                        <span className="text-xs font-medium text-green-300">
                          {augName}
                        </span>
                        <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-green-400/20 text-green-400">
                          S
                        </span>
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          )}

          {avoidCombos.length > 0 && (
            <div>
              <h2 className="text-sm font-bold mb-2 text-red-400 border-l-2 border-red-400 pl-2">
                {t("trapsAvoid")}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {avoidCombos.map((c) => {
                  const aug = augmentBySlug.get(c.augmentSlug);
                  const augName = aug ? localizedName(aug, locale) : c.augment;
                  const augDescription = aug ? localizedAugmentDescription(aug) : undefined;
                  return (
                    <Tooltip key={`${c.champion}-${c.augmentSlug}-${c.tier}`} content={augDescription}>
                      <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-red-400/30 bg-red-400/5 cursor-default">
                        {aug && (
                          <Image
                            src={aug.icon}
                            alt={augName}
                            width={24}
                            height={24}
                            className="rounded"
                            unoptimized
                          />
                        )}
                        <span className="text-xs font-medium text-red-300">
                          {augName}
                        </span>
                        <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-red-400/20 text-red-400">
                          C
                        </span>
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ─── Base Stats ─── */}
      {champ.baseStats && (
        <BaseStatsTable stats={champ.baseStats} copy={baseStatsCopy} />
      )}

      {/* ─── Mechanical Interactions ─── */}
      {(mechanicalSynergies.length > 0 || mechanicalTraps.length > 0) && (
        <section className="glass-card p-4 mb-3 sm:mb-6">
          <h2 className="text-sm font-bold mb-1 border-l-2 border-[var(--color-neon-primary)] pl-2">
            {t("mechanicalAnalysis")}
          </h2>
          <p className="text-[10px] text-[var(--color-text-muted)] mb-3 pl-3">
            {t("mechanicalCounts", {
              synergies: mechanicalSynergies.length,
              traps: mechanicalTraps.length,
            })}
          </p>

          {mechanicalSynergies.length > 0 && (
            <div className="mb-3">
              <h3 className="text-xs font-semibold text-green-400 mb-1.5 border-l-2 border-green-400/50 pl-2">
                {t("mechanicalSynergies")}
              </h3>
              <div className="space-y-1">
                {mechanicalSynergies.map((ix, i) => (
                  <InteractionRow key={`syn-${i}`} ix={ix} augments={augments} locale={locale} mechanicLabels={mechanicLabels} />
                ))}
              </div>
            </div>
          )}

          {mechanicalTraps.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-red-400 mb-1.5 border-l-2 border-red-400/50 pl-2">
                {t("mechanicalTraps")}
              </h3>
              <div className="space-y-1">
                {mechanicalTraps.map((ix, i) => (
                  <InteractionRow key={`trap-${i}`} ix={ix} augments={augments} locale={locale} mechanicLabels={mechanicLabels} />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ─── Abilities ─── */}
      {abilityProfile && (
        <section className="glass-card p-4 mb-3 sm:mb-6">
          <h2 className="text-sm font-bold mb-3 border-l-2 border-[var(--color-neon-primary)] pl-2">{t("skillOrder")}</h2>

          {/* Damage type + attack type badges + playstyle bars inline */}
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <DamageTypeBadge
              type={abilityProfile.damageType}
              label={damageTypeLabel[abilityProfile.damageType] ?? abilityProfile.damageType}
            />
            <AttackTypeBadge
              type={abilityProfile.attackType}
              label={attackTypeLabel[abilityProfile.attackType] ?? abilityProfile.attackType}
            />
          </div>

          {/* Playstyle bars — compact row */}
          <div className="grid grid-cols-5 gap-2 mb-4 px-2 py-2.5 rounded-lg bg-[var(--color-bg-card)]/60">
            {playstyleItems.map(([key, label]) => (
              <div key={key} className="flex flex-col items-center gap-1">
                <div className="flex gap-0.5">
                  {[1, 2, 3].map((pip) => (
                    <div
                      key={pip}
                      className={`w-3 sm:w-4 h-1.5 rounded-full ${
                        pip <= abilityProfile.playstyle[key]
                          ? "bg-[var(--color-neon-primary)]"
                          : "bg-[var(--color-border-default)]"
                      }`}
                    />
                  ))}
                </div>
                <span className="text-[8px] sm:text-[10px] text-[var(--color-text-muted)] uppercase tracking-wide text-center leading-tight">
                  {label}
                </span>
              </div>
            ))}
          </div>

          {/* Ability list — compact cards */}
          <div className="space-y-2">
            {abilityProfile.abilities.map((ability) => {
              const abilityName = localizedName(ability, locale);
              // Prefer a real localized description; for English (or when no
              // translation exists) fall back to the richer wiki text.
              const localizedDesc = localizedDescription(ability, locale);
              const abilityDescription =
                localizedDesc !== ability.description
                  ? localizedDesc
                  : ability.wikiDescription ?? ability.description;

              return (
                <div key={ability.key} className="flex items-start gap-2.5 px-2 py-2 rounded-lg border border-[var(--color-border-default)]/50 bg-[var(--color-bg-card)]/30">
                  <div className="shrink-0 flex flex-col items-center gap-0.5">
                    <div className="relative w-8 h-8 sm:w-10 sm:h-10 rounded-lg overflow-hidden border border-[var(--color-border-default)]">
                      <Image
                        src={ability.icon}
                        alt={abilityName}
                        fill
                        className="object-contain"
                        sizes="(max-width: 640px) 32px, 40px"
                        unoptimized
                      />
                    </div>
                    <span className="text-[9px] font-bold text-[var(--color-text-muted)] uppercase">
                      {ability.key}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs sm:text-sm font-semibold">{abilityName}</span>
                    <WikiAbilityStats ability={ability} labels={abilityStatLabels} />
                    {!ability.cooldown && ability.stats && <AbilityStatLine stats={ability.stats} labels={abilityStatLabels} />}
                    <p className="text-[11px] text-[var(--color-text-secondary)] mt-1 leading-relaxed line-clamp-2 sm:line-clamp-none">
                      {abilityDescription}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <PoolConstructionSection
        title={t("poolConstruction")}
        subtitle={t("poolConstructionSubtitle", {
          name: champName,
          kept: pool?.total ?? augments.length,
          total: augments.length,
        })}
        rarityTitle={t("poolRarityMix")}
        filterTitle={t("poolFilterStack")}
        highlightsTitle={t("poolTopTailored")}
        keptLabel={(count: number) => t("poolKept", { count })}
        removedLabel={(count: number) => t("poolRemoved", { count })}
        profileChips={poolProfileChips}
        raritySummary={poolRaritySummary}
        layers={poolLayers}
        highlights={tailoredHighlights}
        totalAugments={augments.length}
        gated={!isMember}
        signInUrl="/account"
        signInNextPath={!isAuthenticated ? `/champions/${slug}` : undefined}
        gateCopy={!isMember ? (isAuthenticated ? {
          title: tm("lockedTitle"),
          description: tm("lockedBody"),
          signIn: tm("lockedCta"),
        } : {
          title: t("poolGateTitle"),
          description: t("poolGateDescription"),
          signIn: t("poolGateSignIn"),
        }) : undefined}
      />

      <section className="glass-card p-4">
        {isMember ? (
          <ChampionMatrixClient
            championSlug={champ.slug}
            augmentNames={Object.fromEntries(augments.map((a) => [a.slug, localizedName(a, locale)]))}
            copy={{
              title: tm("matrixTitle"),
              subtitle: tm("matrixSubtitle"),
              loading: tm("matrixLoading"),
              error: tm("matrixError"),
              round: tm("matrixRoundN"),
              topPick: tm("matrixTopPick"),
              modeCompetitive: tm("advModeCompetitive"),
              modeExploration: tm("advModeExploration"),
              raritySilver: tm("advRaritySilver"),
              rarityGold: tm("advRarityGold"),
              rarityPrismatic: tm("advRarityPrismatic"),
              gradeLabels: {
                hot: tg("hot"),
                strong: tg("strong"),
                steady: tg("steady"),
                average: tg("average"),
                weak: tg("weak"),
              } as Record<DecisionGrade, string>,
              lockedTitle: tm("lockedTitle"),
              lockedBody: tm("lockedBody"),
              lockedCta: tm("lockedCta"),
            }}
          />
        ) : (
          <MembershipGate title={tm("lockedTitle")} body={tm("lockedBody")} cta={tm("lockedCta")} />
        )}
      </section>

      {/* ─── Augment Rankings (member-gated: scores + breakdowns) ─── */}
      <section className="glass-card p-4">
        <h2 className="text-sm font-bold mb-1 border-l-2 border-[var(--color-neon-primary)] pl-2">
          {t("augments")} — {t("oracleRanked")}
        </h2>
        {isMember ? (
          <>
            <p className="text-[10px] text-[var(--color-text-muted)] mb-3 pl-3">
              <span className="font-medium text-[var(--color-text-primary)]">N={pool?.total ?? 0}</span>
              <span> / {augments.length} total</span>
              {poolProfile.resource !== "mana" && (
                <span>
                  {" · "}
                  {poolProfile.resource === "none"
                    ? t("resourceNone")
                    : poolProfile.resource === "energy"
                      ? t("resourceEnergy")
                      : t("resourceMana")}
                </span>
              )}
              {abilityProfile && (
                <span> · {attackTypeLabel[abilityProfile.attackType] ?? abilityProfile.attackType}</span>
              )}
            </p>

            <div className="space-y-1.5">
              {topAugments.map(({ aug, score, breakdown, comboTier }, i) => (
                <AugmentRow
                  key={aug.slug}
                  rank={i + 1}
                  aug={aug}
                  score={score}
                  breakdown={breakdown}
                  comboTier={comboTier}
                  pillLabels={pillLabels}
                  locale={locale}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="mt-3">
            <MembershipGate title={tm("lockedTitle")} body={tm("lockedBody")} cta={tm("lockedCta")} />
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const TIER_BADGE_STYLES: Record<string, string> = {
  "S+": "text-amber-300 border-amber-300/50 bg-amber-300/10",
  S:    "text-yellow-400 border-yellow-400/50 bg-yellow-400/10",
  A:    "text-green-400 border-green-400/50 bg-green-400/10",
  B:    "text-blue-400 border-blue-400/50 bg-blue-400/10",
  C:    "text-slate-400 border-slate-400/50 bg-slate-400/10",
};

function TierBadge({ tier }: { tier: string }) {
  const styles = TIER_BADGE_STYLES[tier] ?? TIER_BADGE_STYLES.C;
  return (
    <span className={`px-2.5 py-0.5 rounded-md text-sm font-bold border ${styles}`}>
      {tier}
    </span>
  );
}

const RARITY_DOT: Record<string, string> = {
  prismatic: "bg-purple-400",
  gold:      "bg-yellow-400",
  silver:    "bg-slate-400",
};

const SCORE_COLOR = (score: number) => {
  if (score >= 80) return "text-amber-300";
  if (score >= 70) return "text-yellow-400";
  if (score >= 60) return "text-green-400";
  return "text-slate-400";
};

function AugmentRow({
  rank,
  aug,
  score,
  breakdown,
  comboTier,
  pillLabels,
  locale,
}: {
  rank: number;
  aug: AugmentData;
  score: number;
  breakdown: ReturnType<typeof computeOracleScore>["breakdown"];
  comboTier?: ComboTier;
  pillLabels: PillLabels;
  locale: string;
}) {
  const isStrong = comboTier === "S";
  const isTrap = comboTier === "C";
  const augName = localizedName(aug, locale);
  const augDescription = localizedDescription(aug, locale);

  return (
    <Tooltip content={augDescription}>
      <div
        className={`flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 rounded-lg border transition-colors cursor-default
          ${isStrong ? "border-green-400/30 bg-green-400/5" : isTrap ? "border-red-400/20 bg-red-400/5" : "border-[var(--color-border-default)]/50"}`}
      >
        {/* Rank */}
        <span className="text-[10px] text-[var(--color-text-muted)] w-4 text-right shrink-0">
          {rank}
        </span>

        {/* Icon */}
        <div className="relative w-7 h-7 sm:w-8 sm:h-8 rounded shrink-0">
          <Image
            src={aug.icon}
            alt={augName}
            fill
            className="object-contain"
            sizes="(max-width: 640px) 28px, 32px"
            unoptimized
          />
        </div>

        {/* Name + rarity */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs sm:text-sm font-medium truncate">{augName}</span>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${RARITY_DOT[aug.rarity] ?? ""}`} />
            {comboTier && (
              <span
                className={`text-[9px] font-bold px-1 rounded shrink-0
                  ${isStrong ? "text-green-400 bg-green-400/20" : "text-red-400 bg-red-400/20"}`}
              >
                {comboTier}
              </span>
            )}
          </div>
          {/* Score breakdown pills — hidden on mobile for compact view */}
          <div className="hidden sm:flex gap-1.5 mt-0.5 flex-wrap">
            {breakdown.tierBonus > 0 && (
              <ScorePill label={pillLabels.tier} value={breakdown.tierBonus} />
            )}
            {breakdown.comboBonus > 0 && (
              <ScorePill label={pillLabels.combo} value={breakdown.comboBonus} positive />
            )}
            {breakdown.trapPenalty < 0 && (
              <ScorePill label={pillLabels.trap} value={breakdown.trapPenalty} negative />
            )}
            {breakdown.rarityBonus > 0 && (
              <ScorePill label={pillLabels.rarity} value={breakdown.rarityBonus} />
            )}
            {breakdown.abilityTypeSynergy > 0 && (
              <ScorePill label={pillLabels.dmgType} value={breakdown.abilityTypeSynergy} positive />
            )}
            {breakdown.attackTypeSynergy > 0 && (
              <ScorePill label={pillLabels.atkType} value={breakdown.attackTypeSynergy} positive />
            )}
            {breakdown.ccSynergy > 0 && (
              <ScorePill label={pillLabels.cc} value={breakdown.ccSynergy} positive />
            )}
            {breakdown.tagMismatch < 0 && (
              <ScorePill label={pillLabels.mismatch} value={breakdown.tagMismatch} negative />
            )}
          </div>
        </div>

        {/* Win rate — hidden on mobile */}
        <span className="hidden sm:inline text-xs text-[var(--color-text-muted)] shrink-0">
          {aug.win_rate != null ? `${aug.win_rate.toFixed(1)}%` : "—"}
        </span>

        {/* Oracle Score */}
        <span className={`text-sm sm:text-base font-bold w-10 sm:w-12 text-right shrink-0 ${SCORE_COLOR(score)}`}>
          {Math.round(score)}
        </span>
      </div>
    </Tooltip>
  );
}

function ScorePill({
  label,
  value,
  positive,
  negative,
}: {
  label: string;
  value: number;
  positive?: boolean;
  negative?: boolean;
}) {
  const color = negative
    ? "text-red-400/80"
    : positive
      ? "text-green-400/80"
      : "text-[var(--color-text-muted)]";
  return (
    <span className={`text-[9px] ${color}`}>
      {label}:{value > 0 ? "+" : ""}{value}
    </span>
  );
}

const DAMAGE_TYPE_STYLES: Record<string, string> = {
  magic:    "text-blue-300 border-blue-400/40 bg-blue-400/10",
  physical: "text-orange-300 border-orange-400/40 bg-orange-400/10",
  mixed:    "text-violet-300 border-violet-400/40 bg-violet-400/10",
};

function DamageTypeBadge({ type, label }: { type: string; label: string }) {
  const style = DAMAGE_TYPE_STYLES[type] ?? DAMAGE_TYPE_STYLES.mixed;
  return (
    <span className={`px-2.5 py-1 rounded-md text-xs font-semibold border ${style}`}>
      {label}
    </span>
  );
}

function AttackTypeBadge({ type, label }: { type: string; label: string }) {
  const style = type === "ranged"
    ? "text-cyan-300 border-cyan-400/40 bg-cyan-400/10"
    : "text-rose-300 border-rose-400/40 bg-rose-400/10";
  return (
    <span className={`px-2.5 py-1 rounded-md text-xs font-semibold border ${style}`}>
      {label}
    </span>
  );
}

// ─── Mechanical Interaction Components ────────────────────────────────────────

const STRENGTH_DOTS = (strength: 1 | 2 | 3, isTrap: boolean) => {
  const color = isTrap ? "bg-red-400" : "bg-green-400";
  const dim = isTrap ? "bg-red-400/20" : "bg-green-400/20";
  return (
    <span className="inline-flex gap-0.5 ml-1">
      {[1, 2, 3].map((n) => (
        <span key={n} className={`w-1.5 h-1.5 rounded-full ${n <= strength ? color : dim}`} />
      ))}
    </span>
  );
};

function InteractionRow({
  ix,
  augments,
  locale,
  mechanicLabels,
}: {
  ix: MechanicalInteraction;
  augments: AugmentData[];
  locale: string;
  mechanicLabels: MechanicLabels;
}) {
  const aug = augments.find((a) => a.slug === ix.augmentSlug);
  const augName = aug ? localizedName(aug, locale) : ix.augmentName;
  const isTrap = ix.type === "trap";
  const borderColor = isTrap ? "border-red-400/20" : "border-green-400/20";
  const bgColor = isTrap ? "bg-red-400/5" : "bg-green-400/5";

  return (
    <Tooltip content={ix.reason}>
      <div className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border ${borderColor} ${bgColor} cursor-default`}>
        {aug && (
          <div className="relative w-6 h-6 rounded shrink-0">
            <Image
              src={aug.icon}
              alt={augName}
              fill
              className="object-contain"
              sizes="24px"
              unoptimized
            />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium truncate">{augName}</span>
            {STRENGTH_DOTS(ix.strength, isTrap)}
            <span className={`text-[9px] font-semibold px-1 py-0.5 rounded border
              ${isTrap
                ? "text-red-300 border-red-400/30 bg-red-400/10"
                : "text-green-300 border-green-400/30 bg-green-400/10"
              }`}
            >
              {mechanicLabels[ix.mechanic]}
            </span>
            {ix.abilities.length > 0 && (
              <span className="text-[9px] text-[var(--color-text-muted)]">
                {ix.abilities.join(", ")}
              </span>
            )}
          </div>
          <p className="hidden sm:block text-[10px] text-[var(--color-text-muted)] mt-0.5 line-clamp-1">
            {ix.reason}
          </p>
        </div>
      </div>
    </Tooltip>
  );
}

// ─── Ability Stat Line ────────────────────────────────────────────────────────

const DMG_TYPE_COLOR: Record<string, string> = {
  magic: "text-blue-300",
  physical: "text-orange-300",
  true: "text-white",
};

function AbilityStatLine({ stats, labels }: { stats: AbilityStats; labels: AbilityStatLabels }) {
  const parts: Array<{ label: string; value: string; color?: string }> = [];

  if (stats.baseDamage?.length) {
    const dmg = stats.baseDamage;
    parts.push({
      label: labels.damage,
      value: dmg.length > 1 ? `${dmg[0]}–${dmg[dmg.length - 1]}` : `${dmg[0]}`,
      color: DMG_TYPE_COLOR[stats.damageType ?? ""] ?? "text-[var(--color-text-secondary)]",
    });
  }

  if (stats.apRatio) {
    parts.push({ label: labels.ap, value: `${(stats.apRatio * 100).toFixed(0)}%`, color: "text-blue-300" });
  }
  if (stats.adRatio) {
    parts.push({ label: labels.bonusAd, value: `${(stats.adRatio * 100).toFixed(0)}%`, color: "text-orange-300" });
  }
  if (stats.totalAdRatio) {
    parts.push({ label: labels.totalAd, value: `${(stats.totalAdRatio * 100).toFixed(0)}%`, color: "text-orange-300" });
  }
  if (stats.hpRatio) {
    parts.push({ label: labels.health, value: `${(stats.hpRatio * 100).toFixed(0)}%`, color: "text-green-300" });
  }

  if (stats.cooldown?.length) {
    const cd = stats.cooldown;
    parts.push({
      label: labels.cooldown,
      value: cd.length > 1 && cd[0] !== cd[cd.length - 1] ? `${cd[0]}–${cd[cd.length - 1]}s` : `${cd[0]}s`,
    });
  }

  if (stats.manaCost?.length) {
    const cost = stats.manaCost;
    parts.push({
      label: labels.cost,
      value: cost.length > 1 && cost[0] !== cost[cost.length - 1] ? `${cost[0]}–${cost[cost.length - 1]}` : `${cost[0]}`,
      color: "text-cyan-300",
    });
  }

  if (stats.ccType) {
    parts.push({
      label: stats.ccType,
      value: stats.ccDuration ? `${stats.ccDuration}s` : "",
      color: "text-yellow-300",
    });
  }

  if (stats.range) {
    parts.push({ label: labels.range, value: `${stats.range}` });
  }

  const flags: string[] = [];
  if (stats.isDot) flags.push(labels.dot);
  if (stats.isAoe) flags.push(labels.aoe);
  if (stats.isOnHit) flags.push(labels.onHit);

  if (parts.length === 0 && flags.length === 0) return null;

  return (
    <div className="flex gap-2 flex-wrap mt-1">
      {parts.map((p, i) => (
        <span key={i} className={`text-[10px] ${p.color ?? "text-[var(--color-text-muted)]"}`}>
          {p.label}{p.value ? ` ${p.value}` : ""}
        </span>
      ))}
      {flags.map((f) => (
        <span key={f} className="text-[10px] px-1 py-0.5 rounded bg-[var(--color-border-default)]/50 text-[var(--color-text-muted)]">
          {f}
        </span>
      ))}
    </div>
  );
}

// ─── Wiki Ability Stats ─────────────────────────────────────────────────────

function WikiAbilityStats({ ability, labels }: { ability: AbilityEntry; labels: AbilityStatLabels }) {
  const pills: Array<{ label: string; value: string; color?: string }> = [];

  if (ability.cooldown) {
    pills.push({ label: labels.cooldown, value: ability.cooldown });
  }
  if (ability.cost) {
    pills.push({ label: labels.cost, value: ability.cost, color: "text-cyan-300" });
  }
  if (ability.range) {
    pills.push({ label: labels.range, value: ability.range });
  }
  if (ability.effectRadius) {
    pills.push({ label: labels.radius, value: ability.effectRadius });
  }
  if (ability.width) {
    pills.push({ label: labels.width, value: ability.width });
  }
  if (ability.speed) {
    pills.push({ label: labels.speed, value: ability.speed });
  }
  if (ability.castTime) {
    pills.push({ label: labels.cast, value: `${ability.castTime}s` });
  }
  if (ability.damageFormula) {
    pills.push({ label: labels.damage, value: ability.damageFormula, color: "text-purple-300" });
  }

  if (pills.length === 0) return null;

  return (
    <div className="flex gap-2 flex-wrap mt-1">
      {pills.map((p, i) => (
        <span key={i} className={`text-[10px] ${p.color ?? "text-[var(--color-text-muted)]"}`}>
          <span className="opacity-60">{p.label}</span> {p.value}
        </span>
      ))}
    </div>
  );
}

// ─── Base Stats Table ────────────────────────────────────────────────────────

function statAtLevel(base: number, growth: number, level: number): number {
  return base + growth * (level - 1) * (0.7025 + 0.0175 * (level - 1));
}

type StatRow = {
  label: keyof BaseStatsCopy["rows"];
  base: keyof ChampionBaseStats;
  growth?: keyof ChampionBaseStats;
  decimals?: number;
  isPercent?: boolean;
  flat?: boolean; // no growth formula, just show base
};

type BaseStatsCopy = {
  title: string;
  stat: string;
  base: string;
  growth: string;
  at18: string;
  rows: {
    health: string;
    mana: string;
    hpRegen: string;
    mpRegen: string;
    armor: string;
    magicResist: string;
    attackDamage: string;
    attackSpeed: string;
    attackSpeedGrowth: string;
    attackRange: string;
    moveSpeed: string;
    missileSpeed: string;
  };
};

const STAT_ROWS: StatRow[] = [
  { label: "health", base: "baseHP", growth: "hpGrowth" },
  { label: "mana", base: "baseMP", growth: "mpGrowth" },
  { label: "hpRegen", base: "baseHPRegen", growth: "hpRegenGrowth", decimals: 1 },
  { label: "mpRegen", base: "baseMPRegen", growth: "mpRegenGrowth", decimals: 1 },
  { label: "armor", base: "baseArmor", growth: "armorGrowth", decimals: 1 },
  { label: "magicResist", base: "baseMR", growth: "mrGrowth", decimals: 1 },
  { label: "attackDamage", base: "baseAD", growth: "adGrowth", decimals: 1 },
  { label: "attackSpeed", base: "baseAS", decimals: 3 },
  { label: "attackSpeedGrowth", base: "asGrowth", decimals: 1, isPercent: true, flat: true },
  { label: "attackRange", base: "attackRange", flat: true },
  { label: "moveSpeed", base: "moveSpeed", flat: true },
  { label: "missileSpeed", base: "missileSpeed", flat: true },
];

function BaseStatsTable({
  stats,
  copy,
}: {
  stats: ChampionBaseStats;
  copy: BaseStatsCopy;
}) {
  const rows = STAT_ROWS.filter((row) => {
    const val = stats[row.base];
    return val != null && val !== 0;
  });

  return (
    <section className="glass-card p-4 mb-3 sm:mb-6">
      <h2 className="text-sm font-bold mb-3 border-l-2 border-[var(--color-neon-primary)] pl-2">
        {copy.title}
      </h2>
      <div className="overflow-x-auto rounded-lg">
        <table className="w-full text-xs sm:text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border-default)]">
              <th className="text-left text-[9px] sm:text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide px-2 sm:px-3 py-1.5">{copy.stat}</th>
              <th className="text-right text-[9px] sm:text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide px-2 sm:px-3 py-1.5">{copy.base}</th>
              <th className="text-right text-[9px] sm:text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide px-2 sm:px-3 py-1.5">{copy.growth}</th>
              <th className="text-right text-[9px] sm:text-[10px] font-medium text-[var(--color-neon-primary)]/70 uppercase tracking-wide px-2 sm:px-3 py-1.5">{copy.at18}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const base = stats[row.base] as number;
              const growth = row.growth ? (stats[row.growth] as number | undefined) : undefined;
              const dec = row.decimals ?? 0;

              let at18: number | undefined;
              if (!row.flat && !row.isPercent && growth != null) {
                at18 = statAtLevel(base, growth, 18);
              }

              return (
                <tr
                  key={row.label}
                  className="border-b border-[var(--color-border-default)]/30 last:border-0"
                >
                  <td className="px-2 sm:px-3 py-1 text-[11px] sm:text-xs text-[var(--color-text-secondary)]">{copy.rows[row.label]}</td>
                  <td className="px-2 sm:px-3 py-1 text-right tabular-nums font-medium">
                    {base.toFixed(dec)}{row.isPercent ? "%" : ""}
                  </td>
                  <td className="px-2 sm:px-3 py-1 text-right tabular-nums text-[var(--color-text-muted)] text-[11px]">
                    {growth != null && growth > 0 ? `+${growth}` : "—"}
                  </td>
                  <td className="px-2 sm:px-3 py-1 text-right tabular-nums text-[var(--color-neon-primary)] font-medium">
                    {at18 != null ? at18.toFixed(dec) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
