import { localizedName, type LocalizedNameRecord } from "@/lib/i18n/localized-name";
import type { TierRow } from "@/components/tiers/AugmentTierRows";
import type { Rarity } from "./engine";
import type { ScorePack } from "./pack";
import type { IconIndex } from "./pick-payload";

/** One rarity's tier list, in grade order, localized. */
export function tierRows(pack: ScorePack, rarity: Rarity, locale: string, icons: IconIndex): TierRow[] {
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
      };
    });
}
