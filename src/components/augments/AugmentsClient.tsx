"use client";

import { useState, useMemo } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { ScoredAugment } from "@/lib/scoring/oracle-score";
import { Tooltip } from "@/components/ui/Tooltip";

// ─── Constants ───────────────────────────────────────────────────────────────

type AugmentRarity = "prismatic" | "gold" | "silver";
type Rarity = "all" | AugmentRarity;

const RARITY_STYLES = {
  prismatic: {
    badge: "rarity-prismatic",
    glow: "hover:border-purple-400/40 hover:shadow-[0_0_12px_rgba(200,150,255,0.15)]",
  },
  gold: {
    badge: "rarity-gold",
    glow: "hover:border-yellow-400/30 hover:shadow-[0_0_12px_rgba(255,215,0,0.1)]",
  },
  silver: {
    badge: "rarity-silver",
    glow: "hover:border-slate-400/30",
  },
} as const;

// The public catalog carries no win rates (they are member-only), so the
// client-side Oracle Score collapsed to a constant per rarity — 268 augments
// rendered as exactly three numbers. A score that restates the rarity badge
// beside it is noise dressed as analysis, so the public grid sorts and labels
// by rarity directly and says so.
const RARITY_ORDER: Record<string, number> = { prismatic: 0, gold: 1, silver: 2 };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function localizedName(aug: ScoredAugment, locale: string): string {
  if (locale === "zh-TW") return aug.name_zh_TW ?? aug.name_zh_CN ?? aug.name;
  if (locale === "zh-CN") return aug.name_zh_CN ?? aug.name;
  if (locale === "ja") return aug.name_ja ?? aug.name;
  if (locale === "ko") return aug.name_ko ?? aug.name;
  return aug.name;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function AugmentsClient({
  augments,
  locale = "en",
}: {
  augments: ScoredAugment[];
  locale?: string;
}) {
  const t = useTranslations("augments");
  const tChamp = useTranslations("champion");

  const [activeRarity, setActiveRarity] = useState<Rarity>("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"rarity" | "name">("rarity");

  // Partition on the resolved availability verdict. `flags.lifecycle` maps
  // four distinct states onto "removed", which is what made a temporarily
  // disabled augment indistinguishable from one deleted patches ago.
  const currentAugments = useMemo(
    () => augments.filter((a) => a.availability?.status === "confirmed_live"),
    [augments],
  );
  const notOfferedAugments = useMemo(
    () =>
      augments
        .filter((a) => a.availability?.status && a.availability.status !== "confirmed_live")
        .sort((a, b) => {
          // Disabled first: it is a fact about the CURRENT patch, unlike the
          // historical entries below it.
          const rank = (x: ScoredAugment) => (x.availability?.status === "disabled" ? 0 : 1);
          const byRank = rank(a) - rank(b);
          if (byRank !== 0) return byRank;
          return localizedName(a, locale).localeCompare(localizedName(b, locale));
        }),
    [augments, locale],
  );

  const filtered = useMemo(() => {
    return currentAugments.filter((a) => {
      const rarityMatch = activeRarity === "all" || a.rarity === activeRarity;
      const displayName = localizedName(a, locale);
      const q = search.toLowerCase();
      const searchMatch =
        !search ||
        displayName.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        (a.set ?? "").toLowerCase().includes(q) ||
        (a.wikiDescription ?? a.description ?? "").toLowerCase().includes(q);
      return rarityMatch && searchMatch;
    });
  }, [currentAugments, activeRarity, search, locale]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortBy === "rarity") {
        const delta =
          (RARITY_ORDER[a.rarity] ?? 99) - (RARITY_ORDER[b.rarity] ?? 99);
        if (delta !== 0) return delta;
      }
      return a.name.localeCompare(b.name);
    });
  }, [filtered, sortBy]);

  const counts = useMemo(
    () => ({
      all: currentAugments.length,
      prismatic: currentAugments.filter((a) => a.rarity === "prismatic").length,
      gold: currentAugments.filter((a) => a.rarity === "gold").length,
      silver: currentAugments.filter((a) => a.rarity === "silver").length,
    }),
    [currentAugments],
  );

  const rarityLabels: Record<AugmentRarity, string> = {
    prismatic: tChamp("prismatic"),
    gold: tChamp("gold"),
    silver: tChamp("silver"),
  };
  const rarityLabel: Record<Rarity, string> = {
    all: t("all"),
    ...rarityLabels,
  };

  return (
    <div>
      {/* ─── Game Notes (collapsible) ─── */}
      <GameNotes />

      {/* ─── Rarity Tabs ─── */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {(["all", "prismatic", "gold", "silver"] as Rarity[]).map((r) => (
          <button
            key={r}
            onClick={() => setActiveRarity(r)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all border ${
              activeRarity === r
                ? r === "all"
                  ? "bg-[var(--color-neon-primary)]/15 text-[var(--color-neon-primary)] border-[var(--color-neon-primary)]/40"
                  : `${RARITY_STYLES[r].badge} border-current`
                : "bg-[var(--color-bg-card)] text-[var(--color-text-secondary)] border-[var(--color-border-default)]"
            }`}
          >
            {rarityLabel[r]}{" "}
            <span className="opacity-60 text-xs ml-1">({counts[r]})</span>
          </button>
        ))}
      </div>

      {/* ─── Controls ─── */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="search"
          placeholder={t("search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 max-w-xs px-4 py-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] text-sm focus:outline-none focus:border-[var(--color-neon-primary)]/50"
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="px-3 py-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] text-sm focus:outline-none"
        >
          <option value="rarity">{t("sortRarity")}</option>
          <option value="name">{t("sortName")}</option>
        </select>
      </div>

      {/* ─── Grid ─── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
        {sorted.map((aug) => (
          <AugmentCard
            key={aug.slug}
            augment={aug}
            locale={locale}
            rarityLabel={rarityLabel[aug.rarity]}
          />
        ))}
      </div>

      {sorted.length === 0 && (
        <p className="text-center text-[var(--color-text-muted)] py-16">
          {t("noResults")}
        </p>
      )}

      <p className="text-xs text-[var(--color-text-muted)] mt-8 text-center">
        {t("showing", { count: sorted.length, total: currentAugments.length })}
      </p>

      <NotOfferedAugmentsTable augments={notOfferedAugments} locale={locale} />
    </div>
  );
}

// ─── Game Notes ─────────────────────────────────────────────────────────────

function GameNotes() {
  const t = useTranslations("augments");
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-6 glass-card border border-[var(--color-border-default)] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-3 flex items-center gap-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="text-base font-bold">{t("gameNotesTitle")}</span>
        <span className="text-[var(--color-text-muted)] text-xs">{t("gameNotesSubtitle")}</span>
        <span className="ml-auto text-[var(--color-text-muted)] text-xl">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-5 text-sm leading-relaxed">
          {/* Bread Sandwich */}
          <NoteBlock title="Bread Sandwich Combo">
            Collecting all 3 Bread augments (<Em>Bread and Butter</Em> + <Em>Bread and Cheese</Em> + <Em>Bread and Jam</Em>)
            grants the <Em>Bread Sandwich</Em> buff: <Stat>250 ultimate haste</Stat> and <Stat>50 ability haste</Stat> on
            each basic ability. This is one of the strongest hidden combos in the mode.
          </NoteBlock>

          {/* Burn Stacking */}
          <NoteBlock title="Burn Stacking Rules">
            <p>
              All Burn effects stack infinitely and refresh on application. When a Burn is first applied to a target,
              all subsequent Burn sources from <em>any player</em> stack onto that first source and credit damage to the
              first source&apos;s owner (e.g. <Em>Tormentor</Em> applied first will be stacked by <Em>Slow Cooker</Em>).
            </p>
            <ul className="mt-2 space-y-1 list-disc list-inside text-[var(--color-text-secondary)]">
              <li><Em>Firebrand</Em> — basic attacks, <Stat>0.4% target max HP/s</Stat> (2% over 5s)</li>
              <li><Em>Tormentor</Em> — on CC, <Stat>0.8% target max HP/s</Stat> (4% over 5s)</li>
              <li><Em>Slow Cooker</Em> — 500-unit aura, <Stat>0.66% your max HP/s</Stat> (2% over 3s)</li>
              <li><Em>Infernal Conduit</Em> — ability hits, <Stat>2–20 (+4.6% bonus AD)(+2% AP)/s</Stat> over 3s</li>
              <li><Em>Grandma&apos;s Chili Oil</Em> — next hit, <Stat>100–350 magic dmg</Stat> over 3s + AoE explosion</li>
              <li><Em>Holy Fire</Em> — heals/shields fire a missile, <Stat>0.2% target max HP/s</Stat> over 5s</li>
              <li><Em>Quest: Icathia&apos;s Fall</Em> — Void Immolation counts as <Stat>2 Burn sources</Stat></li>
            </ul>
          </NoteBlock>

          {/* Crit Interaction */}
          <NoteBlock title="Jeweled Gauntlet × Vulnerability">
            <p>
              <Em>Jeweled Gauntlet</Em>: abilities crit for <Stat>(145% + bonus crit dmg)</Stat>,
              gain <Stat>25% (+4.5% per 100 AP) crit chance</Stat>.
            </p>
            <p className="mt-1">
              <Em>Vulnerability</Em>: items &amp; DoTs crit for <Stat>(145% + bonus crit dmg)</Stat>,
              gain <Stat>25% crit chance</Stat> (5s CD per cast).
            </p>
            <p className="mt-1 text-[var(--color-text-muted)]">
              If both are equipped, only the augment with higher crit damage rolls its crit chance (not both).
              Known bug: may behave incorrectly with persistent area damage.
            </p>
          </NoteBlock>

          {/* Conversion Augments */}
          <NoteBlock title="Stat Conversion Augments">
            <ul className="space-y-1 list-disc list-inside text-[var(--color-text-secondary)]">
              <li><Em>ADAPt</Em> — converts bonus AD → AP at <Stat>1 AP per 0.6 bonus AD</Stat>, then <Stat>+15% AP</Stat></li>
              <li><Em>Purist - Caster</Em> — converts bonus AS → ability haste at <Stat>0.65 AH per 1% AS</Stat>, then <Stat>−10% total CD</Stat></li>
              <li><Em>Zealot</Em> — <Stat>35% (+5% per 100 AP) AS</Stat> and <Stat>25% (+5% per 100 AP) crit chance</Stat></li>
            </ul>
          </NoteBlock>

          {/* Key Augment Stats */}
          <NoteBlock title="Notable Augment Stats">
            <ul className="space-y-1 list-disc list-inside text-[var(--color-text-secondary)]">
              <li><Em>Apex Inventor</Em> — <Stat>100 item haste</Stat> (50% item CDR). A 60s item CD becomes 30s; a 120s becomes 60s.</li>
              <li><Em>Giant Slayer</Em> — shrink 75%, <Stat>+30% move speed</Stat>, <Stat>10/15/25/30% bonus dmg</Stat> based on target size.</li>
              <li><Em>???</Em> — missing pings fire missiles: <Stat>100–400 (+10% missing HP) magic dmg</Stat>, heals allies for the same. Ping limit scales with Honor level (2/4/6/7/7).</li>
              <li><Em>It&apos;s Killing Time</Em> — ult applies Death Mark to all enemies (8s CD), stores <Stat>40% post-mitigation dmg</Stat>, detonates as true damage after 5s.</li>
              <li><Em>Final City Transit</Em> — on death, summon train dealing <Stat>150–750 (+65% bonus AD)(+50% AP)(+15% max HP)</Stat> physical damage globally.</li>
              <li><Em>Poro Blaster</Em> — summon poros every 3.5s (max 5). Each deals <Stat>3% target max HP true dmg</Stat>. At 5 poros, first hit knocks up 0.5s. Limited to 1 player per team.</li>
              <li><Em>Void Rift</Em> — ability hits create Void Scars. Two scars within 1250 units create a rift dealing <Stat>100–450 (+5.5 per Lethality)(+5.5 per flat magic pen)</Stat> magic dmg + 99% slow.</li>
              <li><Em>Stuck in Here With Me</Em> — ult grants aura (500 units over 2s), then <Stat>2s taunt + 50% dmg reduction</Stat>. <Stat>+30 ult haste</Stat>. 30s CD.</li>
              <li><Em>Hand of Baron</Em> — grants modified Baron buff: <Stat>25% increased adaptive force</Stat> + greatly empowered nearby minions.</li>
              <li><Em>Phenomenal Evil</Em> — <Stat>+1 AP per stack</Stat> (on ability dmg to champ, 1s global CD). Starts with <Stat>40 stacks</Stat> if not first augment.</li>
              <li><Em>All For You</Em> — heals/shields on allies <Stat>+30% effectiveness</Stat>.</li>
              <li><Em>Hat on a Hat</Em> — <Stat>+15 AP, +8 MR per hat item</Stat> (reduced to 8 AP, 4 MR for hats from Cappa Juice/Stat Bonus).</li>
            </ul>
          </NoteBlock>

          {/* Spin To Win */}
          <NoteBlock title="Spin To Win — Eligible Abilities">
            <p>
              <Stat>+30% damage</Stat> and <Stat>30 ability haste</Stat> on spinning abilities.
            </p>
            <p className="mt-1 text-[var(--color-text-secondary)]">
              Ahri (Fox-Fire, Spirit Rush) · Amumu (Tantrum) · Ambessa (Lacerate) · Darius (Decimate) ·
              Draven (Spinning Axe, Stand Aside, Whirling Death) · Garen (Judgment) · Hecarim (Rampage) ·
              Jax (Counter Strike) · Katarina (Voracity, Death Lotus) · Kayn (Reaping Slash) ·
              Lillia (Blooming Blows) · Nocturne (Umbra Blades) · Rammus (Powerball) ·
              Renekton (Cull the Meek) · Riven (Broken Wings) · Samira (Blade Whirl, Inferno Trigger) ·
              Wukong (Cyclone) · Tryndamere (Spinning Slash) · Zed (Shadow Slash)
            </p>
          </NoteBlock>

          {/* Transmuted / High Roller */}
          <NoteBlock title="Transmuted Augments (High Roller set)">
            <p className="text-[var(--color-text-secondary)]">
              Transmuted augments reroll into a random augment of a different tier.
              <Em>Transmute: Gold</Em> (silver rarity) gives 1 random gold augment.
              <Em>Transmute: Prismatic</Em> (gold rarity) gives 1 random prismatic.
              <Em>Transmute: Chaos</Em> (prismatic rarity) gives 2 completely random augments.
              The result is prefixed &quot;Transmuted:&quot; in its title.
            </p>
          </NoteBlock>

          {/* Disabled */}
          <NoteBlock title="Currently Disabled Augments">
            <p className="text-[var(--color-text-muted)]">
              <Em>Fetch</Em> (silver), <Em>Quest: Sneakerhead</Em> (prismatic),
              and <Em>Spin Me Right Round</Em> (silver) are currently disabled and cannot appear in games.
            </p>
          </NoteBlock>

          <p className="text-[11px] text-[var(--color-text-muted)] pt-2">
            Source: wiki.leagueoflegends.com/en-us/ARAM:_Mayhem/Augments
          </p>
        </div>
      )}
    </div>
  );
}

function NoteBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-[var(--color-text-primary)] mb-1">{title}</h3>
      <div className="text-[var(--color-text-secondary)]">{children}</div>
    </div>
  );
}

function Em({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--color-text-primary)] font-medium">{children}</span>;
}

function Stat({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--color-neon-primary)] font-medium">{children}</span>;
}

// ─── Augment Tooltip ────────────────────────────────────────────────────────

function AugmentTooltip({
  aug,
  displayName,
}: {
  aug: ScoredAugment;
  displayName: string;
}) {
  const t = useTranslations("augments");
  const desc = aug.wikiDescription ?? aug.description;
  return (
    <div className="max-w-xs">
      <div className="font-medium">{displayName}</div>
      {desc && (
        <div className="text-xs opacity-80 mt-1 leading-relaxed">{desc}</div>
      )}
      {aug.kit_tags && aug.kit_tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {aug.kit_tags.map((tag) => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded border border-white/20 bg-white/5 text-white/60">
              {tag}
            </span>
          ))}
        </div>
      )}
      {aug.notes && aug.notes.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/10 space-y-1">
          {aug.notes.map((note, i) => (
            <div key={i} className="text-[11px] text-amber-300/90 leading-snug">
              {note}
            </div>
          ))}
        </div>
      )}
      <div className="text-xs mt-2 text-white/50">
        {t(`availability_${aug.availability?.status ?? "unknown"}` as never)}
      </div>
    </div>
  );
}

// ─── Augment Card ────────────────────────────────────────────────────────────

function AugmentCard({
  augment,
  locale,
  rarityLabel,
}: {
  augment: ScoredAugment;
  locale: string;
  rarityLabel: string;
}) {
  const t = useTranslations("augments");
  const rarity = augment.rarity as keyof typeof RARITY_STYLES;
  const styles = RARITY_STYLES[rarity];
  const displayName = localizedName(augment, locale);

  return (
    <Tooltip content={<AugmentTooltip aug={augment} displayName={displayName} />}>
      <div
        className={`glass-card p-3 flex flex-col items-center gap-2 border border-[var(--color-border-default)] transition-all cursor-default ${styles.glow}`}
      >
        <div className="relative w-14 h-14 rounded-lg overflow-hidden shrink-0">
          <Image
            src={augment.icon}
            alt={augment.name}
            fill
            className="object-contain"
            sizes="56px"
            unoptimized
          />
        </div>
        <span className="text-xs font-medium text-center leading-tight line-clamp-2 w-full">
          {displayName}
        </span>
        <div className="flex flex-wrap justify-center gap-1 min-h-[14px]">
          {augment.flags?.lifecycle === "added" && (
            <span className="text-[9px] font-bold px-1 py-px rounded bg-green-500/20 text-green-300 border border-green-400/40">
              {t("badgeNew")}
            </span>
          )}
          {augment.flags?.lifecycle === "removed" && (
            <span className="text-[9px] font-bold px-1 py-px rounded bg-red-500/20 text-red-300 border border-red-400/40">
              {t("badgeRemoved")}
            </span>
          )}
          {augment.type === "ability" && (
            <span className="text-[9px] font-bold px-1 py-px rounded bg-sky-500/15 text-sky-300 border border-sky-400/30">
              {t("badgeAbility")}
            </span>
          )}
          {augment.type === "quest" && (
            <span className="text-[9px] font-bold px-1 py-px rounded bg-violet-500/15 text-violet-300 border border-violet-400/30">
              {t("badgeQuest")}
            </span>
          )}
        </div>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${styles.badge}`}
        >
          {rarityLabel}
        </span>
        {augment.availability?.status && augment.availability.status !== "confirmed_live" && (
          <div className="flex items-center justify-center w-full text-[10px] text-amber-300/90 mt-auto">
            {t(`availability_${augment.availability.status}` as never)}
          </div>
        )}
      </div>
    </Tooltip>
  );
}

function NotOfferedAugmentsTable({
  augments,
  locale,
}: {
  augments: ScoredAugment[];
  locale: string;
}) {
  const t = useTranslations("augments");
  const tChamp = useTranslations("champion");
  if (augments.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
          {t("removedArchiveTitle")}
        </h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          {t("removedArchiveSubtitle", { count: augments.length })}
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--color-border-default)]">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead className="bg-[var(--color-bg-card)] text-[var(--color-text-muted)]">
            <tr>
              <th className="px-3 py-2 font-medium">{t("removedArchiveName")}</th>
              <th className="px-3 py-2 font-medium">{t("removedArchiveRarity")}</th>
              <th className="px-3 py-2 font-medium">{t("statusColumn")}</th>
              <th className="px-3 py-2 font-medium">{t("removedArchiveVersion")}</th>
            </tr>
          </thead>
          <tbody>
            {augments.map((augment) => (
              <tr key={augment.slug} className="border-t border-[var(--color-border-default)]/70">
                <td className="px-3 py-2 text-[var(--color-text-secondary)]">
                  {localizedName(augment, locale)}
                </td>
                <td className="px-3 py-2 text-[var(--color-text-muted)]">
                  {tChamp(augment.rarity)}
                </td>
                <td
                  className={
                    augment.availability?.status === "disabled"
                      ? "px-3 py-2 text-amber-300/90"
                      : "px-3 py-2 text-[var(--color-text-muted)]"
                  }
                >
                  {t(`availability_${augment.availability?.status ?? "unknown"}` as never)}
                </td>
                <td className="px-3 py-2 text-red-300/85">
                  {/* First patch at which we OBSERVED this state — not a claim
                      about when Riot changed it. Unknown stays unknown. */}
                  {augment.flags?.lifecycle_observed_patch ?? t("patchUnknown")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
