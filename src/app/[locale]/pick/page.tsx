import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PickChooser } from "@/components/pick/PickChooser";
import type { Locale } from "@/i18n/routing";
import { readChampionsFile } from "@/lib/data/read-public-file";
import { localizedName, type LocalizedNameRecord } from "@/lib/i18n/localized-name";
import { loadIconIndex } from "@/lib/score/assets";
import { languageAlternates, localizedUrl } from "@/lib/site";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "pick" });
  return {
    title: t("chooseTitle"),
    description: t("chooseLead"),
    alternates: { canonical: localizedUrl("/pick", locale as Locale), languages: languageAlternates("/pick") },
  };
}

export default async function PickIndex({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { champions } = await readChampionsFile<{ champions: (LocalizedNameRecord & { slug: string })[] }>();
  const icons = loadIconIndex();
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  const list = champions
    .map((c) => ({ slug: c.slug, name: localizedName(c, locale), icon: icons.champion(c.slug) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  return <PickChooser champions={list} />;
}
