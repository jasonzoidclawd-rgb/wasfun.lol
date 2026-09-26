import type { Metadata } from "next";
import { V3AdSlot } from "@/components/ads/V3AdSlot";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { JsonLd } from "@/components/seo/JsonLd";
import { routing, type Locale } from "@/i18n/routing";
import { localizedName } from "@/lib/i18n/localized-name";
import { languageAlternates, localizedUrl } from "@/lib/site";
import { buildAugmentDetailJsonLd } from "@/lib/seo/augment-detail";
import { buildPatchSummary } from "@/lib/seo/patch-summary";
import { readPatchClocks } from "@/lib/data/clocks";

// Each resolved availability status gets its own sentence. Collapsing them
// onto "removed" is what made disabled augments read as deleted.
const AVAILABILITY_SUMMARY_KEYS: Record<string, string> = {
  disabled: "patchSummaryDisabled",
  removed: "patchSummaryRemoved",
  unverified_legacy: "patchSummaryUnverified",
  candidate_registry_present: "patchSummaryCandidate",
};
import { readAugmentsFile } from "@/lib/data/read-public-file";
import type { AugmentRarity, AugmentType } from "@/lib/types";
import { LetterChip } from "@/components/grades/LetterChip";
import { loadScorePack } from "@/lib/score/pack";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AugmentRecord {
  slug: string;
  name: string;
  rarity: AugmentRarity;
  type?: AugmentType;
  icon?: string;
  wikiDescription?: string;
  kit_tags?: string[];
  name_zh_TW?: string;
  name_zh_CN?: string;
  name_ja?: string;
  name_ko?: string;
  availability?: { status?: string };
  flags?: {
    lifecycle?: string;
    lifecycle_patch?: string;
    lifecycle_event?: string;
    lifecycle_provenance?: string;
  };
}

interface AugmentsData {
  patch?: string;
  augments: AugmentRecord[];
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

async function loadAugmentsData(): Promise<AugmentsData> {
  return readAugmentsFile<AugmentsData>();
}

async function loadAugments(): Promise<AugmentRecord[]> {
  const data = await loadAugmentsData();
  return data.augments;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const RARITY_BADGE: Record<AugmentRarity, string> = {
  prismatic: "rarity-prismatic border-current",
  gold: "rarity-gold border-current",
  silver: "rarity-silver border-current",
};

// ─── Static params ────────────────────────────────────────────────────────────

export const dynamicParams = false;

export async function generateStaticParams() {
  // No try/catch: with dynamicParams=false a data read failure must fail the
  // build loudly instead of publishing a site with zero augment pages.
  const augments = await loadAugments();
  return routing.locales.flatMap((locale) =>
    augments.map((augment) => ({ locale, slug: augment.slug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: "augments" });
  const tChamp = await getTranslations({ locale, namespace: "champion" });
  const augmentsData = await loadAugmentsData();
  const augments = augmentsData.augments;
  const augment = augments.find((a) => a.slug === slug);
  if (!augment) notFound();

  const name = localizedName(augment, locale);
  const rarity = {
    prismatic: tChamp("prismatic"),
    gold: tChamp("gold"),
    silver: tChamp("silver"),
  }[augment.rarity];
  const route = `/augments/${augment.slug}`;
  const title = t("metaDetailTitle", { name, rarity });
  const description = t("metaDetailDescription", { name, rarity });
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function AugmentDetailPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("augments");
  const tChamp = await getTranslations("champion");

  const augmentsData = await loadAugmentsData();
  const augments = augmentsData.augments;
  const augment = augments.find((a) => a.slug === slug);
  if (!augment) notFound();

  const augmentName = localizedName(augment, locale);
  const rarityLabel: Record<AugmentRarity, string> = {
    prismatic: tChamp("prismatic"),
    gold: tChamp("gold"),
    silver: tChamp("silver"),
  };

  const typeBadgeKey =
    augment.type === "ability"
      ? "badgeAbility"
      : augment.type === "quest"
        ? "badgeQuest"
        : null;


  // v3: the tier list's letter (graded across all champions), when statistics are on
  const pack = loadScorePack();
  // the public catalog carries no augment id: resolve it through the internal catalog
  const augmentId = pack ? [...pack.catalog.values()].find((a) => a.slug === augment.slug)?.augmentId : undefined;
  const graded = augmentId ? (pack!.tierLists[augment.rarity].find((o) => o.id === augmentId) ?? null) : null;
  const tt = await getTranslations("tiers");
  const tp = await getTranslations("pick");

  const wikiUrl = `https://wiki.leagueoflegends.com/en-us/${encodeURIComponent(
    augment.name.replace(/ /g, "_"),
  )}`;
  const route = `/augments/${augment.slug}`;
  const pageUrl = localizedUrl(route, locale as Locale);
  const augmentJsonLd = buildAugmentDetailJsonLd(augment, locale, {
    url: pageUrl,
    homeUrl: localizedUrl("/", locale as Locale),
    name: augmentName,
    description:
      augment.wikiDescription ??
      t("metaDetailDescription", {
        name: augmentName,
        rarity: rarityLabel[augment.rarity],
      }),
    augmentsUrl: localizedUrl("/augments", locale as Locale),
    augmentsLabel: t("title"),
    rarityLabel: rarityLabel[augment.rarity],
  });
  // The augment catalog describes CURRENT game rules, so it is stamped with
  // the structural clock, not with whatever patch the statistics feed has
  // finished aggregating.
  const clocks = await readPatchClocks();
  const patchSummary = buildPatchSummary(
    {
      patch: clocks.structuralPatch,
      availabilityStatus: augment.availability?.status,
      lifecyclePatch: augment.flags?.lifecycle_patch,
      lifecycleEvent: augment.flags?.lifecycle_event,
      lifecycleProvenance: augment.flags?.lifecycle_provenance,
    },
    {
      title: t("patchSummaryTitle"),
      body: ({ patch }) => t("patchSummaryBody", { name: augmentName, patch }),
      availability: (status) =>
        AVAILABILITY_SUMMARY_KEYS[status]
          ? t(AVAILABILITY_SUMMARY_KEYS[status], { name: augmentName })
          : undefined,
      // A snapshot diff dates our OBSERVATION. Causal wording is reserved for
      // an authoritative Riot record, which no current source produces.
      dated: ({ patch, event, provenance }) => {
        const causal = provenance === "riot_patch_notes";
        if (event === "added") {
          return causal
            ? t("patchSummaryAddedIn", { name: augmentName, patch })
            : t("patchSummaryFirstObservedIn", { name: augmentName, patch });
        }
        if (event === "removed") {
          return causal
            ? t("patchSummaryRemovedIn", { name: augmentName, patch })
            : t("patchSummaryFirstObservedRemovedIn", { name: augmentName, patch });
        }
        return undefined;
      },
    },
  );

  return (
    <>
      <JsonLd data={augmentJsonLd} />
      <div className="py-8 max-w-3xl">
        {/* Back link + wiki link */}
        <div className="flex items-center justify-between mb-6">
          <Link
            href="/augments"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            {t("detailBack")}
          </Link>
          <a
            href={wikiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            LoL Wiki
          </a>
        </div>

        {/* ─── Header ─── */}
        <div className="flex items-start gap-6 mb-8">
          {augment.icon && (
            <div className="relative w-20 h-20 rounded-xl overflow-hidden border-2 border-[var(--color-border-hover)] shrink-0 bg-[var(--color-bg-card)]">
              <Image
                src={augment.icon}
                alt={augmentName}
                fill
                className="object-contain p-1"
                sizes="80px"
                unoptimized
              />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl font-bold">{augmentName}</h1>
              <span
                className={`text-xs font-semibold px-2.5 py-1 rounded-md border ${RARITY_BADGE[augment.rarity]}`}
              >
                {rarityLabel[augment.rarity]}
              </span>
              {typeBadgeKey && (
                <span className="text-xs font-medium px-2 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                  {t(typeBadgeKey)}
                </span>
              )}
              {augment.availability?.status &&
                augment.availability.status !== "confirmed_live" && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded border border-rose-400/30 bg-rose-400/10 text-rose-300">
                    {t(
                      `availability_${augment.availability.status}` as never,
                    )}
                  </span>
                )}
            </div>

            {augment.wikiDescription && (
              <p data-game-text className="mt-3 text-[var(--color-text-secondary)] leading-relaxed">
                {augment.wikiDescription}
              </p>
            )}

            {augment.kit_tags && augment.kit_tags.length > 0 && (
              <div className="mt-4">
                <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
                  {t("detailKitSynergy")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {augment.kit_tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[11px] px-2 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-card)] text-[var(--color-text-secondary)]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {patchSummary && (
          <section className="glass-card p-4 mb-6" aria-labelledby="patch-summary-heading">
            <h2 id="patch-summary-heading" className="text-sm font-semibold mb-2">
              {patchSummary.title}
            </h2>
            <div className="space-y-1.5">
              {patchSummary.lines.map((line, index) => (
                <p key={index} className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                  {line}
                </p>
              ))}
            </div>
          </section>
        )}

        {/* ─── v3: the augment's letter across all champions ─── */}
        {graded ? (
          <section className="glass-card p-5" aria-labelledby="augment-grade">
            <h2 id="augment-grade" className="text-lg font-semibold mb-3">{tt("detailHeading")}</h2>
            <div className="flex items-center gap-3">
              <LetterChip
                letter={graded.letter}
                thin={graded.outlined}
                size="lg"
                label={tp(graded.outlined ? "gradeLabelThin" : "gradeLabel", { letter: graded.letter })}
              />
              <div className="text-sm">
                <div className="font-semibold">
                  {tt("detailLift", { lift: `${Math.round(graded.m) > 0 ? "+" : Math.round(graded.m) < 0 ? "−" : ""}${Math.abs(Math.round(graded.m))}`, rarity: rarityLabel[augment.rarity] })}
                </div>
                <div className="text-[var(--color-text-secondary)]">
                  {tt("rowLine", { win: graded.winRate.toFixed(1), pick: graded.pickRate.toFixed(1) })}
                </div>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">{tt("detailNote")}</p>
            <Link href={`/tier-list/${augment.rarity}`} className="mt-2 inline-flex min-h-11 items-center text-sm underline">
              {tt("detailSeeList", { rarity: rarityLabel[augment.rarity] })}
            </Link>
          </section>
        ) : (
          <p className="glass-card p-4 text-sm text-[var(--color-text-secondary)]">{pack ? tt("detailUngraded") : tt("unavailable")}</p>
        )}
        <V3AdSlot slot="v3-augment" />
      </div>
    </>
  );
}
