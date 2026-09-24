/**
 * The Pick screen's data for one champion, in one locale: everything the
 * client needs to grade cards, name a pick, flag close calls and hint rerolls
 * with no network (so the screen works offline once loaded).
 *
 * Labels follow the data the provider actually publishes. No card has a
 * champion-specific win row (the provider's champion rows copy the global
 * row), so a card's win rate is the augment's measured rate across all
 * champions, and its letter is graded from all champions too; neither is ever
 * shown as this champion's own. Its pick rate IS this champion's own when the
 * provider lists the pair, else a bound ("under" the least-picked listed one).
 */
import { localizedName, type LocalizedNameRecord } from "@/lib/i18n/localized-name";
import type { Letter } from "./grade";
import type { Rarity } from "./engine";
import type { CatalogAugment, ScorePack } from "./pack";

export interface PickCard {
  id: string;
  name: string;
  /** local icon path, or null for the placeholder glyph */
  icon: string | null;
  letter: Letter;
  outlined: boolean;
  /** position in the champion set's graded order (0 = best) */
  order: number;
  /** may feed the Plan card: a well-measured, unit-stable member of its tier */
  plan: boolean;
  /** posterior mean lift (pp) and variance (pp²), for the verdict */
  m: number;
  v: number;
  /** the augment's win rate across all champions, percent, one decimal */
  winRate: number;
  /** this champion's own pick rate for this augment, percent, when listed */
  pick: number | null;
  gamble: boolean;
}

export interface PickItemRow {
  id: string;
  names: string[];
  icons: (string | null)[];
  winRate: number;
  pickRate: number;
}

export interface PickPayload {
  champion: { slug: string; name: string; icon: string | null; letter: Letter | null; outlined: boolean; winRate: number };
  meta: { patch: string; dataDate: string; provider: string; tau: number };
  rarities: Record<Rarity, PickCard[]>;
  boots: (PickItemRow & { letter: Letter; outlined: boolean })[];
  builds: (PickItemRow & { rank: number; mostBuilt: boolean; closeCallWithAbove: boolean })[];
}

const GAMBLES = new Set(["ARAM_PandorasBox", "ARAM_TransmuteChaos", "ARAM_TransmutePrismatic", "ARAM_TransmuteGold"]);

export interface IconIndex {
  augment: (augmentId: string) => string | null;
  champion: (slug: string) => string | null;
  item: (sourceSlug: string) => string | null;
}

export interface ItemNames {
  name: (sourceSlug: string, locale: string) => string;
}

function collator(locale: string): Intl.Collator {
  return new Intl.Collator(locale, { sensitivity: "base", numeric: true });
}

export function buildPickPayload(opts: {
  pack: ScorePack;
  slug: string;
  locale: string;
  championRecord: LocalizedNameRecord;
  icons: IconIndex;
  items: ItemNames;
}): PickPayload | null {
  const { pack, slug, locale, icons, items } = opts;
  const champ = pack.pack(slug);
  if (!champ) return null;
  const compare = collator(locale);
  const rarities = {} as Record<Rarity, PickCard[]>;
  for (const [rarity, set] of Object.entries(champ.sets) as [Rarity, typeof champ.sets.gold][]) {
    rarities[rarity] = set
      .map((o) => {
        const cat = pack.catalog.get(o.id) as CatalogAugment;
        const pick = champ.listed[o.id] ?? null;
        return {
          id: o.id,
          name: localizedName(cat as unknown as LocalizedNameRecord, locale),
          icon: icons.augment(o.id),
          letter: o.letter,
          outlined: o.outlined,
          order: o.order,
          plan: o.planEligible,
          m: round(o.m, 3),
          v: round(o.v, 4),
          winRate: Math.round(o.winRate * 10) / 10,
          pick: pick === null ? null : Math.round(pick * 10) / 10,
          gamble: GAMBLES.has(o.id),
        };
      })
      // Fixed positions: alphabetical within each rarity, never by grade.
      .sort((a, b) => compare.compare(a.name, b.name));
  }
  const row = (ids: string[], winRate: number, pickRate: number) => ({
    id: ids.join(">"),
    names: ids.map((id) => items.name(id, locale)),
    icons: ids.map((id) => icons.item(id)),
    winRate,
    pickRate,
  });
  return {
    champion: {
      slug,
      name: localizedName(opts.championRecord, locale),
      icon: icons.champion(slug),
      letter: champ.letter,
      outlined: champ.letterOutlined,
      winRate: champ.winRate,
    },
    meta: { patch: pack.meta.patch, dataDate: pack.meta.dataDate, provider: pack.meta.provider, tau: pack.meta.tau },
    rarities,
    boots: (champ.boots ?? [])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((b) => ({ ...row(b.id.split(">"), b.winRate, b.pickRate), letter: b.letter, outlined: b.outlined })),
    builds: champ.builds.ranked.map((b) => ({
      ...row(b.id.split(">"), b.winRate, b.pickRate),
      rank: b.rank,
      mostBuilt: b.mostBuilt,
      closeCallWithAbove: b.closeCallWithAbove,
    })),
  };
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
