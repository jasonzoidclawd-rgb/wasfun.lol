/**
 * Build-time icon index (scripts/fetch-icons.mjs) and localized item names.
 * Server-only. A missing icon is null, and the page shows a placeholder glyph.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { localizedName, type LocalizedNameRecord } from "@/lib/i18n/localized-name";
import type { IconIndex, ItemNames } from "./pick-payload";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

let icons: IconIndex | null = null;
let items: ItemNames | null = null;

export function loadIconIndex(): IconIndex {
  if (icons) return icons;
  const file = path.join(process.cwd(), "public", "assets", "icons", "manifest.json");
  const m: { augments: string[]; champions: string[]; items: Record<string, string> } = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf-8"))
    : { augments: [], champions: [], items: {} };
  const aug = new Set(m.augments);
  const champ = new Set(m.champions);
  icons = {
    augment: (id) => (aug.has(id) ? `/assets/icons/aug/${id}.png` : null),
    champion: (slug) => (champ.has(slug) ? `/assets/icons/champ/${slug}.png` : null),
    item: (sourceSlug) => {
      const id = m.items[norm(sourceSlug)];
      return id ? `/assets/icons/item/${id}.png` : null;
    },
  };
  return icons;
}

export function loadItemNames(): ItemNames {
  if (items) return items;
  const doc = JSON.parse(readFileSync(path.join(process.cwd(), "data", "internal", "items.json"), "utf-8"));
  const byName = new Map<string, LocalizedNameRecord>();
  for (const it of [...(doc.mayhemExclusive ?? []), ...(doc.items ?? [])]) byName.set(norm(it.name), it);
  items = {
    name: (sourceSlug, locale) => {
      const rec = byName.get(norm(sourceSlug));
      if (rec) return localizedName(rec, locale);
      return sourceSlug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    },
  };
  return items;
}
