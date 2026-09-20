"use client";

import { useState, useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import Image from "next/image";
import { Link } from "@/i18n/navigation";
import type { ChampionEntry } from "@/app/[locale]/champions/page";
import { localizedName } from "@/lib/i18n/localized-name";
import { hasPickRateCoverage } from "@/lib/champions/pick-rate-coverage";

// ─── Constants ───────────────────────────────────────────────────────────────

type SortKey = "winrate" | "name" | "tier" | "hp" | "ad" | "as" | "range" | "ms";
type ViewMode = "tier" | "grid" | "table";

// Tier render order for the grouped Tier view.
const TIER_ORDER = ["S+", "S", "A", "B", "C", "D"] as const;

// Maps tier letter → tierList.tiers translation key (reused from the tier-list namespace).
const TIER_LABEL_KEY: Record<string, string> = {
  "S+": "god",
  S: "strong",
  A: "good",
  B: "average",
  C: "weak",
  D: "weak",
};

const TIER_COLOR: Record<string, string> = {
  "S+": "text-red-400",
  S: "text-orange-400",
  A: "text-yellow-400",
  B: "text-green-400",
  C: "text-blue-400",
  D: "text-slate-400",
};

const TIER_BG: Record<string, string> = {
  "S+": "bg-red-500/15 border-red-400/30",
  S: "bg-orange-500/15 border-orange-400/30",
  A: "bg-yellow-500/10 border-yellow-400/30",
  B: "bg-green-500/10 border-green-400/30",
  C: "bg-blue-500/10 border-blue-400/30",
  D: "bg-slate-500/10 border-slate-400/30",
};

const CLASS_COLOR: Record<string, string> = {
  Juggernaut: "text-red-300 bg-red-500/10 border-red-400/20",
  Diver: "text-orange-300 bg-orange-500/10 border-orange-400/20",
  Assassin: "text-purple-300 bg-purple-500/10 border-purple-400/20",
  Skirmisher: "text-amber-300 bg-amber-500/10 border-amber-400/20",
  Marksman: "text-green-300 bg-green-500/10 border-green-400/20",
  Burst: "text-blue-300 bg-blue-500/10 border-blue-400/20",
  Battlemage: "text-indigo-300 bg-indigo-500/10 border-indigo-400/20",
  Artillery: "text-cyan-300 bg-cyan-500/10 border-cyan-400/20",
  Enchanter: "text-pink-300 bg-pink-500/10 border-pink-400/20",
  Catcher: "text-teal-300 bg-teal-500/10 border-teal-400/20",
  Vanguard: "text-yellow-300 bg-yellow-500/10 border-yellow-400/20",
  Warden: "text-slate-300 bg-slate-500/10 border-slate-400/20",
  Specialist: "text-emerald-300 bg-emerald-500/10 border-emerald-400/20",
};

// WR thresholds tuned for AA contrast (≥4.5:1) on the #0a0e17 background:
// the *-400 Tailwind tints all clear that bar against deep navy.
const WR_COLOR = (wr: number | null) => {
  if (wr == null) return "text-slate-500";
  if (wr >= 54) return "text-red-400";
  if (wr >= 52) return "text-orange-400";
  if (wr >= 50) return "text-green-400";
  if (wr >= 48) return "text-blue-400";
  return "text-slate-400";
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statAtLevel(base: number, growth: number, level: number): number {
  return base + growth * (level - 1) * (0.7025 + 0.0175 * (level - 1));
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ChampionsIndex({
  champions,
}: {
  champions: ChampionEntry[];
}) {
  const locale = useLocale();
  const t = useTranslations("championsIndex");
  const tTier = useTranslations("tierList");
  const [view, setView] = useState<ViewMode>("tier");
  const [search, setSearch] = useState("");
  const [activeClass, setActiveClass] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortKey>("winrate");
  const [level, setLevel] = useState(11);

  // A column of 173 em-dashes is not data. Measured from the roster, so the
  // column returns by itself if the source starts publishing pick rate again.
  const showPickRate = useMemo(() => hasPickRateCoverage(champions), [champions]);

  // Collect unique classes
  const allClasses = useMemo(() => {
    const set = new Set<string>();
    for (const c of champions) {
      for (const cl of c.classes ?? []) set.add(cl);
    }
    return ["all", ...Array.from(set).sort()];
  }, [champions]);

  // Filter
  const filtered = useMemo(() => {
    return champions.filter((c) => {
      const q = search.toLowerCase();
      const nameMatch =
        !search ||
        c.name.toLowerCase().includes(q) ||
        localizedName(c, locale).toLowerCase().includes(q) ||
        (c.title ?? "").toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q)) ||
        (c.classes ?? []).some((cl) => cl.toLowerCase().includes(q));
      const classMatch =
        activeClass === "all" || (c.classes ?? []).includes(activeClass);
      return nameMatch && classMatch;
    });
  }, [champions, search, activeClass, locale]);

  // Sort (drives Grid + Table views)
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "winrate":
          return (b.win_rate ?? 0) - (a.win_rate ?? 0);
        case "name":
          return a.name.localeCompare(b.name);
        case "tier":
          return (a.rank ?? 999) - (b.rank ?? 999);
        case "hp":
          return (
            statAtLevel(b.baseStats?.baseHP ?? 0, b.baseStats?.hpGrowth ?? 0, level) -
            statAtLevel(a.baseStats?.baseHP ?? 0, a.baseStats?.hpGrowth ?? 0, level)
          );
        case "ad":
          return (
            statAtLevel(b.baseStats?.baseAD ?? 0, b.baseStats?.adGrowth ?? 0, level) -
            statAtLevel(a.baseStats?.baseAD ?? 0, a.baseStats?.adGrowth ?? 0, level)
          );
        case "as":
          return (b.baseStats?.baseAS ?? 0) - (a.baseStats?.baseAS ?? 0);
        case "range":
          return (b.baseStats?.attackRange ?? 0) - (a.baseStats?.attackRange ?? 0);
        case "ms":
          return (b.baseStats?.moveSpeed ?? 0) - (a.baseStats?.moveSpeed ?? 0);
        default:
          return 0;
      }
    });
  }, [filtered, sortBy, level]);

  // Group filtered champions into tiers (Tier view); within a tier, strongest WR first.
  const tierGroups = useMemo(() => {
    const groups: Record<string, ChampionEntry[]> = {};
    for (const c of filtered) {
      (groups[c.tier] ??= []).push(c);
    }
    for (const tier of Object.keys(groups)) {
      groups[tier].sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0));
    }
    return groups;
  }, [filtered]);

  // Class counts
  const classCounts = useMemo(() => {
    const counts: Record<string, number> = { all: champions.length };
    for (const c of champions) {
      for (const cl of c.classes ?? []) {
        counts[cl] = (counts[cl] ?? 0) + 1;
      }
    }
    return counts;
  }, [champions]);

  const VIEWS: { id: ViewMode; label: string }[] = [
    { id: "tier", label: t("viewTier") },
    { id: "grid", label: t("viewGrid") },
    { id: "table", label: t("viewTable") },
  ];

  return (
    <div>
      {/* ─── Controls ─── */}
      <div className="space-y-3 mb-6">
        {/* Row 1: View toggle + search + sort */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="segmented" role="tablist" aria-label={t("viewLabel")}>
            {VIEWS.map((v) => (
              <button
                key={v.id}
                role="tab"
                onClick={() => setView(v.id)}
                aria-selected={view === v.id}
                className={`seg-item min-h-[48px] sm:min-h-0 ${
                  view === v.id ? "seg-item-active" : ""
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <span className="hidden sm:block w-px h-6 bg-[var(--color-border-default)] mx-1" />
          <input
            type="search"
            placeholder={t("searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-0 sm:min-w-[180px] sm:max-w-xs min-h-[48px] sm:min-h-0 px-3 py-1.5 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] text-sm focus:outline-none focus:border-[var(--color-neon-primary)]/50"
          />
          {/* Sort/level only affect Grid + Table; Tier view groups by tier. */}
          {view !== "tier" && (
            <>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
                className="min-h-[48px] sm:min-h-0 px-3 py-1.5 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] text-sm"
              >
                <option value="winrate">{t("sortWinRate")}</option>
                <option value="tier">{t("sortTier")}</option>
                <option value="name">{t("sortName")}</option>
                <option value="hp">{t("sortHp", { level })}</option>
                <option value="ad">{t("sortAd", { level })}</option>
                <option value="as">{t("sortBaseAs")}</option>
                <option value="range">{t("sortRange")}</option>
                <option value="ms">{t("sortMs")}</option>
              </select>
              {(sortBy === "hp" || sortBy === "ad") && (
                <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                  <span>{t("levelAbbr")}</span>
                  <input
                    type="range"
                    min={1}
                    max={18}
                    value={level}
                    onChange={(e) => setLevel(Number(e.target.value))}
                    className="w-20 accent-[var(--color-neon-primary)]"
                  />
                  <span className="w-5 text-center font-mono tabular-nums">{level}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Row 2: Class filters */}
        <div className="flex flex-wrap gap-1.5">
          {allClasses.map((cl) => (
            <button
              key={cl}
              onClick={() => setActiveClass(cl)}
              aria-pressed={activeClass === cl}
              className={`min-h-[48px] sm:min-h-0 px-3 sm:px-2.5 py-1 rounded text-xs font-medium border transition-all ${
                activeClass === cl
                  ? cl === "all"
                    ? "bg-[var(--color-neon-primary)]/15 text-[var(--color-neon-primary)] border-[var(--color-neon-primary)]/40"
                    : CLASS_COLOR[cl] ?? "bg-white/10 text-white border-white/20"
                  : "bg-[var(--color-bg-card)] text-[var(--color-text-muted)] border-[var(--color-border-default)]"
              }`}
            >
              {cl === "all" ? t("allClasses") : cl}
              <span className="ml-1 opacity-50 tabular-nums">{classCounts[cl] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ─── Tier View ─── */}
      {view === "tier" ? (
        <div className="space-y-8">
          {TIER_ORDER.map((tier) => {
            const champs = tierGroups[tier];
            if (!champs?.length) return null;
            return (
              <section key={tier}>
                <div className="flex items-center gap-3 mb-3">
                  <span
                    className={`px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wide border ${
                      TIER_BG[tier] ?? ""
                    } ${TIER_COLOR[tier] ?? "text-slate-400"}`}
                  >
                    {tTier(`tiers.${TIER_LABEL_KEY[tier] ?? "weak"}`)}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)] tabular-nums">
                    ({champs.length})
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
                  {champs.map((c) => (
                    <ChampionCard key={c.slug} champion={c} />
                  ))}
                </div>
              </section>
            );
          })}
          {filtered.length === 0 && <EmptyState text={tTier("noResults")} />}
        </div>
      ) : view === "grid" ? (
        /* ─── Grid View ─── */
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
          {sorted.map((c) => (
            <ChampionCard key={c.slug} champion={c} />
          ))}
          {sorted.length === 0 && (
            <div className="col-span-full">
              <EmptyState text={tTier("noResults")} />
            </div>
          )}
        </div>
      ) : (
        /* ─── Table View (desktop table → mobile cards below md) ─── */
        <>
          {/* Mobile: card list */}
          <div className="md:hidden space-y-2">
            {sorted.map((c, i) => (
              <ChampionRowCard key={c.slug} champion={c} index={i} level={level} />
            ))}
            {sorted.length === 0 && <EmptyState text={tTier("noResults")} />}
          </div>

          {/* Desktop: dense data table */}
          <div className="hidden md:block overflow-x-auto rounded-xl border border-[var(--color-border-default)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border-default)] bg-[var(--color-bg-card)]/80">
                  {[
                    { h: "#", hide: false },
                    { h: "Champion", hide: false },
                    { h: "Class", hide: "mobile" as const },
                    { h: "Tier", hide: false },
                    { h: "WR%", hide: false },
                    ...(showPickRate
                      ? [{ h: "Pick%", hide: "mobile" as const }]
                      : []),
                    { h: `HP@${level}`, hide: "mobile" as const },
                    { h: `AD@${level}`, hide: "mobile" as const },
                    { h: "AS", hide: "tablet" as const },
                    { h: "Range", hide: "tablet" as const },
                    { h: "MS", hide: "tablet" as const },
                    { h: "Armor", hide: "tablet" as const },
                    { h: "MR", hide: "tablet" as const },
                  ].map(({ h, hide }) => (
                    <th
                      key={h}
                      className={`px-2 py-2.5 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] font-semibold ${
                        h === "Champion" || h === "Class" ? "text-left" : "text-right"
                      } ${h === "#" ? "w-8 text-center" : ""} ${
                        hide === "mobile" ? "hidden lg:table-cell" : hide === "tablet" ? "hidden xl:table-cell" : ""
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((c, i) => {
                  const bs = c.baseStats;
                  const hp = bs ? statAtLevel(bs.baseHP, bs.hpGrowth, level) : 0;
                  const ad = bs ? statAtLevel(bs.baseAD, bs.adGrowth, level) : 0;
                  const armor = bs ? statAtLevel(bs.baseArmor, bs.armorGrowth, level) : 0;
                  const mr = bs ? statAtLevel(bs.baseMR, bs.mrGrowth, level) : 0;
                  return (
                    <tr
                      key={c.slug}
                      className={`border-b border-[var(--color-border-default)] hover:bg-[var(--color-bg-card)]/40 transition-colors ${
                        i % 2 ? "bg-[var(--color-bg-card)]/20" : ""
                      }`}
                    >
                      <td className="px-2 py-2 text-center text-[var(--color-text-muted)] text-xs tabular-nums">
                        {c.rank ?? i + 1}
                      </td>
                      <td className="px-2 py-2">
                        <Link
                          href={`/champions/${c.slug}`}
                          className="flex items-center gap-2 hover:text-[var(--color-neon-primary)] transition-colors"
                        >
                          <Image
                            src={c.icon}
                            alt={localizedName(c, locale)}
                            width={28}
                            height={28}
                            className="rounded shrink-0"
                            unoptimized
                          />
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{localizedName(c, locale)}</div>
                            {c.title && (
                              <div className="text-[10px] text-[var(--color-text-muted)] truncate">
                                {c.title}
                              </div>
                            )}
                          </div>
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-left hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {(c.classes ?? c.tags).map((cl) => (
                            <span
                              key={cl}
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${
                                CLASS_COLOR[cl] ?? "text-slate-300 bg-slate-500/10 border-slate-400/20"
                              }`}
                            >
                              {cl}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <span
                          className={`text-xs font-bold px-1.5 py-0.5 rounded border ${
                            TIER_BG[c.tier] ?? ""
                          } ${TIER_COLOR[c.tier] ?? "text-slate-400"}`}
                        >
                          {c.tier}
                        </span>
                      </td>
                      <NumCell className={WR_COLOR(c.win_rate)}>
                        {c.win_rate?.toFixed(1) ?? "—"}
                      </NumCell>
                      {showPickRate ? (
                        <NumCell className="text-[var(--color-text-muted)] hidden lg:table-cell">
                          {c.pick_rate?.toFixed(1) ?? "—"}
                        </NumCell>
                      ) : null}
                      <NumCell className="hidden lg:table-cell">{hp.toFixed(0)}</NumCell>
                      <NumCell className="hidden lg:table-cell">{ad.toFixed(1)}</NumCell>
                      <NumCell className="hidden xl:table-cell">{bs?.baseAS.toFixed(3) ?? "—"}</NumCell>
                      <NumCell className="hidden xl:table-cell">{bs?.attackRange ?? "—"}</NumCell>
                      <NumCell className="hidden xl:table-cell">{bs?.moveSpeed ?? "—"}</NumCell>
                      <NumCell className="hidden xl:table-cell">{armor.toFixed(0)}</NumCell>
                      <NumCell className="hidden xl:table-cell">{mr.toFixed(0)}</NumCell>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="text-xs text-[var(--color-text-muted)] mt-6 text-center">
        {t("statsFooter", { count: view === "tier" ? filtered.length : sorted.length, total: champions.length })}
      </p>
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState({ text }: { text: string }) {
  return (
    <p className="text-center text-[var(--color-text-muted)] py-16">{text}</p>
  );
}

// ─── Grid Card ───────────────────────────────────────────────────────────────

function ChampionCard({
  champion: c,
}: {
  champion: ChampionEntry;
}) {
  const locale = useLocale();
  const name = localizedName(c, locale);
  return (
    <Link
      href={`/champions/${c.slug}`}
      className="glass-card p-3 flex flex-col items-center gap-2 border border-[var(--color-border-default)] transition-all group hover:scale-[1.03] hover:border-[var(--color-neon-primary)]/40 hover:shadow-lg"
    >
      <div className="relative">
        <Image
          src={c.icon}
          alt={name}
          width={56}
          height={56}
          className="rounded-lg border border-[var(--color-border-default)] group-hover:border-[var(--color-neon-primary)]/50 transition-colors"
          unoptimized
        />
        <span
          className={`absolute -top-1.5 -right-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded border ${
            TIER_BG[c.tier] ?? ""
          } ${TIER_COLOR[c.tier] ?? ""}`}
        >
          {c.tier}
        </span>
      </div>

      <div className="text-center w-full min-w-0">
        <div className="text-xs font-bold truncate group-hover:text-[var(--color-text-primary)] transition-colors">
          {name}
        </div>
        {c.title && (
          <div className="text-[9px] text-[var(--color-text-muted)] truncate leading-tight">
            {c.title}
          </div>
        )}
      </div>

      {/* Classes */}
      <div className="flex flex-wrap justify-center gap-1">
        {(c.classes ?? c.tags).slice(0, 2).map((cl) => (
          <span
            key={cl}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${
              CLASS_COLOR[cl] ?? "text-slate-300 bg-slate-500/10 border-slate-400/20"
            }`}
          >
            {cl}
          </span>
        ))}
      </div>

      {/* WR + Pick */}
      <div className="flex justify-between w-full text-[10px] mt-auto tabular-nums">
        <span className={`font-bold ${WR_COLOR(c.win_rate)}`}>
          {c.win_rate != null ? `${c.win_rate.toFixed(1)}%` : "—"}
        </span>
        <span className="text-[var(--color-text-muted)]">
          {c.pick_rate != null ? `${c.pick_rate.toFixed(1)}%` : ""}
        </span>
      </div>

      {/* Key stats */}
      {c.baseStats && (
        <div className="grid grid-cols-3 gap-x-2 w-full text-[9px] text-[var(--color-text-muted)] border-t border-[var(--color-border-default)] pt-1.5 mt-0.5">
          <StatMini label="HP" value={c.baseStats.baseHP.toString()} />
          <StatMini label="AD" value={c.baseStats.baseAD.toString()} />
          <StatMini label="AS" value={c.baseStats.baseAS.toFixed(2)} />
        </div>
      )}
    </Link>
  );
}

// ─── Mobile table row → card ─────────────────────────────────────────────────

function ChampionRowCard({
  champion: c,
  index,
  level,
}: {
  champion: ChampionEntry;
  index: number;
  level: number;
}) {
  const locale = useLocale();
  const name = localizedName(c, locale);
  const bs = c.baseStats;
  const hp = bs ? statAtLevel(bs.baseHP, bs.hpGrowth, level) : 0;
  const ad = bs ? statAtLevel(bs.baseAD, bs.adGrowth, level) : 0;

  return (
    <Link
      href={`/champions/${c.slug}`}
      className="glass-card flex items-center gap-3 p-3 border border-[var(--color-border-default)] transition-all hover:border-[var(--color-neon-primary)]/40"
    >
      <span className="w-5 text-center text-xs text-[var(--color-text-muted)] tabular-nums shrink-0">
        {c.rank ?? index + 1}
      </span>
      <Image
        src={c.icon}
        alt={name}
        width={40}
        height={40}
        className="rounded-lg border border-[var(--color-border-default)] shrink-0"
        unoptimized
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold truncate">{name}</span>
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${
              TIER_BG[c.tier] ?? ""
            } ${TIER_COLOR[c.tier] ?? "text-slate-400"}`}
          >
            {c.tier}
          </span>
        </div>
        <div className="flex flex-wrap gap-1 mt-0.5">
          {(c.classes ?? c.tags).slice(0, 3).map((cl) => (
            <span
              key={cl}
              className={`text-[9px] px-1.5 py-0.5 rounded border ${
                CLASS_COLOR[cl] ?? "text-slate-300 bg-slate-500/10 border-slate-400/20"
              }`}
            >
              {cl}
            </span>
          ))}
        </div>
      </div>
      <div className="text-right shrink-0 tabular-nums">
        <div className={`text-sm font-bold ${WR_COLOR(c.win_rate)}`}>
          {c.win_rate != null ? `${c.win_rate.toFixed(1)}%` : "—"}
        </div>
        {bs && (
          <div className="text-[10px] text-[var(--color-text-muted)] leading-tight">
            HP {hp.toFixed(0)} · AD {ad.toFixed(0)}
          </div>
        )}
      </div>
    </Link>
  );
}

function StatMini({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-[var(--color-text-muted)]/60">{label}</div>
      <div className="text-[var(--color-text-secondary)] font-medium tabular-nums">{value}</div>
    </div>
  );
}

function NumCell({
  children,
  className = "text-[var(--color-text-secondary)]",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-2 py-2 text-right tabular-nums text-xs ${className}`}>
      {children}
    </td>
  );
}
