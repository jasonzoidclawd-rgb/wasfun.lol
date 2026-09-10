import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import sitemap from "@/app/sitemap";
import { routing } from "@/i18n/routing";
import {
  buildPatchDetailStaticParams,
  patchDetailRoute,
} from "@/lib/patch-notes/routes";
import { resolvePatchNotesLastModified } from "@/lib/patch-notes/seo";
import { localizedUrl } from "@/lib/site";
import patchNotesData from "../../../public/data/patch-notes.json";
import championsData from "../../../public/data/champions.json";
import augmentsData from "../../../public/data/augments.json";
import itemsData from "../../../public/data/items.json";

function lastModifiedIso(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return "";
}

function routeUrls(route: string): string[] {
  return routing.locales.map((locale) => localizedUrl(route, locale));
}

describe("sitemap freshness", () => {
  test("contains localized patch-note list and detail routes from public data", async () => {
    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);
    const expectedListUrls = routeUrls("/patch-notes");
    const expectedDetailUrls = patchNotesData.patches.flatMap((patch) =>
      routeUrls(patchDetailRoute(patch.version)),
    );

    expect(urls).toEqual(expect.arrayContaining(expectedListUrls));
    expect(urls).toEqual(expect.arrayContaining(expectedDetailUrls));
    expect(urls.filter((url) => expectedListUrls.includes(url))).toHaveLength(
      routing.locales.length,
    );
    expect(urls.filter((url) => expectedDetailUrls.includes(url))).toHaveLength(
      patchNotesData.patches.length * routing.locales.length,
    );
  });

  test("uses stable public patch-note timestamps for localized patch-note routes", async () => {
    const entries = await sitemap();
    const expectedPatchUrls = [
      ...routeUrls("/patch-notes"),
      ...patchNotesData.patches.flatMap((patch) =>
        routeUrls(patchDetailRoute(patch.version)),
      ),
    ];
    const patchEntries = entries.filter((entry) =>
      expectedPatchUrls.includes(entry.url),
    );
    const expectedLastModified =
      resolvePatchNotesLastModified(patchNotesData)?.toISOString();
    const now = Date.now();

    expect(
      patchEntries.map((entry) => lastModifiedIso(entry.lastModified)),
    ).toEqual(Array(expectedPatchUrls.length).fill(expectedLastModified));

    for (const entry of patchEntries) {
      const modifiedAt = entry.lastModified?.valueOf();
      expect(modifiedAt, entry.url).toEqual(expect.any(Number));
      expect(Math.abs(now - modifiedAt!), entry.url).toBeGreaterThan(10 * 60_000);
    }
  });

  test("advertised patch detail URLs correspond to generated routes and default proxy coverage", async () => {
    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);
    const staticParams = buildPatchDetailStaticParams(
      patchNotesData,
      routing.locales,
    );
    const generatedUrls = new Set(
      staticParams.map(({ locale, patch }) =>
        localizedUrl(patchDetailRoute(patch), locale),
      ),
    );
    const expectedDetailUrls = patchNotesData.patches.flatMap((patch) =>
      routeUrls(patchDetailRoute(patch.version)),
    );
    const proxySource = readFileSync(
      path.join(process.cwd(), "src/proxy.ts"),
      "utf8",
    );

    expect(urls).toEqual(expect.arrayContaining(expectedDetailUrls));
    expect(expectedDetailUrls.every((url) => generatedUrls.has(url))).toBe(true);
    // Assert against the published set, not a literal patch number: the
    // patch-note window rolls forward every fortnight, so a pinned version
    // (previously 26.13) silently ages out of the feed and fails for a reason
    // that has nothing to do with the behaviour under test.
    expect(patchNotesData.patches.length).toBeGreaterThan(0);
    for (const patch of patchNotesData.patches) {
      expect(generatedUrls).toContain(
        localizedUrl(patchDetailRoute(patch.version), routing.defaultLocale),
      );
    }
    expect(proxySource).toContain('"/patch-notes/:path*"');
  });

  test("preserves champion, augment, and item sitemap entries", async () => {
    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);
    const champion = championsData.champions[0];
    const augment = augmentsData.augments[0];
    const item =
      itemsData.mayhemExclusive[0] ??
      itemsData.items.find((candidate) => candidate.id != null);
    if (!item) {
      throw new Error("items fixture must include at least one routable item");
    }

    expect(urls).toContain(localizedUrl(`/champions/${champion.slug}`, "en"));
    expect(urls).toContain(localizedUrl(`/augments/${augment.slug}`, "en"));
    expect(urls).toContain(
      localizedUrl(`/items/${item.slug ?? item.id}`, "en"),
    );
  });
});
