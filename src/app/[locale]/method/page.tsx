import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Locale } from "@/i18n/routing";
import { languageAlternates, localizedUrl } from "@/lib/site";

const SECTIONS = ["sources", "estimand", "letters", "pick", "patch", "cannot"] as const;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "method" });
  return {
    title: t("title"),
    description: t("lead"),
    alternates: { canonical: localizedUrl("/method", locale as Locale), languages: languageAlternates("/method") },
  };
}

/** How we rank: the estimand, the data source and its limits, and what a letter means. */
export default async function MethodPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("method");
  return (
    <article className="mx-auto max-w-2xl px-4 py-6 leading-relaxed">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-[var(--color-text-secondary)]">{t("lead")}</p>
      {SECTIONS.map((s) => (
        <section key={s} className="mt-6">
          <h2 className="text-lg font-bold">{t(`${s}_h`)}</h2>
          <p className="mt-2 text-[var(--color-text-secondary)]">{t(`${s}_p`)}</p>
        </section>
      ))}
      <p className="mt-8 text-xs text-[var(--color-text-muted)]">{t("provenance")}</p>
    </article>
  );
}
