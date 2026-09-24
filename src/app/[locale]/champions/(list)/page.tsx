import type { Metadata } from "next";
import { V3AdSlot } from "@/components/ads/V3AdSlot";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { readFile } from "fs/promises";
import path from "path";
import { loadChampionLetters } from "@/lib/score/pack";
import { SwapCheck, type SwapChampion } from "@/components/champions/SwapCheck";
import { localizedName } from "@/lib/i18n/localized-name";
import { ChampionsIndex } from "@/components/champions/ChampionsIndex";
import type { Locale } from "@/i18n/routing";
import { pickRateCoverageLevel } from "@/lib/champions/pick-rate-coverage";
import { languageAlternates, localizedUrl } from "@/lib/site";

export type ChampionEntry = {
  slug: string;
  name: string;
  name_zh_TW?: string;
  name_zh_CN?: string;
  name_ja?: string;
  name_ko?: string;
  title?: string;
  tier: string;
  rank: number;
  /** v3: the letter is ours (graded against the field); outlined when thin */
  letterOutlined?: boolean;
  win_rate: number | null;
  pick_rate: number | null;
  icon: string;
  tags: string[];
  classes?: string[];
  release_date?: string;
  last_changed?: string;
  baseStats?: {
    baseHP: number;
    hpGrowth: number;
    baseArmor: number;
    armorGrowth: number;
    baseMR: number;
    mrGrowth: number;
    baseAD: number;
    adGrowth: number;
    baseAS: number;
    asGrowth: number;
    attackRange: number;
    moveSpeed: number;
    baseMP: number;
    mpGrowth: number;
    baseHPRegen: number;
    hpRegenGrowth: number;
  };
};

async function readChampions(): Promise<{ champions: ChampionEntry[] }> {
  const dataPath = path.join(process.cwd(), "public", "data", "champions.json");
  return JSON.parse(await readFile(dataPath, "utf-8")) as { champions: ChampionEntry[] };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "champion" });
  const route = "/champions";
  const title = t("metaTitle");
  // The description advertises which statistics the page carries, so it is
  // chosen from what the roster actually holds. Promising pick rates to search
  // engines and AI crawlers while publishing none is the same false claim the
  // Pick% column made, with a longer half-life — and under partial coverage,
  // denying them would hide values the page really does render.
  const { champions } = await readChampions();
  const description = {
    none: t("metaDescriptionNoPickRate"),
    partial: t("metaDescriptionPartialPickRate"),
    full: t("metaDescription"),
  }[pickRateCoverageLevel(champions)];
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

export default async function ChampionsIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("champion");

  const { champions: raw } = await readChampions();
  // v3: letters against the field replace the upstream's tiers.
  const letters = loadChampionLetters();
  const champions = raw.map((c) => {
    const l = letters?.get(c.slug);
    return l ? { ...c, tier: l.letter, rank: l.order + 1, letterOutlined: l.outlined } : { ...c, tier: "", rank: 999 };
  });

  return (
    <div className="py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-1">{t("indexTitle")}</h1>
        <p className="text-[var(--color-text-secondary)]">
          {t("indexSubtitle", { count: champions.length })}
        </p>
      </header>
      {letters && (
        <SwapCheck
          champions={raw
            .map((c): SwapChampion | null => {
              const l = letters.get(c.slug);
              return l ? { slug: c.slug, name: localizedName(c, locale), grade: l.letter, outlined: l.outlined, m: l.m, v: l.v } : null;
            })
            .filter((c): c is SwapChampion => c !== null)}
        />
      )}
      <ChampionsIndex champions={champions} />
      <V3AdSlot slot="v3-champions" />
    </div>
  );
}
