import { describe, expect, test } from "vitest";
import augmentsData from "../../../data/internal/augments.json";
import championsData from "../../../data/internal/champions.json";
import poolRulesData from "../../../data/internal/pool-rules.json";
import { getChampionAugmentPool } from "../scoring/pool-orchestrator";
import type { PoolAugmentInput } from "../scoring/pool-orchestrator";
import type { ChampionTag, PoolRules } from "../types";

const EMPTY_POOL_RULES: PoolRules = {
  patch: "test",
  scraped_at: "test",
  disabled: [],
  mutually_exclusive: [],
  item_exclusions: [],
  ally_exclusions: [],
  lifecycle: { added: {}, removed: {} },
};

type Aug = { slug: string; rarity: "silver" | "gold" | "prismatic"; wikiDescription?: string; kit_tags?: ChampionTag[] };

function runPool(opts: {
  championSlug: string;
  championKitTags: ChampionTag[];
  augments: Aug[];
}) {
  return getChampionAugmentPool({
    championSlug: opts.championSlug,
    augments: opts.augments,
    championKitTags: opts.championKitTags,
    poolRules: EMPTY_POOL_RULES,
  });
}

describe("pool orchestrator — Layer 3 resource-tag asymmetry", () => {
  // Regression guard for the bug captured in
  // docs/champion-augment-pool-claude-codex-debate.md (2026-05-07).
  // classify_augments.py emits mana/manaless on augments;
  // classify_champions.py intentionally does NOT emit them on champions
  // (resource gating happens in Layer 2). Layer 3 must therefore strip
  // mana/manaless before computing tag overlap, otherwise every
  // `["mana"]`-only augment is silently excluded from every champion.

  test("a `[\"mana\"]`-only augment is NOT excluded from a champion lacking mana tag", () => {
    const result = runPool({
      championSlug: "ezreal", // mana-resource champion (irrelevant; pool tags are explicit)
      championKitTags: ["ability", "dot"], // intentionally no `mana` — mirrors classify_champions output
      augments: [
        {
          slug: "synthetic-mana-only-augment",
          rarity: "silver",
          wikiDescription: "Grants a flat bonus.", // benign description so Layer 2 doesn't filter
          kit_tags: ["mana"],
        },
      ],
    });

    expect(result.excluded.find((e) => e.slug === "synthetic-mana-only-augment")).toBeUndefined();
    expect(result.silver.map((a) => a.slug)).toContain("synthetic-mana-only-augment");
  });

  test("after stripping resource tags, a non-overlapping augment is still excluded by Layer 3", () => {
    // Verifies the filter only strips resource tags — it does NOT bypass Layer 3
    // entirely. An augment tagged ["mana", "crit"] facing a champion with
    // ["ability"] should still be excluded because, after dropping "mana",
    // remaining ["crit"] has no overlap with ["ability"].
    const result = runPool({
      championSlug: "anivia",
      championKitTags: ["ability"],
      augments: [
        {
          slug: "synthetic-mana-crit-augment",
          rarity: "gold",
          wikiDescription: "Grants a flat bonus.",
          kit_tags: ["mana", "crit"],
        },
      ],
    });

    const excluded = result.excluded.find((e) => e.slug === "synthetic-mana-crit-augment");
    expect(excluded).toBeDefined();
    expect(excluded?.reason).toBe("tag-mismatch");
  });

  test("a `[\"manaless\"]`-only augment is NOT excluded from a manaless champion", () => {
    // Symmetric guard: classify_augments may also emit `manaless`. The same
    // asymmetry means a `["manaless"]`-only augment would be excluded from
    // every champion (no champion has the tag) without the resource-tag strip.
    const result = runPool({
      championSlug: "garen", // manaless
      championKitTags: ["attack", "tank"],
      augments: [
        {
          slug: "synthetic-manaless-augment",
          rarity: "silver",
          wikiDescription: "Grants a flat bonus.",
          kit_tags: ["manaless"],
        },
      ],
    });

    expect(result.excluded.find((e) => e.slug === "synthetic-manaless-augment")).toBeUndefined();
    expect(result.silver.map((a) => a.slug)).toContain("synthetic-manaless-augment");
  });

  test("an augment with no kit_tags is universal and passes Layer 3", () => {
    const result = runPool({
      championSlug: "ahri",
      championKitTags: ["ability"],
      augments: [
        { slug: "synthetic-universal", rarity: "silver", wikiDescription: "Grants gold.", kit_tags: [] },
        { slug: "synthetic-universal-undef", rarity: "silver", wikiDescription: "Grants gold." },
      ],
    });
    expect(result.silver.map((a) => a.slug)).toEqual(
      expect.arrayContaining(["synthetic-universal", "synthetic-universal-undef"]),
    );
  });

  test("an augment with overlapping non-resource tag passes Layer 3", () => {
    const result = runPool({
      championSlug: "brand",
      championKitTags: ["ability", "dot"],
      augments: [
        {
          slug: "synthetic-ability-overlap",
          rarity: "gold",
          wikiDescription: "Grants AP.",
          kit_tags: ["ability"],
        },
      ],
    });
    expect(result.gold.map((a) => a.slug)).toContain("synthetic-ability-overlap");
  });
});

// ── Real-data pool behavior tests ─────────────────────────────────────────────
// Require classify_champions.py + classify_augments.py to have run (kit_tags populated).

describe("pool orchestrator — real-data behavior", () => {
  const allAugments = augmentsData.augments as unknown as PoolAugmentInput[];

  function getChampionTags(slug: string): ChampionTag[] {
    const champ = championsData.champions.find((c) => c.slug === slug) as unknown as { kit_tags?: ChampionTag[] };
    return champ?.kit_tags ?? [];
  }

  function runRealPool(championSlug: string) {
    return getChampionAugmentPool({
      championSlug,
      augments: allAugments,
      championKitTags: getChampionTags(championSlug),
      poolRules: EMPTY_POOL_RULES,
    });
  }

  function passedSlugs(result: ReturnType<typeof runRealPool>): string[] {
    return [...result.silver, ...result.gold, ...result.prismatic].map((a) => a.slug);
  }

  const MANA_REQUIRED_SLUGS = ["juiced", "mind-to-matter", "overflow", "ominous-pact"];

  test("manaless champion (garen) excludes MANA_REQUIRED augments via Layer 2", () => {
    const slugs = passedSlugs(runRealPool("garen"));
    for (const slug of MANA_REQUIRED_SLUGS) {
      expect(slugs).not.toContain(slug);
    }
  });

  test("manaless champion (yasuo) excludes MANA_REQUIRED augments via Layer 2", () => {
    const slugs = passedSlugs(runRealPool("yasuo"));
    for (const slug of MANA_REQUIRED_SLUGS) {
      expect(slugs).not.toContain(slug);
    }
  });

  test("mana champion (brand) sees overflow (mana-required, ability-tagged, passes both layers)", () => {
    // overflow: Layer 2 passes (brand has mana); Layer 3 passes (ability tag overlaps brand's tags).
    // Verifies Layer 2 resource gate is not over-excluding.
    expect(passedSlugs(runRealPool("brand"))).toContain("overflow");
  });

  test("Layer 3 narrows Brand's pool (brand sees fewer augments than total)", () => {
    // Brand has ["ability","cc","dot","haste"] — augments with no overlapping tags are excluded.
    const result = runRealPool("brand");
    expect(result.total).toBeLessThan(allAugments.length);
  });

  test("Brand's pool and Yasuo's pool are non-identical (Smart Tailoring is champion-specific)", () => {
    const brandSlugs = new Set(passedSlugs(runRealPool("brand")));
    const yasuoSlugs = new Set(passedSlugs(runRealPool("yasuo")));
    const symDiff =
      [...brandSlugs].filter((s) => !yasuoSlugs.has(s)).length +
      [...yasuoSlugs].filter((s) => !brandSlugs.has(s)).length;
    expect(symDiff).toBeGreaterThan(0);
  });
});

// ── 26.12 availability wiring ────────────────────────────────────────────────
// Uses the REAL generated pool-rules.json: resolved availability must reach
// Layer 1 so non-offerable augments are excluded with auditable reasons.

describe("pool orchestrator — 26.12 availability wiring", () => {
  test("non-offerable augments are excluded with their resolved availability reason", () => {
    // Expectations are DERIVED from the availability resolver, never hardcoded
    // per slug. Riot re-enabled Clown College in 26.18 and the resolver moved
    // it to `confirmed_live`; a hardcoded map would have asserted a fact about
    // the game that stopped being true, which is the same second-authority
    // problem that let `pool-rules.disabled` drift.
    const sampleSlugs = ["slow-and-steady", "clown-college", "adamant", "warlock-juicebox"];
    const nonOfferable = augmentsData.augments.filter(
      (augment) =>
        sampleSlugs.includes(augment.slug) &&
        augment.availability?.status !== undefined &&
        augment.availability.status !== "confirmed_live",
    );
    const expectedReasons = new Map(
      nonOfferable.map((augment) => [augment.slug, augment.availability!.status as string]),
    );
    // The sample must still exercise more than one non-offerable reason.
    expect(new Set(expectedReasons.values()).size).toBeGreaterThan(1);
    expect(nonOfferable.length).toBeGreaterThan(0);

    const result = getChampionAugmentPool({
      championSlug: "garen",
      augments: nonOfferable as unknown as PoolAugmentInput[],
      championKitTags: ["attack", "tank"] as ChampionTag[],
      poolRules: poolRulesData as unknown as PoolRules,
    });

    for (const aug of nonOfferable) {
      const exclusion = result.excluded.find((e) => e.slug === aug.slug);
      expect(exclusion?.reason, `${aug.slug} should be excluded by availability`).toBe(
        expectedReasons.get(aug.slug),
      );
    }
  });

  test("confirmed-live Jeweled Gauntlet is offerable without an observed-live override", () => {
    const jeweled = augmentsData.augments.find((a) => a.slug === "jeweled-gauntlet");
    expect(jeweled?.availability?.status).toBe("confirmed_live");
    expect(jeweled?.flags.lifecycle).toBe("active");
    expect((poolRulesData as { availability_overrides?: unknown }).availability_overrides).toBeUndefined();

    const result = getChampionAugmentPool({
      championSlug: "brand",
      augments: [jeweled] as unknown as PoolAugmentInput[],
      championKitTags: ["ability", "dot", "cc"] as ChampionTag[],
      poolRules: poolRulesData as unknown as PoolRules,
    });

    expect(result.excluded.find((e) => e.slug === "jeweled-gauntlet")).toBeUndefined();
    expect(result.prismatic.map((a) => a.slug)).toContain("jeweled-gauntlet");
  });
});
