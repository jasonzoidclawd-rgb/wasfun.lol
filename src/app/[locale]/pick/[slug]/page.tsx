import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PickScreen } from "@/components/pick/PickScreen";
import { routing, type Locale } from "@/i18n/routing";
import { readChampionsFile } from "@/lib/data/read-public-file";
import { localizedName, type LocalizedNameRecord } from "@/lib/i18n/localized-name";
import { loadIconIndex, loadItemNames } from "@/lib/score/assets";
import { loadScorePack } from "@/lib/score/pack";
import { buildPickPayload } from "@/lib/score/pick-payload";
import { languageAlternates, localizedUrl } from "@/lib/site";

type Champ = LocalizedNameRecord & { slug: string };

export const dynamicParams = false;

export async function generateStaticParams() {
  const { champions } = await readChampionsFile<{ champions: Champ[] }>();
  return routing.locales.flatMap((locale) => champions.map((c) => ({ locale, slug: c.slug })));
}

async function champion(slug: string): Promise<Champ | undefined> {
  const { champions } = await readChampionsFile<{ champions: Champ[] }>();
  return champions.find((c) => c.slug === slug);
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }): Promise<Metadata> {
  const { locale, slug } = await params;
  const c = await champion(slug);
  if (!c) return {};
  const t = await getTranslations({ locale, namespace: "pick" });
  const name = localizedName(c, locale);
  const route = `/pick/${slug}`;
  return {
    title: t("metaTitle", { champion: name }),
    description: t("metaDescription", { champion: name }),
    alternates: { canonical: localizedUrl(route, locale as Locale), languages: languageAlternates(route) },
  };
}

export default async function PickPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const c = await champion(slug);
  if (!c) notFound();
  const t = await getTranslations("pick");
  const pack = loadScorePack();
  const payload = pack
    ? buildPickPayload({ pack, slug, locale, championRecord: c, icons: loadIconIndex(), items: loadItemNames() })
    : null;
  if (!payload) {
    // Kill switch off (or no data): no grade and no augment number is rendered.
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold">{localizedName(c, locale)}</h1>
        <p className="mt-4 text-[var(--color-text-secondary)]">{t("unavailable")}</p>
      </div>
    );
  }
  return <PickScreen payload={payload} />;
}
