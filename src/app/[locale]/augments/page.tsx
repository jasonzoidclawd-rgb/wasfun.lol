import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AugmentsClient } from "@/components/augments/AugmentsClient";
import { DataProvenance } from "@/components/ui/DataProvenance";
import { DataFreshness } from "@/components/ui/DataFreshness";
import { readPatchClocks } from "@/lib/data/clocks";
import { normalizeAugmentSet } from "@/lib/data/augment-set";
import { readFile } from "fs/promises";
import path from "path";
import type { ScoredAugment } from "@/lib/scoring/oracle-score";
import type { Locale } from "@/i18n/routing";
import { languageAlternates, localizedUrl } from "@/lib/site";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "augments" });
  const route = "/augments";
  const title = t("metaTitle");
  const description = t("metaDescription");
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

export default async function AugmentsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("augments");

  const dataDir = path.join(process.cwd(), "public", "data");
  const augRaw = await readFile(path.join(dataDir, "augments.json"), "utf-8");

  const { augments } = JSON.parse(augRaw);
  const normalizedAugments = (augments as Array<ScoredAugment & { wikiSet?: string | null }>).map((augment) => ({
    ...augment,
    win_rate: augment.win_rate ?? null,
    set: normalizeAugmentSet(augment.set, augment.wikiSet),
  }));

  // Every count on this page names the population it counts. The old page
  // printed the live count and the homepage printed the array length, both
  // labelled "Augments" — two different numbers under one noun.
  const byStatus = (status: string) =>
    normalizedAugments.filter((augment) => augment.availability?.status === status).length;
  const liveCount = byStatus("confirmed_live");
  const disabledCount = byStatus("disabled");
  const removedCount = byStatus("removed");
  const unverifiedCount = byStatus("unverified_legacy");
  const candidateCount = byStatus("candidate_registry_present");

  // The catalog describes the CURRENT game, so it is stamped with the
  // structural patch — never with whatever patch the statistics lag on.
  const clocks = await readPatchClocks();

  return (
    <div className="py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-1">{t("title")}</h1>
        <p className="text-[var(--color-text-secondary)]">
          {clocks.structuralPatch
            ? t("subtitle", { count: liveCount, patch: clocks.structuralPatch })
            : t("subtitleNoPatch", { count: liveCount })}
        </p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          {/* Each number names its own resolved status. "Historical" bundled
              unverified and candidate entities, neither of which is historical. */}
          {t("population", {
            live: liveCount,
            disabled: disabledCount,
            removed: removedCount,
            unverified: unverifiedCount,
            candidate: candidateCount,
          })}
        </p>
        <DataFreshness />
        <DataProvenance locale={locale} />
      </header>
      <AugmentsClient augments={normalizedAugments} locale={locale} />
    </div>
  );
}
