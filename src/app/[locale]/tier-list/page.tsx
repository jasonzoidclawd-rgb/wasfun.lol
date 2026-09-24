import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AugmentTierRows } from "@/components/tiers/AugmentTierRows";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { loadIconIndex } from "@/lib/score/assets";
import { RARITIES } from "@/lib/score/engine";
import { loadScorePack } from "@/lib/score/pack";
import { tierRows } from "@/lib/score/tier-rows";
import { languageAlternates, localizedUrl } from "@/lib/site";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tiers" });
  const route = "/tier-list";
  return {
    title: t("indexTitle"),
    description: t("indexLead"),
    alternates: { canonical: localizedUrl(route, locale as Locale), languages: languageAlternates(route) },
  };
}

/** The augment tier lists' index: the top of each rarity, and a link to the full list. */
export default async function TierListIndex({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("tiers");
  const tp = await getTranslations("pick");
  const pack = loadScorePack();
  const icons = loadIconIndex();
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-bold">{t("indexTitle")}</h1>
      <p className="mt-1 text-[var(--color-text-secondary)]">{t("indexLead")}</p>
      {!pack && <p className="glass-card mt-4 p-4 text-[var(--color-text-secondary)]">{t("unavailable")}</p>}
      {pack &&
        RARITIES.map((r) => {
          const rows = tierRows(pack, r, locale, icons);
          const name = tp(`rarity_${r}`);
          return (
            <section key={r} className="glass-card mt-4 p-4" aria-labelledby={`tl-${r}`}>
              <h2 id={`tl-${r}`} className="text-lg font-bold">{t("title", { rarity: name })}</h2>
              <AugmentTierRows rows={rows.slice(0, 5)} />
              <Link href={`/tier-list/${r}`} className="mt-2 inline-flex min-h-11 items-center text-sm underline">
                {t("seeAll", { count: rows.length, rarity: name })}
              </Link>
            </section>
          );
        })}
      <p className="mt-3 text-sm">
        <Link href="/method" className="inline-flex min-h-11 items-center underline">{t("howWeRank")}</Link>
      </p>
    </div>
  );
}
