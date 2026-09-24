import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AugmentTierRows } from "@/components/tiers/AugmentTierRows";
import { Link } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";
import { loadIconIndex } from "@/lib/score/assets";
import { RARITIES, type Rarity } from "@/lib/score/engine";
import { loadScorePack } from "@/lib/score/pack";
import { tierRows } from "@/lib/score/tier-rows";
import { languageAlternates, localizedUrl } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return routing.locales.flatMap((locale) => RARITIES.map((rarity) => ({ locale, rarity })));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string; rarity: string }> }): Promise<Metadata> {
  const { locale, rarity } = await params;
  if (!RARITIES.includes(rarity as Rarity)) return {};
  const t = await getTranslations({ locale, namespace: "tiers" });
  const tp = await getTranslations({ locale, namespace: "pick" });
  const name = tp(`rarity_${rarity}`);
  const route = `/tier-list/${rarity}`;
  return {
    title: t("title", { rarity: name }),
    description: t("metaDescription", { rarity: name }),
    alternates: { canonical: localizedUrl(route, locale as Locale), languages: languageAlternates(route) },
  };
}

export default async function RarityTierList({ params }: { params: Promise<{ locale: string; rarity: string }> }) {
  const { locale, rarity } = await params;
  if (!RARITIES.includes(rarity as Rarity)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("tiers");
  const tp = await getTranslations("pick");
  const name = tp(`rarity_${rarity}`);
  const pack = loadScorePack();
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-bold">{t("title", { rarity: name })}</h1>
      <p className="mt-1 text-[var(--color-text-secondary)]">{t("lead", { rarity: name })}</p>
      <nav className="mt-3 flex gap-2" aria-label={t("indexTitle")}>
        {RARITIES.map((r) => (
          <Link
            key={r}
            href={`/tier-list/${r}`}
            aria-current={r === rarity ? "page" : undefined}
            className={`min-h-11 rounded-lg border px-3 py-2 text-sm ${r === rarity ? "border-[var(--color-text-primary)] font-semibold" : "border-[var(--color-border-default)]"}`}
          >
            {tp(`rarity_${r}`)}
          </Link>
        ))}
      </nav>
      {pack ? (
        <section className="glass-card mt-4 p-4">
          <AugmentTierRows rows={tierRows(pack, rarity as Rarity, locale, loadIconIndex())} />
          <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">{t("legend", { rarity: name })}</p>
        </section>
      ) : (
        <p className="glass-card mt-4 p-4 text-[var(--color-text-secondary)]">{t("unavailable")}</p>
      )}
      <p className="mt-3 text-sm">
        <Link href="/method" className="underline">{t("howWeRank")}</Link>
      </p>
    </div>
  );
}
