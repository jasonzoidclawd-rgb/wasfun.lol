/**
 * Damage Calculator Reference — ARAM Mayhem
 *
 * Formula sources:
 *   Physical damage pipeline — https://wiki.leagueoflegends.com/en-us/Damage
 *   Critical strike          — https://wiki.leagueoflegends.com/en-us/Critical_strike
 *   Armor penetration        — https://wiki.leagueoflegends.com/en-us/Armor_penetration
 *   Lethality                — https://wiki.leagueoflegends.com/en-us/Lethality (1:1 since v14.1)
 */
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { readFile } from "fs/promises";
import path from "path";
import type { Item, ChampionBaseStats, AbilityProfile } from "@/lib/types";
import { parseItemStats, computeDamageProfile, computeMagicDamageProfile } from "@/lib/data/itemStats";
import DamageCalculator, { type CalcChampion, type CalcItem } from "@/components/damage-sim/DamageCalculator";
import type { Locale } from "@/i18n/routing";
import { languageAlternates, localizedUrl } from "@/lib/site";
import { localizedDescription, localizedName } from "@/lib/i18n/localized-name";
import { augmentStatsEnabled, stripAugmentStats } from "@/lib/stats/kill-switch";

// ─── Data loaders ─────────────────────────────────────────────────────────────

async function loadItems(): Promise<Item[]> {
  const f = path.join(process.cwd(), "public", "data", "items.json");
  const d = JSON.parse(await readFile(f, "utf-8"));
  return [...(d.mayhemExclusive ?? []), ...(d.items ?? [])];
}

async function loadAugments(): Promise<Augment[]> {
  const f = path.join(process.cwd(), "public", "data", "augments.json");
  const d = JSON.parse(await readFile(f, "utf-8"));
  const augments: Augment[] = d.augments ?? [];
  return augmentStatsEnabled() ? augments : augments.map((a) => stripAugmentStats(a));
}

interface RawChampion {
  slug: string;
  name: string;
  name_zh_TW?: string;
  name_zh_CN?: string;
  name_ja?: string;
  name_ko?: string;
  icon: string;
  baseStats?: ChampionBaseStats;
}

async function loadChampions(locale: string): Promise<CalcChampion[]> {
  const [champFile, abilFile] = await Promise.all([
    readFile(path.join(process.cwd(), "public", "data", "champions.json"), "utf-8"),
    readFile(path.join(process.cwd(), "public", "data", "abilities.json"), "utf-8"),
  ]);
  const champData = JSON.parse(champFile);
  const abilData = JSON.parse(abilFile);
  const profiles: Record<string, AbilityProfile> = abilData.profiles ?? {};

  return (champData.champions ?? [])
    .filter((c: RawChampion) => c.baseStats)
    .map((c: RawChampion) => {
      const profile = profiles[c.slug];
      return {
        slug: c.slug,
        name: localizedName(c, locale),
        searchName: c.name,
        icon: c.icon,
        attackType: profile?.attackType ?? "ranged",
        damageType: profile?.damageType ?? "physical",
        playstyle: profile?.playstyle ?? { damage: 3, durability: 3, crowdControl: 1, mobility: 1, utility: 1 },
        abilities: (profile?.abilities ?? []).map((a) => ({
          key: a.key,
          name: a.name,
          icon: a.icon,
          description: a.description,
        })),
        baseStats: c.baseStats!,
      };
    });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Augment {
  slug: string;
  name: string;
  name_zh_TW?: string;
  name_zh_CN?: string;
  name_ja?: string;
  name_ko?: string;
  description_zh_TW?: string | null;
  description_zh_CN?: string | null;
  description_ja?: string | null;
  description_ko?: string | null;
  rarity: "prismatic" | "gold" | "silver";
  win_rate: number;
  icon?: string;
  description?: string;
  set?: string;
}

type AugmentTag =
  | "CRIT"
  | "AD"
  | "AP"
  | "ATTACK_SPEED"
  | "ON_HIT"
  | "LETHALITY"
  | "MAGIC_PEN"
  | "OMNIVAMP"
  | "DMG_AMP"
  | "TRUE_DMG";

interface TaggedAugment extends Augment {
  tags: AugmentTag[];
}

// ─── Stat parsing helpers ─────────────────────────────────────────────────────

function descriptionStatLines(description: string): string[] {
  const split = description
    .replace(/([a-z])([A-Z][a-z])/g, "$1\n$2")
    .replace(/(\d)([A-Z][a-z])/g, "$1\n$2");
  const lines = split.split("\n").map((s) => s.trim()).filter(Boolean);
  const statLines: string[] = [];
  for (const line of lines) {
    if (/^\d/.test(line)) {
      const parts = line
        .split(/(?<=\S) (?=\d+(?:\.\d+)?%?\s+[A-Z])/)
        .map((p) => p.trim())
        .filter(Boolean);
      statLines.push(...parts);
    } else break;
  }
  return statLines;
}

// ─── Augment tagging ──────────────────────────────────────────────────────────

function tagAugment(aug: Augment): AugmentTag[] {
  const desc = (aug.description ?? "").toLowerCase();
  const tags: AugmentTag[] = [];

  if (/critical strike|crit(?!ical)/.test(desc)) tags.push("CRIT");
  if (/\battack damage\b|\bbad\b/.test(desc) || /bonus attack damage/.test(desc)) tags.push("AD");
  if (/ability power|\bap\b/.test(desc)) tags.push("AP");
  if (/attack speed/.test(desc)) tags.push("ATTACK_SPEED");
  if (/on.hit/.test(desc)) tags.push("ON_HIT");
  if (/lethality/.test(desc)) tags.push("LETHALITY");
  if (/magic pen(?:etration)?|magic resist(?:ance)? reduction/.test(desc)) tags.push("MAGIC_PEN");
  if (/omnivamp|life steal/.test(desc)) tags.push("OMNIVAMP");
  if (/\btrue damage\b/.test(desc)) tags.push("TRUE_DMG");
  // Damage amplification: explicit % damage bonus
  if (
    /\d+%\s+(?:bonus\s+)?(?:physical|magic|true|)?\s*damage(?!\s+reduction)/.test(desc) ||
    /\bdeal\b.*?\d+%.*?(?:more|increased|bonus)\s+damage/.test(desc) ||
    /\bincrease[sd]?\b.*?\bdamage\b.*?\d+%/.test(desc)
  ) tags.push("DMG_AMP");

  return tags;
}

const TAG_STYLE: Record<AugmentTag, string> = {
  CRIT:         "bg-amber-400/15 text-amber-300 border-amber-400/30",
  AD:           "bg-red-400/15 text-red-300 border-red-400/30",
  AP:           "bg-blue-400/15 text-blue-300 border-blue-400/30",
  ATTACK_SPEED: "bg-green-400/15 text-green-300 border-green-400/30",
  ON_HIT:       "bg-purple-400/15 text-purple-300 border-purple-400/30",
  LETHALITY:    "bg-orange-400/15 text-orange-300 border-orange-400/30",
  MAGIC_PEN:    "bg-cyan-400/15 text-cyan-300 border-cyan-400/30",
  OMNIVAMP:     "bg-rose-400/15 text-rose-300 border-rose-400/30",
  DMG_AMP:      "bg-yellow-400/15 text-yellow-300 border-yellow-400/30",
  TRUE_DMG:     "bg-white/10 text-white/80 border-white/20",
};


const TAG_MESSAGE_KEY: Record<AugmentTag, string> = {
  CRIT:         "tagCrit",
  AD:           "tagAD",
  AP:           "tagAP",
  ATTACK_SPEED: "tagAttackSpeed",
  ON_HIT:       "tagOnHit",
  LETHALITY:    "tagLethality",
  MAGIC_PEN:    "tagMagicPen",
  OMNIVAMP:     "tagOmnivamp",
  DMG_AMP:      "tagDmgAmp",
  TRUE_DMG:     "tagTrueDmg",
};

const RARITY_STYLE: Record<string, string> = {
  prismatic: "text-purple-300",
  gold:      "text-amber-400",
  silver:    "text-slate-300",
};

const TARGET_ARMOR = 100;
const TARGET_MR = 50;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "damageSim" });
  const route = "/damage-sim";
  const title = t("title");
  const description = t("subtitle", { armor: TARGET_ARMOR, mr: TARGET_MR });
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

export default async function DamageSimPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("damageSim");

  const [allItems, augments, calcChampions] = await Promise.all([
    loadItems(),
    loadAugments(),
    loadChampions(locale),
  ]);
  const augmentBySlug = new Map(augments.map((augment) => [augment.slug, augment]));
  const augmentName = (slug: string, fallback: string): string => {
    const augment = augmentBySlug.get(slug);
    return augment ? localizedName(augment, locale) : fallback;
  };

  // ── Item damage table ──────────────────────────────────────────────────────

  type Row = {
    item: Item;
    ad: number;
    critChancePct: number;
    critDamagePct: number;
    lethality: number;
    armorPenPct: number;
    effectiveAD: number;
    critAutoHit: number;
    expectedMult: number;
  };

  const rows: Row[] = [];

  for (const item of allItems) {
    const id = item.id ?? 0;
    if (id > 0 && id < 200_000 && !item.slug) continue;

    const isModified = id >= 200_000 && id < 900_000;
    const statsSource =
      !isModified && item.wikiStats?.length
        ? item.wikiStats
        : descriptionStatLines(item.description ?? "");

    const parsed = parseItemStats(statsSource);
    if (!parsed.attackDamage || parsed.attackDamage < 30) continue;

    const profile = computeDamageProfile(parsed, TARGET_ARMOR);

    rows.push({
      item,
      ad: parsed.attackDamage,
      critChancePct: (parsed.critChance ?? 0) * 100,
      critDamagePct: (parsed.critDamage ?? 0) * 100,
      lethality: parsed.lethality ?? 0,
      armorPenPct: (parsed.armorPenPct ?? 0) * 100,
      effectiveAD: profile.effectiveAD,
      critAutoHit: profile.critAutoHit,
      expectedMult: profile.critExpectedMultiplier,
    });
  }

  rows.sort((a, b) => b.effectiveAD - a.effectiveAD || b.expectedMult - a.expectedMult);

  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    if (seen.has(r.item.name)) return false;
    seen.add(r.item.name);
    return true;
  });

  // ── AP item magic damage table ─────────────────────────────────────────────

  type APRow = {
    item: Item;
    ap: number;
    magicPenPct: number;
    magicPenFlat: number;
    effectiveMR: number;
    magicMultiplier: number;
  };

  const apRows: APRow[] = [];

  for (const item of allItems) {
    const id = item.id ?? 0;
    if (id > 0 && id < 200_000 && !item.slug) continue;

    const isModified = id >= 200_000 && id < 900_000;
    const statsSource =
      !isModified && item.wikiStats?.length
        ? item.wikiStats
        : descriptionStatLines(item.description ?? "");

    const parsed = parseItemStats(statsSource);
    if (!parsed.abilityPower || parsed.abilityPower < 30) continue;

    const profile = computeMagicDamageProfile(parsed, TARGET_MR);

    apRows.push({
      item,
      ap: parsed.abilityPower,
      magicPenPct: (parsed.magicPenPct ?? 0) * 100,
      magicPenFlat: parsed.magicPenFlat ?? 0,
      effectiveMR: profile.effectiveMR,
      magicMultiplier: profile.magicMultiplier,
    });
  }

  apRows.sort((a, b) => b.ap * b.magicMultiplier - a.ap * a.magicMultiplier);

  const apSeen = new Set<string>();
  const apDeduped = apRows.filter((r) => {
    if (apSeen.has(r.item.name)) return false;
    apSeen.add(r.item.name);
    return true;
  });

  // ── Augment tagging ────────────────────────────────────────────────────────

  const tagged: TaggedAugment[] = augments
    .map((a) => ({ ...a, tags: tagAugment(a) }))
    .filter((a) => a.tags.length > 0)
    .sort((a, b) => {
      const order = ["prismatic", "gold", "silver"];
      return order.indexOf(a.rarity) - order.indexOf(b.rarity) || (b.win_rate ?? 0) - (a.win_rate ?? 0);
    });

  // Group by primary tag
  const byTag: Partial<Record<AugmentTag, TaggedAugment[]>> = {};
  for (const aug of tagged) {
    for (const tag of aug.tags) {
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag]!.push(aug);
    }
  }

  const TAG_ORDER: AugmentTag[] = ["CRIT", "DMG_AMP", "TRUE_DMG", "AD", "AP", "ON_HIT", "ATTACK_SPEED", "LETHALITY", "MAGIC_PEN", "OMNIVAMP"];

  // ── Pre-parse item stats for calculator ───────────────────────────────────

  const calcItems: CalcItem[] = [];
  const calcSeen = new Set<string>();
  for (const item of allItems) {
    const id = item.id ?? 0;
    if (id <= 0) continue;
    if (id > 0 && id < 200_000 && !item.slug) continue;
    if (calcSeen.has(item.name)) continue;
    calcSeen.add(item.name);

    const isModified = id >= 200_000 && id < 900_000;
    const statsSource =
      !isModified && item.wikiStats?.length
        ? item.wikiStats
        : descriptionStatLines(item.description ?? "");
    const parsed = parseItemStats(statsSource);

    // Only include items that give meaningful combat stats
    if (
      (parsed.attackDamage ?? 0) > 0 ||
      (parsed.abilityPower ?? 0) > 0 ||
      (parsed.critChance ?? 0) > 0 ||
      (parsed.lethality ?? 0) > 0 ||
      (parsed.attackSpeed ?? 0) > 0 ||
      (parsed.magicPenFlat ?? 0) > 0 ||
      (parsed.armorPenPct ?? 0) > 0 ||
      (parsed.lifeSteal ?? 0) > 0 ||
      (parsed.omnivamp ?? 0) > 0
    ) {
      calcItems.push({
        id,
        name: localizedName(item, locale),
        searchName: item.name,
        icon: item.icon,
        stats: parsed,
      });
    }
  }
  calcItems.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="py-8 max-w-5xl space-y-10">

      {/* ─── Header ─── */}
      <div>
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          {t("subtitle", { armor: TARGET_ARMOR, mr: TARGET_MR })}
        </p>
      </div>

      {/* ─── Interactive Calculator ─── */}
      <section>
        <SectionHeading>{t("buildCalculator")}</SectionHeading>
        <DamageCalculator champions={calcChampions} items={calcItems} />
      </section>

      {/* ─── Formula Reference ─── */}
      <section>
        <SectionHeading>{t("formulaReference")}</SectionHeading>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          <FormulaCard title={t("physicalDamagePipeline")} source="wiki.leagueoflegends.com/en-us/Damage">
            <FormulaLine label={t("preMitigation")} formula="Base AD × crit_multiplier" />
            <FormulaLine label={t("armorMitigation")} formula="damage × 100 / (100 + effectiveArmor)" />
            <FormulaLine label={t("effectiveArmor")} formula="(targetArmor × (1 − %pen)) − lethality" note={t("noteMin0")} />
          </FormulaCard>

          <FormulaCard title={t("magicDamagePipeline")} source="wiki.leagueoflegends.com/en-us/Damage">
            <FormulaLine label={t("preMitigation")} formula="AP × ability_ratio" note={t("noteRatioVaries")} />
            <FormulaLine label={t("mrMitigation")} formula="damage × 100 / (100 + effectiveMR)" />
            <FormulaLine label={t("effectiveMr")} formula="(targetMR × (1 − %magic pen)) − flat magic pen" note={t("noteMin0")} />
          </FormulaCard>

          <FormulaCard title={t("criticalStrike")} source="wiki.leagueoflegends.com/en-us/Critical_strike">
            <FormulaLine label={t("autoAttackCrit")} formula="2.0 + Σ bonus_crit_damage" note={t("noteBase200")} />
            <FormulaLine label={t("abilityCrit")} formula="1.45 + Σ bonus_crit_damage" note={t("noteJeweled")} />
            <FormulaLine label={t("bonusCritStacking")} formula={t("noteCritAdditive")} />
            <FormulaLine label={t("averageAutoDamage")} formula="AD × (1 + critChance × (critMod − 1))" />
            <FormulaLine label={t("critChanceCap")} formula="100%" />
          </FormulaCard>

          <FormulaCard title={t("damageAmplification")} source="wiki.leagueoflegends.com/en-us/Damage">
            <FormulaLine label={t("stackingRule")} formula={t("stackingRuleFormula")} />
            <FormulaLine label={t("formula")} formula="total = base × Π (1 + amp_i)" />
            <FormulaLine label={t("example")} formula="20% + 20% = 1.20 × 1.20 = 1.44×" note={t("noteNot140")} />
            <div className="mt-1 space-y-1 text-xs text-[var(--color-text-muted)]">
              <p><span className="text-amber-300">{augmentName("giant-slayer", "Giant Slayer")}</span> — {t("giantSlayerAmp")}</p>
              <p><span className="text-amber-300">{augmentName("infernal-might", "Infernal Might")}</span> — {t("infernalMightAmp")}</p>
            </div>
          </FormulaCard>

          <FormulaCard title={t("armorPenetrationOrder")} source="wiki.leagueoflegends.com/en-us/Armor_penetration">
            <PenOrderList items={[
              ["1", t("flatArmorReduction"), t("flatArmorReductionNote")],
              ["2", t("percentArmorReduction"), t("percentArmorReductionNote")],
              ["3", t("percentArmorPenetration"), t("percentArmorPenetrationNote")],
              ["4", t("lethalityFlatPen"), t("lethalityFlatPenNote")],
            ]} />
          </FormulaCard>

          <FormulaCard title={t("magicPenetrationOrder")} source="wiki.leagueoflegends.com/en-us/Magic_penetration">
            <PenOrderList items={[
              ["1", t("flatMrReduction"), t("flatMrReductionNote")],
              ["2", t("percentMrReduction"), t("percentMrReductionNote")],
              ["3", t("percentMagicPenetration"), t("percentMagicPenetrationNote")],
              ["4", t("flatMagicPenetration"), t("flatMagicPenetrationNote")],
            ]} />
            <p className="text-[10px] text-[var(--color-text-muted)] mt-2 border-t border-[var(--color-border-default)] pt-2">
              <span className="text-[var(--color-text-secondary)]">{t("healing")}:</span>{" "}
              {t("healingNote")}
            </p>
          </FormulaCard>

          <FormulaCard title={t("damageTypes")} source="wiki.leagueoflegends.com/en-us/Damage">
            <div className="space-y-1.5 text-sm text-[var(--color-text-secondary)]">
              <p><span className="text-red-300 font-medium">{t("physical")}</span> — {t("physicalDamageTypeNote")}</p>
              <p><span className="text-blue-300 font-medium">{t("magic")}</span> — {t("magicDamageTypeNote")}</p>
              <p><span className="text-white/80 font-medium">{t("trueDamage")}</span> — {t("trueDamageTypeNote")}</p>
              <p><span className="text-purple-300 font-medium">{t("rawDamage")}</span> — {t("rawDamageTypeNote")}</p>
            </div>
          </FormulaCard>

          <FormulaCard title={t("specialInteractions")} source="wiki.leagueoflegends.com/en-us/Damage">
            <div className="space-y-2 text-sm text-[var(--color-text-secondary)]">
              <p><span className="text-amber-300 font-medium">{augmentName("jeweled-gauntlet", "Jeweled Gauntlet")} / {augmentName("vulnerability", "Vulnerability")}</span> — {t("jeweledInteractionNote")}</p>
              <p><span className="text-amber-300 font-medium">{t("trueDamage")}</span> — {t("trueDamageInteractionNote")}</p>
              <p><span className="text-amber-300 font-medium">{augmentName("giant-slayer", "Giant Slayer")}</span> — {t("giantSlayerInteractionNote")}</p>
            </div>
          </FormulaCard>

        </div>
      </section>

      {/* ─── Augment Interaction Labels ─── */}
      <section>
        <SectionHeading>{t("augmentInteractionsTitle")}</SectionHeading>
        <p className="text-xs text-[var(--color-text-muted)] mb-4">
          {t("augmentInteractionsSubtitle", { count: tagged.length })}
        </p>
        <div className="space-y-6">
          {TAG_ORDER.filter((tag) => byTag[tag]?.length).map((tag) => (
            <div key={tag}>
              <h3 className="text-xs font-bold uppercase tracking-widest text-[var(--color-text-muted)] mb-2.5 flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded border text-[10px] ${TAG_STYLE[tag]}`}>
                  {t(TAG_MESSAGE_KEY[tag])}
                </span>
                <span>{t("augmentCount", { count: byTag[tag]!.length })}</span>
              </h3>
              <div className="space-y-1.5">
                {byTag[tag]!.map((aug) => (
                  <div
                    key={aug.slug}
                    className="flex items-start gap-3 p-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)]/40"
                  >
                    <div className="flex items-center gap-2 shrink-0 w-40">
                      <span className={`text-xs font-semibold ${RARITY_STYLE[aug.rarity]}`}>
                        {aug.rarity[0].toUpperCase()}
                      </span>
                      <span className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                        {localizedName(aug, locale)}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1 shrink-0">
                      {aug.tags.map((tagKey) => (
                        <span key={tagKey} className={`text-[10px] px-1.5 py-0.5 rounded border ${TAG_STYLE[tagKey]}`}>
                          {t(TAG_MESSAGE_KEY[tagKey])}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-[var(--color-text-muted)] leading-relaxed flex-1 min-w-0">
                      {localizedDescription(aug, locale) || aug.description}
                    </p>
                    <span className="text-xs text-[var(--color-text-muted)] shrink-0 tabular-nums">
                      {aug.win_rate != null ? `${aug.win_rate.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── Item Damage Table ─── */}
      <section>
        <SectionHeading>AD Items · Physical Damage Profile vs {TARGET_ARMOR} Armor</SectionHeading>
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          Eff AD = AD × 100/(100+armor) · Crit Hit = Eff AD × (2.0+bonus_crit) · Avg × = weighted by crit chance ·
          Armor pen order: %pen first, then lethality
        </p>
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border-default)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border-default)] bg-[var(--color-bg-card)]/80">
                {["Item", "AD", "Crit%", "+Crit%", "Leth", "Pen%", "Eff AD", "Crit Hit", "Avg ×"].map((h) => (
                  <th
                    key={h}
                    className={`px-3 py-3 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] font-semibold ${h === "Item" ? "text-left pl-4" : "text-right"} ${h === "Avg ×" ? "pr-4" : ""}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {deduped.map((row, i) => (
                <tr
                  key={row.item.id ?? row.item.slug}
                  className={`border-b border-[var(--color-border-default)] hover:bg-[var(--color-bg-card)]/40 transition-colors ${i % 2 === 0 ? "" : "bg-[var(--color-bg-card)]/20"}`}
                >
                  <td className="px-4 py-2.5 font-medium text-[var(--color-text-primary)]">{localizedName(row.item, locale)}</td>
                  <Num>{row.ad}</Num>
                  <Num>{row.critChancePct > 0 ? `${row.critChancePct.toFixed(0)}%` : "—"}</Num>
                  <Num>{row.critDamagePct > 0 ? `+${row.critDamagePct.toFixed(0)}%` : "—"}</Num>
                  <Num>{row.lethality > 0 ? row.lethality : "—"}</Num>
                  <Num>{row.armorPenPct > 0 ? `${row.armorPenPct.toFixed(0)}%` : "—"}</Num>
                  <Num className="font-semibold text-[var(--color-text-primary)]">{row.effectiveAD.toFixed(1)}</Num>
                  <Num className="text-amber-400">{row.critAutoHit > 0 ? row.critAutoHit.toFixed(1) : "—"}</Num>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-[var(--color-neon-primary)]">
                    {row.expectedMult.toFixed(2)}×
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-[var(--color-text-muted)] mt-3">
          {deduped.length} Mayhem AD items · champion base stats and multi-item stacking not yet modelled
        </p>
      </section>

      {/* ─── AP Item Table ─── */}
      <section>
        <SectionHeading>AP Items · Magic Damage Profile vs {TARGET_MR} MR</SectionHeading>
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          Magic Mult = 100/(100+effectiveMR) · Eff AP = AP × MagicMult ·
          Actual damage = AP × ability_ratio × MagicMult (ratios vary per champion spell)
        </p>
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border-default)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border-default)] bg-[var(--color-bg-card)]/80">
                {["Item", "AP", "MPen%", "Flat Pen", "Eff MR", "Magic Mult", "Eff AP"].map((h) => (
                  <th
                    key={h}
                    className={`px-3 py-3 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] font-semibold ${h === "Item" ? "text-left pl-4" : "text-right"} ${h === "Eff AP" ? "pr-4" : ""}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {apDeduped.map((row, i) => (
                <tr
                  key={row.item.id ?? row.item.slug}
                  className={`border-b border-[var(--color-border-default)] hover:bg-[var(--color-bg-card)]/40 transition-colors ${i % 2 === 0 ? "" : "bg-[var(--color-bg-card)]/20"}`}
                >
                  <td className="px-4 py-2.5 font-medium text-[var(--color-text-primary)]">{localizedName(row.item, locale)}</td>
                  <Num>{row.ap}</Num>
                  <Num>{row.magicPenPct > 0 ? `${row.magicPenPct.toFixed(0)}%` : "—"}</Num>
                  <Num>{row.magicPenFlat > 0 ? row.magicPenFlat : "—"}</Num>
                  <Num>{row.effectiveMR.toFixed(1)}</Num>
                  <Num className="font-semibold text-[var(--color-text-primary)]">{(row.magicMultiplier * 100).toFixed(1)}%</Num>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-blue-300">
                    {(row.ap * row.magicMultiplier).toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-[var(--color-text-muted)] mt-3">
          {apDeduped.length} Mayhem AP items · ability ratios, champion base stats, and multi-item stacking not yet modelled
        </p>
      </section>

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-bold uppercase tracking-widest text-[var(--color-text-muted)] mb-4">
      {children}
    </h2>
  );
}

function FormulaCard({
  title,
  source,
  children,
}: {
  title: string;
  source: string;
  children: React.ReactNode;
}) {
  return (
    <div className="p-4 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)]/40">
      <div className="flex items-start justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h3>
        <span className="text-[10px] text-[var(--color-text-muted)] shrink-0 mt-0.5">
          ↗ {source}
        </span>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function FormulaLine({
  label,
  formula,
  note,
}: {
  label: string;
  formula: string;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</span>
      <div className="flex items-baseline gap-2 flex-wrap">
        <code className="text-xs font-mono text-[var(--color-neon-primary)] bg-[var(--color-bg-card)] px-1.5 py-0.5 rounded">
          {formula}
        </code>
        {note && <span className="text-[10px] text-[var(--color-text-muted)]">{note}</span>}
      </div>
    </div>
  );
}

function PenOrderList({ items }: { items: [string, string, string][] }) {
  return (
    <ol className="space-y-1 text-sm text-[var(--color-text-secondary)] list-none">
      {items.map(([n, label, note]) => (
        <li key={n} className="flex gap-2">
          <span className="text-[var(--color-neon-primary)] font-mono text-xs w-4 shrink-0 mt-0.5">{n}.</span>
          <span>
            <span className="font-medium text-[var(--color-text-primary)]">{label}</span>
            <span className="text-[var(--color-text-muted)] ml-2 text-xs">— {note}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Num({
  children,
  className = "text-[var(--color-text-secondary)]",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2.5 text-right tabular-nums ${className}`}>{children}</td>
  );
}
