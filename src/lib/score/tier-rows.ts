import { localizedName, type LocalizedNameRecord } from "@/lib/i18n/localized-name";
import type { TierRow } from "@/components/tiers/AugmentTierRows";
import { posteriorCovariance, type Rarity } from "./engine";
import type { ScorePack } from "./pack";
import { rankRanges } from "./rank-range";
import type { IconIndex } from "./pick-payload";

/** One rarity's tier list, in grade order, localized. */
export function tierRows(pack: ScorePack, rarity: Rarity, locale: string, icons: IconIndex, opts: { ranks?: boolean } = {}): TierRow[] {
  // members' rank ranges ("usually #2–#4"), only computed when asked for
  const set = pack.tierLists[rarity];
  const ranks = opts.ranks
    ? rankRanges(set.map((o) => ({ id: o.id, m: o.m, v: o.v })), { cov: (i, j) => posteriorCovariance(set[i], set[j]) })
    : null;
  return [...pack.tierLists[rarity]]
    .sort((a, b) => a.order - b.order)
    .map((o) => {
      const cat = pack.catalog.get(o.id);
      return {
        id: o.id,
        letter: o.letter,
        outlined: o.outlined,
        m: o.m,
        winRate: o.winRate,
        pickRate: o.pickRate,
        order: o.order,
        name: cat ? localizedName(cat as unknown as LocalizedNameRecord, locale) : o.id,
        slug: (cat?.slug as string | undefined) ?? null,
        icon: icons.augment(o.id),
        rank: ranks?.get(o.id) ?? null,
      };
    });
}
