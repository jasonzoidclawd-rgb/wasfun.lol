import { readFileSync } from "node:fs";
import { PlanLine } from "@/components/plans/PlanLine";
import { plansEnabled } from "@/lib/plans/flags";
import { V3AdSlot } from "@/components/ads/V3AdSlot";
import path from "node:path";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { readAugmentsFile, readChampionsFile, readPatchNotesFile } from "@/lib/data/read-public-file";
import { localizedName, type LocalizedNameRecord } from "@/lib/i18n/localized-name";
import { DashboardIslands } from "@/components/dashboard/DashboardIslands";
import { PatchPulseBanner } from "@/components/dashboard/PatchPulseBanner";
import { MoversCarousel, type ChangedAugment } from "@/components/dashboard/MoversCarousel";
import { HomeSearch, type HomeChampion } from "@/components/home/HomeSearch";
import { MovedSinceLastPatch } from "@/components/home/MovedSinceLastPatch";
import { RotateHint } from "@/components/ui/RotateHint";
import { patchChangeState } from "@/lib/patch-notes/digest";
import { loadChampionLetters } from "@/lib/score/pack";
import { championMovers, comparePatch, patchDataState } from "@/lib/score/movers";
import { estimateVolume } from "@/lib/score/volume";
import type { ChampionRow } from "@/lib/score/engine";
import type { PatchNote } from "@/lib/types";

type ChampionRecord = LocalizedNameRecord & { slug: string };
type AugmentRecord = LocalizedNameRecord & ChangedAugment;
type PatchNoteSection = { id: string; changes: { text: { en: string } }[] };
type HomePatchNote = Pick<PatchNote, "version" | "structuredDiff" | "summary"> & { sections: PatchNoteSection[] };

const PATCH_WEEK_DAYS = 7;

function readBuildFeed(): { patch: string; dataDate: string; champions: Record<string, ChampionRow> } {
  return JSON.parse(readFileSync(path.join(process.cwd(), "data", "internal", "champion-build-feed.json"), "utf-8"));
}

function patchStarts(): Record<string, string> {
  const meta = JSON.parse(readFileSync(path.join(process.cwd(), "data", "internal", "patch-metadata.json"), "utf-8")) as {
    patches?: { version: string; publishedAt?: string }[];
  };
  return Object.fromEntries(meta.patches?.filter((p) => p.publishedAt).map((p) => [p.version, p.publishedAt as string]) ?? []);
}

/**
 * Home (v3): where's my champion, and what changed? Champion search with the
 * visitor's recent champions, a patch-week line, and champions whose win rate
 * moved beyond noise since the previous patch. Champion letters and win rates
 * are the champions' own, so none of this depends on augment statistics.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");

  const [championsFile, augmentsFile, patchNotesFile] = await Promise.all([
    readChampionsFile<{ champions: ChampionRecord[] }>(),
    readAugmentsFile<{ augments: AugmentRecord[] }>(),
    readPatchNotesFile<{ patches: HomePatchNote[] }>(),
  ]);

  const letters = loadChampionLetters();
  const champions: HomeChampion[] = championsFile.champions
    .map((c) => {
      const l = letters?.get(c.slug);
      return { slug: c.slug, name: localizedName(c, locale), grade: l?.letter ?? null, outlined: l?.outlined ?? false };
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  const bySlug = new Map(champions.map((c) => [c.slug, c]));

  const feed = readBuildFeed();
  const starts = patchStarts();
  const histories = Object.values(feed.champions).map((c) => c.history ?? []);
  const volume = estimateVolume(histories, starts, { patch: feed.patch, dataDate: feed.dataDate });
  const fromPatch =
    histories
      .flat()
      .map((h) => h.patch)
      .filter((p) => comparePatch(p, feed.patch) < 0)
      .sort((a, b) => comparePatch(b, a))[0] ?? null;
  // Rows dated before the patch began are the last patch's totals under a new
  // label: nothing of the new patch to show yet (undetermined, not "no change").
  const state = patchDataState(feed.dataDate, starts[feed.patch]);
  // each side of the comparison uses its own patch's game count
  const previousVolume = (patch: string): number | null => {
    const last = histories
      .flat()
      .filter((h) => h.patch === patch)
      .map((h) => h.snapshot)
      .sort()
      .at(-1);
    if (!last) return null;
    const dataDate = `${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}`;
    return estimateVolume(histories, starts, { patch, dataDate })?.games ?? null;
  };
  const movers = volume && !state.predates ? championMovers(feed.champions, feed.patch, { current: volume.games, previous: previousVolume }) : [];

  // Augment changes named in the patch notes: facts from the notes, no statistics.
  const augByName = new Map(augmentsFile.augments.map((a) => [a.name, a]));
  const note = patchNotesFile.patches[0];
  const measured = patchChangeState(note) !== "unavailable";
  const changed = new Map<string, AugmentRecord>();
  for (const change of note.sections.filter((s) => s.id === "augments").flatMap((s) => s.changes)) {
    const a = augByName.get(change.text.en);
    if (a && !changed.has(a.slug)) changed.set(a.slug, a);
  }

  return (
    <>
      <DashboardIslands />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-6 md:gap-3.5 lg:grid-cols-12 lg:gap-4">
        <PatchPulseBanner changesMeasured={measured} />
        <RotateHint />
        <HomeSearch champions={champions} />
        {state.days !== null && state.days <= PATCH_WEEK_DAYS && (
          <p className="col-span-full text-sm text-[var(--color-text-secondary)]">{t("patchWeek", { patch: feed.patch, days: state.days })}</p>
        )}
        <MovedSinceLastPatch movers={movers} champions={bySlug} patch={feed.patch} fromPatch={fromPatch} predates={state.predates} />
        <div className="col-span-full">
          <V3AdSlot slot="v3-home" />
        </div>
        {plansEnabled() && <PlanLine />}
        <MoversCarousel augments={[...changed.values()]} />
      </div>
    </>
  );
}
