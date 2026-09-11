import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildPatchHeroChrome,
  formatPatchDate,
} from "@/lib/patch-notes/chrome";
import { buildPatchDigest } from "@/lib/patch-notes/digest";
import {
  CHANGE_KIND_LABEL_KEYS,
  PATCH_OBJECT_TYPE_LABEL_KEYS,
  normalizeChangeKind,
  normalizePatchObjectType,
} from "@/lib/patch-notes/labels";
import type { ChangeKind, PatchNote } from "@/lib/types";

const locales = ["en", "zh-TW", "zh-CN", "ja", "ko"] as const;

function readMessages(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf-8"),
  );
}

function getByPath(messages: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, messages);
}

function syntheticPatch(kinds: ChangeKind[] = ["changed"]): PatchNote {
  return {
    version: "26.13",
    title: "League of Legends Patch 26.13 Notes",
    released: "2026-06-25",
    publishedAt: "2026-06-25T12:00:00Z",
    intro: "Welcome to the official English article intro.",
    summary: {
      totalChanges: kinds.length,
      byKind: Object.fromEntries(kinds.map((kind) => [kind, 1])),
      byEntityType: {
        champion: 1,
        item: 1,
        augment: 1,
        ability: 1,
        system: 1,
      },
      byLabel: {},
      damageRelevant: 0,
    },
    sections: [
      {
        id: "augments",
        title: "Augments",
        changes: kinds.map((kind) => ({
          subject: { en: `${kind} subject` },
          text: { en: `${kind} change body` },
          kind,
        })),
      },
    ],
  };
}

describe("patch-notes digest", () => {
  test("uses explicit added and removed counts when summary carries them", () => {
    const digest = buildPatchDigest(syntheticPatch(["added", "removed"]), 3);

    expect(digest).toEqual({
      added: 1,
      removed: 1,
      hotfixes: 3,
    });
  });

  test("reports this patch's dated removal count", () => {
    const patch = syntheticPatch(["removed"]);
    patch.summary = { ...patch.summary!, byKind: { removed: 3 } };

    expect(buildPatchDigest(patch, 0).removed).toBe(3);
  });

  test("a patch with no dated removals reports zero, never the not-live archive", () => {
    // Patch 26.18 after cross-gap events stopped being dated to it: no changes
    // at all, while 69 augments are not currently live (42 removed, 10
    // disabled, 16 unverified, 1 candidate). That archive count once filled
    // this card as "Removed 69" — a claim about THIS patch that nothing dates.
    const patch = syntheticPatch([]);
    patch.summary = { ...patch.summary!, totalChanges: 0, byKind: {} };

    expect(buildPatchDigest(patch, 0)).toEqual({ added: 0, removed: 0, hotfixes: 0 });
  });

  test("the patch summary cards are not fed the not-live augment archive", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/patch-notes/PatchNotesView.tsx"),
      "utf8",
    );

    expect(source).toContain("buildPatchDigest(patch, hotfixEventCount)");
    expect(source).not.toContain("removedAugmentsCount");
  });
});

describe("patch-notes localized renderer labels", () => {
  test("every supported change kind has a non-empty label in every locale", () => {
    for (const locale of locales) {
      const messages = readMessages(locale);
      for (const kind of CHANGE_KIND_LABEL_KEYS) {
        const label = getByPath(messages, `patchNotes.kinds.${kind}`);
        expect(label, `${locale}:${kind}`).toEqual(expect.any(String));
        expect(label, `${locale}:${kind}`).not.toBe("");
      }
    }
  });

  test("unknown change kinds normalize to changed without throwing", () => {
    for (const locale of locales) {
      const messages = readMessages(locale);
      const fallbackKind = normalizeChangeKind("experimental");
      const label = getByPath(messages, `patchNotes.kinds.${fallbackKind}`);

      expect(fallbackKind).toBe("changed");
      expect(label, `${locale}:unknown kind fallback`).toEqual(expect.any(String));
      expect(label, `${locale}:unknown kind fallback`).not.toBe("");
    }
  });

  test("entity type prefixes resolve for every locale with unknown fallback", () => {
    for (const locale of locales) {
      const messages = readMessages(locale);
      for (const objectType of PATCH_OBJECT_TYPE_LABEL_KEYS) {
        const label = getByPath(messages, `patchNotes.objectTypes.${objectType}`);
        expect(label, `${locale}:${objectType}`).toEqual(expect.any(String));
        expect(label, `${locale}:${objectType}`).not.toBe("");
      }
      expect(normalizePatchObjectType("future-object")).toBe("unknown");
    }
  });
});

describe("patch-notes localized hero chrome", () => {
  test("zh-TW hero uses localized heading and moves English intro into details", () => {
    const chrome = buildPatchHeroChrome(syntheticPatch(), "zh-TW", "版本 26.13");

    expect(chrome.heading).toBe("版本 26.13");
    expect(chrome.intro).toBe("");
    expect(chrome.originalArticle).toEqual({
      title: "League of Legends Patch 26.13 Notes",
      intro: "Welcome to the official English article intro.",
    });
  });

  test("date formatting uses locale-aware medium dates and preserves raw invalid text", () => {
    expect(formatPatchDate("2026-06-25T12:00:00Z", "en")).toMatch(/Jun|June/);
    expect(formatPatchDate("Released someday", "zh-TW")).toBe("Released someday");
  });
});
