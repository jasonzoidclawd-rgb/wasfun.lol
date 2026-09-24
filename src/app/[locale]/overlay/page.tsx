import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Locale } from "@/i18n/routing";
import { overlayDownloadEnabled } from "@/lib/plans/flags";
import { languageAlternates, localizedUrl } from "@/lib/site";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "overlay" });
  return {
    title: t("title"),
    description: t("lead"),
    alternates: { canonical: localizedUrl("/overlay", locale as Locale), languages: languageAlternates("/overlay") },
    // not indexed until there is something to download
    ...(overlayDownloadEnabled() ? {} : { robots: { index: false, follow: true } }),
  };
}

/**
 * The overlay (v3): what the free overlay does. The download link is off
 * unless NEXT_PUBLIC_WASFUN_OVERLAY_DOWNLOAD is "on"; the Windows app itself
 * ships separately.
 */
export default async function OverlayPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("overlay");
  const features = ["letters", "topOutlined", "closeCall", "hide"] as const;
  return (
    <div className="mx-auto max-w-3xl py-8">
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-[var(--color-text-secondary)]">{t("lead")}</p>
      <section className="glass-card mt-6 p-5" aria-labelledby="overlay-free">
        <h2 id="overlay-free" className="text-lg font-bold">{t("freeHeading")}</h2>
        <ul className="mt-3 space-y-2 text-sm" role="list">
          {features.map((f) => (
            <li key={f}>• {t(`free_${f}`)}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">{t("rules")}</p>
      </section>
      <div className="mt-6">
        {overlayDownloadEnabled() ? (
          <>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a file download from an API route, not a page */}
            <a href="/api/downloads/overlay?platform=windows" className="inline-flex min-h-12 items-center rounded-xl bg-[var(--color-text-primary)] px-5 font-bold text-[var(--color-bg-primary)]">
              {t("download")}
            </a>
          </>
        ) : (
          <p className="text-sm text-[var(--color-text-secondary)]">{t("notYet")}</p>
        )}
      </div>
    </div>
  );
}
