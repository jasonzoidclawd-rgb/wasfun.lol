import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildPatchSummary } from "@/lib/seo/patch-summary";

const forbiddenSummaryTerms = [
  "oracleScore",
  "modelWeights",
  "scoreBreakdown",
  "computedPool",
  "championPools",
  "poolRules",
  "signals",
  "provenance",
  "data/internal",
  "prompt",
  "openai",
  "anthropic",
  "llm",
  "supabase",
  "member",
  "session",
];

/** Mirrors the English `augments.patchSummary*` message templates. */
const AVAILABILITY_COPY: Record<string, (name: string) => string> = {
  disabled: (name) => `${name} is currently disabled and is not offered this patch.`,
  removed: (name) => `${name} has been removed from the current pool.`,
  unverified_legacy: (name) =>
    `${name} is a historical entry we could not verify against current game data.`,
  candidate_registry_present: (name) =>
    `${name} appears in the game registry but is not offered.`,
};

function englishCopy(name: string) {
  return {
    title: "Patch summary",
    body: ({ patch }: { patch: string }) =>
      `This augment page for ${name} reflects public Arena Mayhem data for patch ${patch}.`,
    availability: (status: string) => AVAILABILITY_COPY[status]?.(name),
    dated: ({ patch, event }: { patch: string; event: string }) =>
      event === "added"
        ? `${name} was added in patch ${patch}.`
        : `${name} was removed in patch ${patch}.`,
  };
}

describe("public patch summary", () => {
  test("builds a bounded current-patch summary from the public patch value", () => {
    const summary = buildPatchSummary({ patch: "26.13" }, englishCopy("Tank Engine"));

    expect(summary?.title).toBe("Patch summary");
    expect(summary?.lines).toEqual([
      "This augment page for Tank Engine reflects public Arena Mayhem data for patch 26.13.",
    ]);
  });

  test("returns null without a public patch value so no unsourced freshness claim renders", () => {
    expect(buildPatchSummary({}, englishCopy("Tank Engine"))).toBeNull();
    expect(buildPatchSummary({ patch: "  " }, englishCopy("Tank Engine"))).toBeNull();
  });

  test("includes lifecycle wording only when an availability status is passed", () => {
    const active = buildPatchSummary({ patch: "26.18" }, englishCopy("Tank Engine"));
    const removed = buildPatchSummary(
      { patch: "26.18", availabilityStatus: "removed" },
      englishCopy("Warlock Juicebox"),
    );

    expect(active?.lines).toHaveLength(1);
    expect(removed?.lines).toContain("Warlock Juicebox has been removed from the current pool.");
  });

  test("does not render wording for statuses outside the public allowlist", () => {
    for (const availabilityStatus of ["new", "internal-only", "conflict"]) {
      const summary = buildPatchSummary(
        { patch: "26.18", availabilityStatus },
        englishCopy("Tank Engine"),
      );

      expect(summary?.lines, availabilityStatus).toEqual([
        "This augment page for Tank Engine reflects public Arena Mayhem data for patch 26.18.",
      ]);
    }
  });

  test("each allowlisted status gets its own distinct sentence", () => {
    const lines = new Set<string>();
    for (const status of Object.keys(AVAILABILITY_COPY)) {
      const summary = buildPatchSummary(
        { patch: "26.18", availabilityStatus: status },
        englishCopy("Tank Engine"),
      );
      const line = summary!.lines[1];
      expect(line, status).toBeTruthy();
      lines.add(line);
    }
    expect(lines.size).toBe(Object.keys(AVAILABILITY_COPY).length);
  });

  test("skips the lifecycle line when no availability copy is provided", () => {
    const { title, body } = englishCopy("Warlock Juicebox");
    const summary = buildPatchSummary(
      { patch: "26.18", availabilityStatus: "removed" },
      { title, body },
    );

    expect(summary?.lines).toEqual([
      "This augment page for Warlock Juicebox reflects public Arena Mayhem data for patch 26.18.",
    ]);
  });

  test("NEVER falls back to the page patch when the lifecycle date is missing", () => {
    // Inverted deliberately. This previously asserted the fallback, which is
    // what made 69 pages claim "marked removed in patch <statistics clock>"
    // for augments that had no dated removal event — several of which were
    // merely disabled.
    const summary = buildPatchSummary(
      { patch: "26.18", availabilityStatus: "removed" },
      englishCopy("Warlock Juicebox"),
    );

    expect(summary?.lines.join(" ")).not.toContain("was removed in patch");
    expect(summary?.lines).toEqual([
      "This augment page for Warlock Juicebox reflects public Arena Mayhem data for patch 26.18.",
      "Warlock Juicebox has been removed from the current pool.",
    ]);
  });

  test("does not invent changes when no public changes are provided", () => {
    const summary = buildPatchSummary({ patch: "26.13" }, englishCopy("Tank Engine"));

    expect(summary?.lines.join(" ")).not.toMatch(/buff|nerf|changed|reworked/i);
  });

  test("keeps private scoring, prompts, and session terms out of summary output", () => {
    const summary = buildPatchSummary(
      {
        patch: "26.18",
        availabilityStatus: "removed",
        lifecyclePatch: "26.18",
        lifecycleEvent: "removed",
      },
      englishCopy("Tank Engine"),
    );
    const serialized = JSON.stringify(summary).toLowerCase();

    for (const term of forbiddenSummaryTerms) {
      expect(serialized).not.toContain(term.toLowerCase());
    }
  });

  test("augment detail page renders a localized patch summary section", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/app/[locale]/augments/[slug]/page.tsx"),
      "utf8",
    );

    expect(source).toContain('import { buildPatchSummary } from "@/lib/seo/patch-summary"');
    expect(source).toContain("const patchSummary = buildPatchSummary(");
    expect(source).toContain('t("patchSummaryTitle")');
    expect(source).toContain('t("patchSummaryBody", { name: augmentName, patch })');
    expect(source).toContain("availability: (status) =>");
    expect(source).toContain("AVAILABILITY_SUMMARY_KEYS");
    // The page must stamp the catalog with the structural clock.
    expect(source).toContain("patch: clocks.structuralPatch");
    expect(source).toContain("{patchSummary && (");
    expect(source).toContain("patchSummary.lines.map");
  });

  test("item detail page renders a localized patch summary section from public meta patch", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/app/[locale]/items/[identifier]/page.tsx"),
      "utf8",
    );

    expect(source).toContain('import { buildPatchSummary } from "@/lib/seo/patch-summary"');
    expect(source).toContain('import { readItemsFile, readMetaFile } from "@/lib/data/read-public-file"');
    expect(source).toContain("const patchSummary = buildPatchSummary(");
    expect(source).toContain('t("patchSummaryTitle")');
    expect(source).toContain('t("patchSummaryBody", { name: itemName, patch })');
    expect(source).toContain("{patchSummary && (");
    expect(source).toContain("patchSummary.lines.map");
  });

  test("patch summary copy exists in every locale message file", () => {
    for (const locale of ["en", "zh-TW", "zh-CN", "ja", "ko"]) {
      const messages = JSON.parse(
        readFileSync(path.join(process.cwd(), `messages/${locale}.json`), "utf8"),
      ) as { augments: Record<string, string>; items: Record<string, string> };

      for (const key of [
        "patchSummaryTitle",
        "patchSummaryBody",
        "patchSummaryDisabled",
        "patchSummaryRemoved",
        "patchSummaryUnverified",
        "patchSummaryCandidate",
        "patchSummaryAddedIn",
        "patchSummaryRemovedIn",
      ]) {
        expect(messages.augments[key], `${locale}.augments.${key}`).toBeTruthy();
      }
      for (const key of ["patchSummaryTitle", "patchSummaryBody"]) {
        expect(messages.items[key], `${locale}.items.${key}`).toBeTruthy();
      }
      for (const namespace of ["augments", "items"] as const) {
        expect(messages[namespace].patchSummaryBody).toContain("{name}");
        expect(messages[namespace].patchSummaryBody).toContain("{patch}");
      }
      // State sentences describe a STATE and must not template a patch;
      // only the dated sentences may carry one.
      for (const key of [
        "patchSummaryDisabled",
        "patchSummaryRemoved",
        "patchSummaryUnverified",
        "patchSummaryCandidate",
      ]) {
        expect(messages.augments[key], `${locale}.${key}`).toContain("{name}");
        expect(messages.augments[key], `${locale}.${key}`).not.toContain("{patch}");
      }
      for (const key of ["patchSummaryAddedIn", "patchSummaryRemovedIn"]) {
        expect(messages.augments[key], `${locale}.${key}`).toContain("{name}");
        expect(messages.augments[key], `${locale}.${key}`).toContain("{patch}");
      }
    }
  });
});
