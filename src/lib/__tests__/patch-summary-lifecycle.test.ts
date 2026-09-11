import { describe, expect, test } from "vitest";
import { buildPatchSummary } from "@/lib/seo/patch-summary";

/**
 * Regression: every non-offerable augment rendered
 *   "X is marked removed in patch <page patch>."
 * because the dated line fell back to the page's patch when no lifecycle date
 * existed — and the page's patch was the STATISTICS clock. Two falsehoods:
 * disabled augments described as removed, and a fabricated removal patch.
 */
const COPY = {
  title: "Patch summary",
  body: ({ patch }: { patch: string }) => `Reflects patch ${patch}.`,
  availability: (status: string) =>
    ({
      disabled: "Currently disabled.",
      removed: "Removed from the current pool.",
      unverified_legacy: "Historical entry we could not verify.",
      candidate_registry_present: "Candidate entry.",
    })[status],
  dated: ({ patch, event, provenance }: { patch: string; event: string; provenance: string }) => {
    const causal = provenance === "riot_patch_notes";
    if (event === "added") {
      return causal ? `Added in ${patch}.` : `First observed in ${patch}.`;
    }
    return causal ? `Removed in ${patch}.` : `First observed as removed in ${patch}.`;
  },
};

describe("patch summary lifecycle truth", () => {
  test("a disabled augment is never described as removed", () => {
    const summary = buildPatchSummary(
      { patch: "26.18", availabilityStatus: "disabled" },
      COPY,
    );
    expect(summary!.lines).toContain("Currently disabled.");
    expect(summary!.lines.join(" ")).not.toContain("Removed");
  });

  test("no lifecycle date means no dated claim at all", () => {
    const summary = buildPatchSummary(
      { patch: "26.18", availabilityStatus: "removed" },
      COPY,
    );
    expect(summary!.lines).toEqual(["Reflects patch 26.18.", "Removed from the current pool."]);
    // The exact regression: must not borrow the page patch as a removal date.
    expect(summary!.lines.join(" ")).not.toContain("Removed in 26.18");
  });

  test("a snapshot-derived date renders OBSERVATION wording, not causal", () => {
    // Adjacency proves the transition happened between two observations one
    // patch apart. It does not prove Riot made the change in that patch: an
    // undocumented hotfix, a late CDragon publish, or an incomplete previous
    // snapshot all produce the same evidence.
    const summary = buildPatchSummary(
      {
        patch: "26.18",
        availabilityStatus: "confirmed_live",
        lifecyclePatch: "26.18",
        lifecycleEvent: "added",
        lifecycleProvenance: "snapshot_diff",
      },
      COPY,
    );
    expect(summary!.lines).toContain("First observed in 26.18.");
    expect(summary!.lines.join(" ")).not.toContain("Added in 26.18.");
  });

  test("causal wording is reserved for an authoritative Riot record", () => {
    const summary = buildPatchSummary(
      {
        patch: "26.18",
        availabilityStatus: "confirmed_live",
        lifecyclePatch: "26.18",
        lifecycleEvent: "added",
        lifecycleProvenance: "riot_patch_notes",
      },
      COPY,
    );
    expect(summary!.lines).toContain("Added in 26.18.");
  });

  test("unknown provenance falls back to the WEAKER claim", () => {
    const summary = buildPatchSummary(
      { patch: "26.18", lifecyclePatch: "26.18", lifecycleEvent: "removed" },
      COPY,
    );
    expect(summary!.lines).toContain("First observed as removed in 26.18.");
    expect(summary!.lines.join(" ")).not.toContain("Removed in 26.18.");
  });

  test("a lifecycle patch without an event kind is not rendered", () => {
    const summary = buildPatchSummary(
      { patch: "26.18", availabilityStatus: "removed", lifecyclePatch: "26.18" },
      COPY,
    );
    // Body + state line only; the dated line requires BOTH patch and event.
    expect(summary!.lines).toEqual([
      "Reflects patch 26.18.",
      "Removed from the current pool.",
    ]);
  });

  test("each availability status gets distinct copy", () => {
    const seen = new Set<string>();
    for (const status of [
      "disabled",
      "removed",
      "unverified_legacy",
      "candidate_registry_present",
    ]) {
      const summary = buildPatchSummary({ patch: "26.18", availabilityStatus: status }, COPY);
      const line = summary!.lines[1];
      expect(line, status).toBeTruthy();
      expect(seen.has(line), `${status} reuses copy`).toBe(false);
      seen.add(line);
    }
  });

  test("entities without availability copy (items) still render the body", () => {
    const summary = buildPatchSummary({ patch: "26.18" }, { title: "t", body: COPY.body });
    expect(summary!.lines).toEqual(["Reflects patch 26.18."]);
  });
});

describe("published lifecycle dates are event-derived", () => {
  test("no augment carries a lifecycle patch without an event kind", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const data = JSON.parse(
      readFileSync(path.join(process.cwd(), "public/data/augments.json"), "utf-8"),
    ) as { augments: Array<{ slug: string; flags?: Record<string, unknown> }> };

    for (const augment of data.augments) {
      const hasPatch = Boolean(augment.flags?.lifecycle_patch);
      const hasEvent = Boolean(augment.flags?.lifecycle_event);
      expect(hasPatch, augment.slug).toBe(hasEvent);
    }
    // The discredited field must not reappear.
    expect(
      data.augments.some((a) => "lifecycle_observed_patch" in (a.flags ?? {})),
    ).toBe(false);

    // Every dated event we can currently produce is snapshot-derived, so none
    // may carry causal provenance.
    for (const augment of data.augments) {
      if (augment.flags?.lifecycle_patch) {
        expect(augment.flags.lifecycle_provenance, augment.slug).toBe("snapshot_diff");
      }
    }
  });
});
