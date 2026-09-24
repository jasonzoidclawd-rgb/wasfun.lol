import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildPatchDigest, patchChangeState } from "@/lib/patch-notes/digest";
import type { PatchNote, PatchNotesData } from "@/lib/types";

const locales = ["en", "zh-TW", "zh-CN", "ja", "ko"] as const;

function readMessages(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf-8"),
  );
}

function readPublicPatchNotes(): PatchNotesData {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "public/data/patch-notes.json"), "utf-8"),
  );
}

function patchNote(overrides: Partial<PatchNote> = {}): PatchNote {
  return {
    version: "26.18",
    title: "League of Legends Patch 26.18 Notes",
    released: "2026-09-09",
    sections: [],
    ...overrides,
  };
}

/** A patch whose structural diff ran and produced changes. */
const VERIFIED_CHANGES = patchNote({
  structuredDiff: "available",
  summary: {
    totalChanges: 4,
    byKind: { changed: 3, added: 1 },
    byEntityType: { augment: 4 },
    byLabel: {},
    damageRelevant: 0,
  },
  sections: [
    {
      id: "augments",
      title: "Augments",
      changes: [{ subject: { en: "Bolstered" }, text: { en: "tooltip" }, kind: "changed" }],
    },
  ],
});

/** A patch whose structural diff ran and found nothing. */
const VERIFIED_ZERO = patchNote({
  structuredDiff: "available",
  summary: {
    totalChanges: 0,
    byKind: {},
    byEntityType: {},
    byLabel: {},
    damageRelevant: 0,
  },
});

/** A patch no structural diff covers. Nothing is known about it. */
const UNKNOWN = patchNote({ structuredDiff: "unavailable" });

describe("patch diff state: unknown is not zero", () => {
  test("the three states are distinct", () => {
    expect(patchChangeState(VERIFIED_CHANGES)).toBe("changes");
    expect(patchChangeState(VERIFIED_ZERO)).toBe("no-changes");
    expect(patchChangeState(UNKNOWN)).toBe("unavailable");
  });

  test("a verified zero is NOT the same state as an unmeasured patch", () => {
    // Both carry totalChanges 0 on the wire. Collapsing them is the defect:
    // one is "we checked, nothing changed", the other "we never checked".
    expect(VERIFIED_ZERO.summary!.totalChanges).toBe(0);
    expect(patchChangeState(VERIFIED_ZERO)).not.toBe(patchChangeState(UNKNOWN));
  });

  test("an unmeasured patch yields no digest, so no zero can be rendered", () => {
    expect(buildPatchDigest(UNKNOWN, 0)).toBeNull();
    expect(buildPatchDigest(VERIFIED_ZERO, 0)).toEqual({
      added: 0,
      removed: 0,
      hotfixes: 0,
    });
  });

  test("a legacy payload with a zero summary but no marker is unavailable, never zero", () => {
    // Payloads published before `structuredDiff` existed carried exactly the
    // wall of zeroes this change removes. They must fail safe to "unknown".
    const legacy = patchNote({
      summary: {
        totalChanges: 0,
        byKind: {},
        byEntityType: {},
        byLabel: {},
        damageRelevant: 0,
      },
    });

    expect(patchChangeState(legacy)).toBe("unavailable");
    expect(buildPatchDigest(legacy, 0)).toBeNull();
  });

  test("a marker without a summary cannot be counted", () => {
    expect(patchChangeState(patchNote({ structuredDiff: "available" }))).toBe("unavailable");
  });

  test("hotfix counts never leak into an unmeasured patch", () => {
    expect(buildPatchDigest(UNKNOWN, 7)).toBeNull();
  });
});

describe("patch diff state: published wire contract", () => {
  test("the payload declares schema v3", () => {
    // v3 is a deliberate choice, not a side effect: `structuredDiff` became
    // required and an absent `summary` acquired meaning, so consumers get a
    // marker for the semantic change.
    expect(readPublicPatchNotes().schema_version).toBe(3);
  });

  test("v2 compatibility evidence: the bump costs no migration", () => {
    // Separate from the reason for the bump. Every consumer already tolerated
    // an absent summary — the type has always had `summary?`, and the only
    // readers outside the renderer use optional access — so v3 is cheap to
    // adopt. Cheapness is not itself the justification.
    const types = readFileSync(
      path.join(process.cwd(), "src/lib/types.ts"),
      "utf8",
    );
    const seo = readFileSync(
      path.join(process.cwd(), "src/lib/patch-notes/seo.ts"),
      "utf8",
    );

    expect(types).toMatch(/\/\*\* Present only when `structuredDiff` is "available"\. \*\/\s*\n\s*summary\?:/);
    for (const read of seo.match(/\.summary[^\n]*/g) ?? []) {
      expect(read, read.trim()).toContain("summary?.");
    }
  });

  test("every published patch declares whether a structural diff covers it", () => {
    for (const patch of readPublicPatchNotes().patches) {
      expect(patch.structuredDiff, patch.version).toMatch(/^(available|unavailable)$/);
    }
  });

  test("no published patch carries a summary it cannot back with evidence", () => {
    for (const patch of readPublicPatchNotes().patches) {
      if (patch.structuredDiff === "available") continue;
      expect(patch.summary, `${patch.version} must not publish a summary`).toBeUndefined();
    }
  });

  test("prose-only history entries are never published as verified zero", () => {
    // Historical cards only ever had Riot's article metadata — no snapshot
    // pair was ever compared for them, so none may claim a measured count.
    const [, ...history] = readPublicPatchNotes().patches;
    for (const patch of history) {
      expect(patchChangeState(patch), patch.version).toBe("unavailable");
    }
  });
});

describe("patch diff state: locale copy", () => {
  test("each state has distinct, non-empty copy in every locale", () => {
    for (const locale of locales) {
      const patchNotes = readMessages(locale).patchNotes;
      const keys = [
        "diffUnavailableTitle",
        "diffUnavailableBody",
        "diffNoChangesTitle",
        "diffNoChangesBody",
      ] as const;

      for (const key of keys) {
        expect(patchNotes[key], `${locale}.patchNotes.${key}`).toEqual(expect.any(String));
        expect(patchNotes[key]!.trim(), `${locale}.patchNotes.${key}`).not.toBe("");
      }
      expect(
        patchNotes.diffUnavailableBody,
        `${locale}: unavailable and no-changes must not share wording`,
      ).not.toBe(patchNotes.diffNoChangesBody);
      expect(patchNotes.diffUnavailableTitle).not.toBe(patchNotes.diffNoChangesTitle);
    }
  });

  test("the homepage has an unknown label for the changed-augment count in every locale", () => {
    for (const locale of locales) {
      const dashboard = readMessages(locale).dashboard;
      expect(dashboard.metaChangedUnknown, `${locale}`).toEqual(expect.any(String));
      expect(dashboard.metaChangedUnknown!.trim()).not.toBe("");
    }
  });
});

describe("patch diff state: render paths", () => {
  test("the summary cards render only behind a measured diff", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/patch-notes/PatchNotesView.tsx"),
      "utf8",
    );

    expect(source).toContain("patchChangeState(patch)");
    expect(source).toContain('t("diffUnavailableBody")');
    expect(source).toContain('t("diffNoChangesBody")');
    // The zeroed-summary early return that rendered nothing at all is gone:
    // an unmeasured patch now says so.
    expect(source).not.toContain("if (!summary) return null;");
  });

  test("an empty patch card explains which of the two empties it is", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/patch-notes/PatchCard.tsx"),
      "utf8",
    );

    expect(source).toContain("patch.sections.length === 0");
    expect(source).toContain('patchChangeState(patch) === "no-changes"');
  });

  test("the current patch is explained once, not twice", () => {
    // PatchSummary already names the state above the card, so the card's own
    // line is suppressed there — and only there.
    const view = readFileSync(
      path.join(process.cwd(), "src/components/patch-notes/PatchNotesView.tsx"),
      "utf8",
    );
    const detail = readFileSync(
      path.join(process.cwd(), "src/app/[locale]/patch-notes/[patch]/page.tsx"),
      "utf8",
    );

    expect(view).toContain("explainEmpty={false}");
    // The standalone detail route has no summary card, so it keeps the line.
    expect(detail).not.toContain("explainEmpty");
  });

  test("the homepage shows no changed-augment count, so an unmeasured diff can't read as zero", () => {
    // The old Home printed a count (unknown when unmeasured). v3 Home drops the
    // count; the patch notes' own page states which of the two empties it is.
    const home = readFileSync(
      path.join(process.cwd(), "src/app/[locale]/page.tsx"),
      "utf8",
    );

    expect(home).toContain('const measured = patchChangeState(note) !== "unavailable";');
    expect(home).not.toMatch(/MetaAtAGlance|changedAugmentCount/);
  });

  test("the homepage banner stops promising a change list it does not have", () => {
    const home = readFileSync(
      path.join(process.cwd(), "src/app/[locale]/page.tsx"),
      "utf8",
    );
    const banner = readFileSync(
      path.join(process.cwd(), "src/components/dashboard/PatchPulseBanner.tsx"),
      "utf8",
    );

    expect(home).toContain("<PatchPulseBanner changesMeasured={measured} />");
    expect(banner).toContain('changesMeasured ? t("seeWhatChanged") : tNav("patchNotes")');
  });
});
