import type { Locale } from "@/i18n/routing";
import { patchDetailRoute } from "@/lib/patch-notes/routes";
import type { PatchNote, PatchNotesData } from "@/lib/types";

export interface PatchNotesJsonLdOptions {
  url: string;
  title: string;
  description: string;
  breadcrumbLabel: string;
  patchLabel: (patch: string) => string;
}

export interface PatchDetailJsonLdOptions {
  url: string;
  title: string;
  description: string;
  patchNotesUrl: string;
  patchNotesLabel: string;
  patchLabel: (patch: string) => string;
}

export interface PatchDetailMetadataOptions {
  pageTitle: string;
  subtitle: string;
  patchLabel: (patch: string) => string;
}

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(value: string | null | undefined): string | undefined {
  return validDate(value)?.toISOString();
}

function currentPatch(data: PatchNotesData): PatchNote | null {
  return (
    data.patches.find((patch) => patch.version === data.patch) ??
    data.patches[0] ??
    null
  );
}

function slugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function patchNoteAnchor(patch: string): string {
  return `patch-${slugSegment(patch)}`;
}

export function patchNoteSectionAnchor(patch: string, sectionId: string): string {
  return `${patchNoteAnchor(patch)}-${slugSegment(sectionId) || "section"}`;
}

export function patchNoteSectionHref(patch: string, sectionId: string): string {
  return `${patchDetailRoute(patch)}#${patchNoteSectionAnchor(patch, sectionId)}`;
}

export function resolvePatchNotesLastModified(
  data: PatchNotesData | null | undefined,
): Date | null {
  if (!data) return null;
  // Content date first, scrape time last. `scraped_at` changes on every daily
  // run even when no patch content changed, which would tell crawlers that
  // every patch-note URL was modified today. It only looked stable while the
  // data itself was frozen. Fall back to it solely when no publication date
  // exists.
  return (
    validDate(currentPatch(data)?.publishedAt) ??
    validDate(currentPatch(data)?.released) ??
    validDate(data.scraped_at)
  );
}

export function resolvePatchNotePublishedDate(
  note: PatchNote | null | undefined,
): Date | null {
  if (!note) return null;
  return validDate(note.publishedAt) ?? validDate(note.released);
}

export function buildPatchDetailMetadataText(
  note: PatchNote,
  options: PatchDetailMetadataOptions,
): { title: string; description: string } {
  const label = options.patchLabel(note.version);
  const sourceTitle = note.title || label;

  return {
    title: `${label} · ${options.pageTitle}`,
    description: `${options.subtitle} · ${label} · ${sourceTitle}`,
  };
}

function patchDetailUrl(collectionUrl: string, patch: string): string {
  return `${collectionUrl.replace(/\/$/, "")}/${encodeURIComponent(patch)}`;
}

function siteUrlFromPatchNotesUrl(patchNotesUrl: string): string {
  return patchNotesUrl.replace(/\/patch-notes\/?$/, "");
}

export function buildPatchNotesJsonLd(
  data: PatchNotesData,
  locale: Locale,
  options: PatchNotesJsonLdOptions,
): Record<string, unknown> {
  const current = currentPatch(data);
  const dateModified = resolvePatchNotesLastModified(data)?.toISOString();
  const collectionId = `${options.url}#collection`;
  const articleId = `${options.url}#current-patch`;
  const itemListElements = data.patches.map((patch, index) => ({
    "@type": "ListItem",
    position: index + 1,
    url: patchDetailUrl(options.url, patch.version),
    name: options.patchLabel(patch.version),
  }));

  const graph: Record<string, unknown>[] = [
    {
      "@type": "CollectionPage",
      "@id": collectionId,
      url: options.url,
      name: options.title,
      description: options.description,
      inLanguage: locale,
      dateModified,
      isPartOf: {
        "@type": "WebSite",
        name: "Mayhem Oracle",
      },
      about: [
        "League of Legends",
        "ARAM Mayhem",
        `Patch ${data.patch}`,
      ],
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Mayhem Oracle",
          item: options.url.replace(/\/patch-notes$/, ""),
        },
        {
          "@type": "ListItem",
          position: 2,
          name: options.breadcrumbLabel,
          item: options.url,
        },
      ],
    },
    {
      "@type": "ItemList",
      name: options.title,
      numberOfItems: data.patches.length,
      itemListElement: itemListElements,
    },
  ];

  if (current) {
    graph.push({
      "@type": "Article",
      "@id": articleId,
      headline: current.title || options.patchLabel(current.version),
      description: current.intro || options.description,
      url: options.url,
      mainEntityOfPage: options.url,
      isPartOf: { "@id": collectionId },
      inLanguage: locale,
      datePublished: isoDate(current.publishedAt || current.released),
      dateModified,
      author: (current.authors ?? []).map((name) => ({
        "@type": "Person",
        name,
      })),
      keywords: Object.keys(current.summary?.byKind ?? {}).join(", "),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

export function buildPatchDetailJsonLd(
  note: PatchNote,
  locale: Locale,
  options: PatchDetailJsonLdOptions,
): Record<string, unknown> {
  const date = resolvePatchNotePublishedDate(note)?.toISOString();
  const articleId = `${options.url}#article`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": articleId,
        headline: note.title || options.title,
        description: options.description,
        url: options.url,
        mainEntityOfPage: options.url,
        inLanguage: locale,
        datePublished: date,
        dateModified: date,
        author: (note.authors ?? []).map((name) => ({
          "@type": "Person",
          name,
        })),
        isPartOf: {
          "@type": "CollectionPage",
          url: options.patchNotesUrl,
        },
        keywords: Object.keys(note.summary?.byKind ?? {}).join(", "),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Mayhem Oracle",
            item: siteUrlFromPatchNotesUrl(options.patchNotesUrl),
          },
          {
            "@type": "ListItem",
            position: 2,
            name: options.patchNotesLabel,
            item: options.patchNotesUrl,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: options.patchLabel(note.version),
            item: options.url,
          },
        ],
      },
    ],
  };
}
