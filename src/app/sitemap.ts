import type { MetadataRoute } from "next";
import { readFile } from "fs/promises";
import path from "path";
import { localizedUrl, languageAlternates } from "@/lib/site";
import { routing } from "@/i18n/routing";
import { resolvePatchNotesLastModified } from "@/lib/patch-notes/seo";
import { patchDetailRoute } from "@/lib/patch-notes/routes";
import type { PatchNotesData } from "@/lib/types";

/**
 * Public, indexable routes (account/admin are excluded — see robots.ts).
 * Each emits one entry per locale with hreflang alternates so Google and AI
 * crawlers discover every localized version.
 */
const STATIC_PATHS = [
  "/",
  "/champions",
  "/tier-list",
  "/tier-list/prismatic",
  "/tier-list/gold",
  "/tier-list/silver",
  "/method",
  "/augments",
  "/items",
  "/patch-notes",
  "/advisor",
  "/pick",
  "/damage-sim",
  "/membership",
  "/about",
  "/privacy",
  "/terms",
  "/contact",
] as const;

async function championSlugs(): Promise<string[]> {
  try {
    const file = path.join(process.cwd(), "public", "data", "champions.json");
    const data = JSON.parse(await readFile(file, "utf-8")) as {
      champions?: { slug: string }[];
    };
    return (data.champions ?? []).map((c) => c.slug);
  } catch {
    return [];
  }
}

async function augmentSlugs(): Promise<string[]> {
  try {
    const file = path.join(process.cwd(), "public", "data", "augments.json");
    const data = JSON.parse(await readFile(file, "utf-8")) as {
      augments?: { slug: string }[];
    };
    return (data.augments ?? []).map((augment) => augment.slug);
  } catch {
    return [];
  }
}

async function itemIdentifiers(): Promise<string[]> {
  try {
    const file = path.join(process.cwd(), "public", "data", "items.json");
    const data = JSON.parse(await readFile(file, "utf-8")) as {
      mayhemExclusive?: { slug: string }[];
      items?: { id?: number | null }[];
    };
    return [
      ...(data.mayhemExclusive ?? []).map((item) => item.slug),
      ...(data.items ?? [])
        .filter((item) => item.id != null)
        .map((item) => String(item.id)),
    ];
  } catch {
    return [];
  }
}

async function publicMetaLastModified(): Promise<Date | null> {
  try {
    const file = path.join(process.cwd(), "public", "data", "meta.json");
    const data = JSON.parse(await readFile(file, "utf-8")) as {
      scraped_at?: string;
    };
    const date = data.scraped_at ? new Date(data.scraped_at) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

async function patchNotesLastModified(): Promise<Date | null> {
  try {
    const file = path.join(process.cwd(), "public", "data", "patch-notes.json");
    const data = JSON.parse(await readFile(file, "utf-8")) as PatchNotesData;
    return resolvePatchNotesLastModified(data);
  } catch {
    return null;
  }
}

async function patchNoteRoutes(): Promise<string[]> {
  try {
    const file = path.join(process.cwd(), "public", "data", "patch-notes.json");
    const data = JSON.parse(await readFile(file, "utf-8")) as PatchNotesData;
    return (data.patches ?? []).map((patch) => patchDetailRoute(patch.version));
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [
    slugs,
    augmentIds,
    itemIds,
    patchRoutes,
    publicDataLastModified,
    patchNoteLastModified,
  ] = await Promise.all([
    championSlugs(),
    augmentSlugs(),
    itemIdentifiers(),
    patchNoteRoutes(),
    publicMetaLastModified(),
    patchNotesLastModified(),
  ]);

  const paths: string[] = [
    ...STATIC_PATHS,
    ...slugs.map((slug) => `/champions/${slug}`),
    ...slugs.map((slug) => `/pick/${slug}`),
    ...augmentIds.map((slug) => `/augments/${slug}`),
    ...itemIds.map((identifier) => `/items/${identifier}`),
    ...patchRoutes,
  ];

  return paths.flatMap((p) =>
    routing.locales.map((locale) => {
      const lastModified =
        p === "/patch-notes" || p.startsWith("/patch-notes/")
          ? patchNoteLastModified ?? publicDataLastModified ?? undefined
          : publicDataLastModified ?? undefined;

      return {
        url: localizedUrl(p, locale),
        lastModified,
        alternates: { languages: languageAlternates(p) },
      };
    }),
  );
}
