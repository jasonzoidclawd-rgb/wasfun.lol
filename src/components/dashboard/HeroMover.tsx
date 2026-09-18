import { getTranslations, getLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { localizedName, type LocalizedNameRecord } from "@/lib/i18n/localized-name";
import { tierBadgeClass } from "./tier-style";

export type HeroChampion = LocalizedNameRecord & {
  slug: string;
  tier: string;
  rank: number;
  win_rate: number;
  pick_rate: number | null;
  icon: string;
};

export async function HeroMover({
  champion,
  total,
  patch,
}: {
  champion: HeroChampion;
  total: number;
  patch: string;
}) {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const name = localizedName(champion, locale);

  return (
    <div className="glass-card reveal flex items-center gap-4 p-4 md:col-span-6 lg:col-span-8">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={champion.icon} alt="" className="h-16 w-16 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-[var(--color-text-muted)]">{t("heroTopMover", { patch })}</p>
        <div className="mt-1 flex items-center gap-2">
          <h3 className="truncate text-lg font-semibold text-[var(--color-text-primary)]">{name}</h3>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${tierBadgeClass(champion.tier)}`}>
            {champion.tier}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-[var(--color-text-secondary)]">
          <span>{t("heroRank", { rank: champion.rank, total })}</span>
          <span>
            {champion.win_rate.toFixed(1)}% <span className="text-[var(--color-text-muted)]">{t("heroWinRate")}</span>
          </span>
          {/* "— pick" labels a number we do not have. Drop the whole stat
              rather than print a placeholder next to a real one. */}
          {champion.pick_rate != null ? (
            <span>
              {champion.pick_rate.toFixed(1)}%{" "}
              <span className="text-[var(--color-text-muted)]">{t("heroPickRate")}</span>
            </span>
          ) : null}
        </div>
      </div>
      <Link
        href={`/champions/${champion.slug}`}
        className="flex min-h-11 shrink-0 items-center rounded-lg border border-[var(--color-border-default)] px-3 text-sm text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border-hover)]"
      >
        {t("heroCta", { name })}
      </Link>
    </div>
  );
}
