import { setRequestLocale } from "next-intl/server";
import {
  readChampionsFile,
  readAugmentsFile,
  readMetaFile,
  readPatchNotesFile,
  readCombosFile,
} from "@/lib/data/read-public-file";
import type { LocalizedNameRecord } from "@/lib/i18n/localized-name";
import { DashboardIslands } from "@/components/dashboard/DashboardIslands";
import { PatchPulseBanner } from "@/components/dashboard/PatchPulseBanner";
import { HeroMover, type HeroChampion } from "@/components/dashboard/HeroMover";
import { MetaAtAGlance } from "@/components/dashboard/MetaAtAGlance";
import { TierMiniGrid, type TierChampion } from "@/components/dashboard/TierMiniGrid";
import { MoversCarousel, type ChangedAugment } from "@/components/dashboard/MoversCarousel";
import { AugmentSpotlight } from "@/components/dashboard/AugmentSpotlight";
import { ComboHighlights } from "@/components/dashboard/ComboHighlights";
import { AdvisorTeaser } from "@/components/dashboard/AdvisorTeaser";
import { CompanionLauncher } from "@/components/dashboard/CompanionLauncher";
import { RotateHint } from "@/components/ui/RotateHint";
import { readPatchClocks } from "@/lib/data/clocks";

type ChampionRecord = LocalizedNameRecord &
  HeroChampion &
  Pick<TierChampion, "tier" | "rank">;

type AugmentRecord = LocalizedNameRecord &
  ChangedAugment & {
    wikiDescription?: string;
    availability?: { status?: string };
  };

type ComboRecord = { champion: string; augment: string; tier: string };

type PatchNoteChange = { text: { en: string } };
type PatchNoteSection = { id: string; changes: PatchNoteChange[] };

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [championsFile, augmentsFile, metaFile, patchNotesFile, combosFile] = await Promise.all([
    readChampionsFile<{ champions: ChampionRecord[] }>(),
    readAugmentsFile<{ augments: AugmentRecord[] }>(),
    readMetaFile<{ patch: string; scraped_at: string }>(),
    readPatchNotesFile<{ patches: Array<{ version: string; sections: PatchNoteSection[] }> }>(),
    readCombosFile<{ combos: ComboRecord[] }>(),
  ]);

  const champions = championsFile.champions;
  const augments = augmentsFile.augments;
  const { patch, scraped_at } = metaFile;
  const clocks = await readPatchClocks();
  const liveAugmentCount = augments.filter(
    (augment) => augment.availability?.status === "confirmed_live",
  ).length;

  // A new champion may be present in the roster before the third-party
  // statistical feed has a tier/rank/rate row. Keep that identity visible on
  // its detail page, but reserve ranking surfaces for complete stat records.
  //
  // "Complete" is defined by what the source still publishes. As of 2026-09-10
  // arammayhem.com no longer publishes champion pick rate anywhere (its tier
  // cards carry tier + win rate only), so requiring it here would leave every
  // ranking surface permanently empty. Pick rate is rendered when present and
  // omitted when not, rather than gating the ranking.
  const byRank = [...champions]
    .filter(
      (champion) =>
        champion.tier != null &&
        champion.rank != null &&
        champion.win_rate != null,
    )
    .sort((a, b) => a.rank - b.rank);
  const heroChampion = byRank[0];
  const tierChampions = byRank.filter((c) => c.tier === "S+" || c.tier === "S");
  const sPlusCount = champions.filter((c) => c.tier === "S+").length;

  const augByName = new Map(augments.map((a) => [a.name, a]));
  const augmentChangeEntries = patchNotesFile.patches[0].sections
    .filter((s) => s.id === "augments")
    .flatMap((s) => s.changes);

  const changedAugmentsBySlug = new Map<string, AugmentRecord>();
  for (const change of augmentChangeEntries) {
    const augment = augByName.get(change.text.en);
    if (augment && !changedAugmentsBySlug.has(augment.slug)) {
      changedAugmentsBySlug.set(augment.slug, augment);
    }
  }
  const changedAugments = [...changedAugmentsBySlug.values()];

  const changedPrismatic = changedAugments.find((a) => a.rarity === "prismatic");
  const fallbackPrismatic = augments.find((a) => a.rarity === "prismatic");
  const spotlight = changedPrismatic ?? fallbackPrismatic;
  const isSpotlightChanged = changedPrismatic != null;

  const champBySlug = new Map(byRank.map((c) => [c.slug, c]));
  const comboByChampion = new Map<string, ComboRecord>();
  for (const combo of combosFile.combos) {
    if (!comboByChampion.has(combo.champion)) comboByChampion.set(combo.champion, combo);
  }
  const rankedCombos = [...comboByChampion.values()]
    .map((combo) => {
      const champion = champBySlug.get(combo.champion);
      const augment = augByName.get(combo.augment);
      return champion && augment ? { champion, augment } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.champion.rank - b.champion.rank)
    .slice(0, 6);

  return (
    <>
      <DashboardIslands />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-6 md:gap-3.5 lg:grid-cols-12 lg:gap-4">
        <PatchPulseBanner />
        <RotateHint />
        <HeroMover champion={heroChampion} total={champions.length} patch={patch} />
        <MetaAtAGlance
          sPlusCount={sPlusCount}
          championCount={champions.length}
          liveAugmentCount={liveAugmentCount}
          knownAugmentCount={augments.length}
          changedAugmentCount={changedAugments.length}
          structuralPatch={clocks.structuralPatch}
          statisticsPatch={clocks.statisticsPatch}
          updatedAt={scraped_at}
        />
        <TierMiniGrid champions={tierChampions} />
        <MoversCarousel augments={changedAugments} />
        {spotlight && <AugmentSpotlight augment={spotlight} isChangedThisPatch={isSpotlightChanged} />}
        <ComboHighlights combos={rankedCombos} />
        <AdvisorTeaser />
        <CompanionLauncher />
      </div>
    </>
  );
}
