import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  isConfirmedLive,
  isDisabled,
  notOfferedRank,
  partitionByAvailability,
} from "@/lib/augments/availability";

type CatalogAugment = {
  slug: string;
  name: string;
  rarity: string;
  availability?: { status?: string };
  flags?: { lifecycle?: string };
};

function readCatalog(): CatalogAugment[] {
  const { augments } = JSON.parse(
    readFileSync(path.join(process.cwd(), "public/data/augments.json"), "utf-8"),
  ) as { augments: CatalogAugment[] };
  return augments;
}

function readAugmentsClient(): string {
  return readFileSync(
    path.join(process.cwd(), "src/components/augments/AugmentsClient.tsx"),
    "utf-8",
  );
}

describe("augment availability is derived, never written down", () => {
  test("the UI names no augment's lifecycle in prose", () => {
    // The page carried "Fetch, Quest: Sneakerhead and Spin Me Right Round are
    // currently disabled". By the time it was read: Fetch was not in the
    // catalog at all, Spin Me Right Round was confirmed_live, and ten other
    // augments were disabled. Any hand-written list decays the same way.
    const source = readAugmentsClient();

    expect(source).not.toMatch(/currently disabled/i);
    expect(source).not.toMatch(/cannot appear in games/i);
  });

  test("no augment in the catalog is named in a hard-coded disabled claim", () => {
    const source = readAugmentsClient();
    const disabledProse = source.match(/^.*\bdisabled\b.*$/gim) ?? [];

    // Every surviving mention of "disabled" must be a derivation, not a name.
    for (const line of disabledProse) {
      expect(line, line.trim()).toMatch(/isDisabled|availability|DISABLED_STATUS|per-patch fact/);
    }
  });

  test("the grid and the not-offered table both partition on availability.status", () => {
    const source = readAugmentsClient();

    expect(source).toContain("partitionByAvailability(augments).current");
    expect(source).toContain("partitionByAvailability(augments).notOffered");
    expect(source).toContain("isDisabled(augment)");
  });
});

describe("partitionByAvailability against the live catalog", () => {
  const catalog = readCatalog();

  test("the disabled set the UI shows is exactly the catalog's disabled set", () => {
    const { notOffered } = partitionByAvailability(catalog);
    const shownDisabled = notOffered.filter(isDisabled).map((a) => a.slug).sort();
    const catalogDisabled = catalog
      .filter((a) => a.availability?.status === "disabled")
      .map((a) => a.slug)
      .sort();

    expect(shownDisabled).toEqual(catalogDisabled);
    // Guards the assertion itself: an empty catalog would make it vacuous.
    expect(catalogDisabled.length).toBeGreaterThan(0);
  });

  test("no confirmed-live augment can be presented as not offered", () => {
    const { current, notOffered } = partitionByAvailability(catalog);

    expect(notOffered.some(isConfirmedLive)).toBe(false);
    expect(current.every(isConfirmedLive)).toBe(true);
  });

  test("every catalog augment with a status lands in exactly one partition", () => {
    const { current, notOffered } = partitionByAvailability(catalog);
    const withStatus = catalog.filter((a) => a.availability?.status);

    expect(current.length + notOffered.length).toBe(withStatus.length);
    expect(new Set([...current, ...notOffered]).size).toBe(withStatus.length);
  });

  test("lifecycle flags never override the availability verdict", () => {
    // `flags.lifecycle` folds four states onto "removed", which is how a
    // temporarily disabled augment became indistinguishable from a deleted one.
    const disabledButFlaggedRemoved = catalog.filter(
      (a) => a.availability?.status === "disabled" && a.flags?.lifecycle === "removed",
    );

    for (const augment of disabledButFlaggedRemoved) {
      expect(isDisabled(augment), augment.slug).toBe(true);
    }
  });

  test("disabled entries sort ahead of historical ones", () => {
    const { notOffered } = partitionByAvailability(catalog);
    const ranks = notOffered
      .slice()
      .sort((a, b) => notOfferedRank(a) - notOfferedRank(b))
      .map(notOfferedRank);

    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(notOfferedRank({ availability: { status: "disabled" } })).toBe(0);
    expect(notOfferedRank({ availability: { status: "removed" } })).toBe(1);
  });

  test("an augment with no resolved status is claimed neither live nor withdrawn", () => {
    const { current, notOffered } = partitionByAvailability([
      { slug: "unresolved", name: "Unresolved", rarity: "gold" },
      ...catalog.slice(0, 3),
    ]);

    expect(current.some((a) => a.slug === "unresolved")).toBe(false);
    expect(notOffered.some((a) => a.slug === "unresolved")).toBe(false);
  });
});
