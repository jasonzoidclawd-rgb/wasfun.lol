import type { Metadata } from "next";
import { AdSlot } from "@/components/ads/AdSlot";
import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  PatchNotesView,
  type RemovedPatchAugment,
} from "@/components/patch-notes/PatchNotesView";
import { PbePreview, type PbePreviewData } from "@/components/patch-notes/PbePreview";
import type { PatchNotesData } from "@/lib/types";
import {
  readAugmentsFile,
  readPatchNotesFile,
  readPbePreviewFile,
} from "@/lib/data/read-public-file";
import type { Locale } from "@/i18n/routing";
import { languageAlternates, localizedUrl } from "@/lib/site";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildPatchNotesJsonLd } from "@/lib/patch-notes/seo";

async function loadPatchNotes(): Promise<PatchNotesData | null> {
  try {
    return await readPatchNotesFile<PatchNotesData>();
  } catch {
    return null;
  }
}

async function loadPbePreview(): Promise<PbePreviewData | null> {
  try {
    return await readPbePreviewFile<PbePreviewData>();
  } catch {
    return null;
  }
}

async function loadRemovedAugments(): Promise<RemovedPatchAugment[]> {
  try {
    const data = await readAugmentsFile<{ augments: RemovedPatchAugment[] }>();
    // `flags.lifecycle` collapses disabled / removed / unverified / candidate
    // onto "removed". Partition on the resolved verdict instead, and order by
    // state first — most lifecycle dates are genuinely unknown, so sorting by
    // date would order the table by an absent value.
    const STATE_ORDER: Record<string, number> = {
      disabled: 0,
      removed: 1,
      unverified_legacy: 2,
      candidate_registry_present: 3,
    };
    return data.augments
      .filter(
        (augment) =>
          augment.availability?.status &&
          augment.availability.status !== "confirmed_live",
      )
      .sort((a, b) => {
        const rank =
          (STATE_ORDER[a.availability?.status ?? ""] ?? 9) -
          (STATE_ORDER[b.availability?.status ?? ""] ?? 9);
        return rank || a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const [t, data] = await Promise.all([
    getTranslations({ locale, namespace: "patchNotes" }),
    loadPatchNotes(),
  ]);
  const route = "/patch-notes";
  const title = data?.patch
    ? `${t("patchLabel", { patch: data.patch })} · ${t("title")}`
    : t("title");
  const description = data?.patch
    ? `${t("subtitle")} · ${t("patchLabel", { patch: data.patch })}`
    : t("subtitle");
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

export default async function PatchNotesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("patchNotes");
  const [data, removedAugments, pbePreview] = await Promise.all([
    loadPatchNotes(),
    loadRemovedAugments(),
    loadPbePreview(),
  ]);
  const route = "/patch-notes";
  const url = localizedUrl(route, locale as Locale);
  const title = data?.patch
    ? `${t("patchLabel", { patch: data.patch })} · ${t("title")}`
    : t("title");
  const description = data?.patch
    ? `${t("subtitle")} · ${t("patchLabel", { patch: data.patch })}`
    : t("subtitle");
  const jsonLd = data
    ? buildPatchNotesJsonLd(data, locale as Locale, {
        url,
        title,
        description,
        breadcrumbLabel: t("title"),
        patchLabel: (patch) => t("patchLabel", { patch }),
      })
    : null;

  return (
    <div className="py-8">
      {jsonLd ? <JsonLd data={jsonLd} /> : null}
      <header className="mb-8">
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="mt-1 text-[var(--color-text-secondary)]">
          {t("subtitle")}
          {data?.patch ? ` · ${t("patchLabel", { patch: data.patch })}` : ""}
        </p>
      </header>
      <AdSlot slot="public-patch-notes" />
      {data ? (
        <>
          <PatchNotesView data={data} locale={locale} removedAugments={removedAugments} />
          <PbePreview data={pbePreview} locale={locale} />
        </>
      ) : (
        <div className="glass-card p-8 text-center text-[var(--color-text-muted)]">
          {t("noData")}
        </div>
      )}
    </div>
  );
}
