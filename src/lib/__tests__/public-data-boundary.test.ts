import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf-8"));
}

function collectForbiddenKeys(
  value: unknown,
  forbidden: ReadonlySet<string>,
  currentPath = "$",
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectForbiddenKeys(entry, forbidden, `${currentPath}[${index}]`),
    );
  }
  if (!value || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, entry]) => [
    ...(forbidden.has(key) ? [`${currentPath}.${key}`] : []),
    ...collectForbiddenKeys(entry, forbidden, `${currentPath}.${key}`),
  ]);
}

describe("public data boundary", () => {
  test("keeps full decision telemetry internal and strips it from public catalogs", () => {
    const internalAugments = readJson("data/internal/augments.json") as {
      augments: Array<Record<string, unknown>>;
    };
    const publicAugments = readJson("public/data/augments.json") as {
      augments: Array<Record<string, unknown>>;
    };

    expect(internalAugments.augments.some((augment) => "win_rate" in augment)).toBe(true);
    expect(publicAugments.augments.every((augment) => !("win_rate" in augment))).toBe(true);
  });

  test("does not publish decision-only combos, rules, weights, pools, or item telemetry", () => {
    const publicCombos = readJson("public/data/combos.json") as {
      combos: Array<Record<string, unknown>>;
    };
    const publicPoolRules = readJson("public/data/pool-rules.json") as {
      disabled: unknown[];
      mutually_exclusive: unknown[];
      item_exclusions: unknown[];
      ally_exclusions: unknown[];
      lifecycle?: { added?: Record<string, unknown>; removed?: Record<string, unknown> };
      availability?: unknown;
      availability_overrides?: unknown;
    };
    const publicItems = readJson("public/data/items.json") as {
      items: Array<Record<string, unknown>>;
    };
    const publicAugments = readJson("public/data/augments.json");
    const forbiddenTelemetry = [
      "win_rate",
      "winRate",
      "oracleScore",
      "modelWeights",
      "scoreBreakdown",
      "computedPool",
      "championPools",
      "availability",
      "signals",
      "provenance",
      "dataValues",
      "calculations",
      "wikiAvailabilityNotes",
      "wikiFetchedAt",
      "cdragon",
      "cdragonIcon",
      "cdragonRarity",
      "canonicalTooltip",
      "effectText",
      "effectTextByLocale",
      "definitionPlaceholder",
      "legacyCatalogRow",
    ];
    const forbiddenItemKeys = new Set(forbiddenTelemetry);
    const forbiddenAugmentKeys = new Set([...forbiddenTelemetry, "wikiNotes"]);

    // Freemium teaser: a small slice of S-tier "strong combos" is published
    // (names + tier only) for SEO/AI-citability and as a conversion hook. The
    // full combo set, traps (C-tier), oracle scores, and the curated internal
    // `ref` stay member-only.
    const teaser = publicCombos.combos;
    expect(teaser.length).toBeGreaterThan(0);
    // only the headline S-tier strong combos are teased — never traps or A/B
    expect(teaser.every((combo) => combo.tier === "S")).toBe(true);
    // exactly champion/augment/tier are exposed — no `ref` leak, no telemetry
    for (const combo of teaser) {
      expect(Object.keys(combo).sort()).toEqual(["augment", "champion", "tier"]);
    }
    // at most 3 teased per champion — a hook, not the full pool
    const perChampion = new Map<string, number>();
    for (const combo of teaser) {
      const key = String(combo.champion);
      perChampion.set(key, (perChampion.get(key) ?? 0) + 1);
    }
    expect([...perChampion.values()].every((count) => count <= 3)).toBe(true);

    expect(publicPoolRules.disabled).toEqual([]);
    expect(publicPoolRules.mutually_exclusive).toEqual([]);
    expect(publicPoolRules.item_exclusions).toEqual([]);
    expect(publicPoolRules.ally_exclusions).toEqual([]);
    expect(publicPoolRules.lifecycle).toEqual({ added: {}, removed: {} });
    expect(publicPoolRules.availability).toBeUndefined();
    expect(publicPoolRules.availability_overrides).toBeUndefined();
    expect(collectForbiddenKeys(publicItems, forbiddenItemKeys)).toEqual([]);
    expect(collectForbiddenKeys(publicAugments, forbiddenAugmentKeys)).toEqual([]);
    expect(
      publicItems.items.filter((item) =>
        Array.isArray(item.wikiNotes) && item.wikiNotes.length > 0
      ).length,
    ).toBeGreaterThan(0);
  });

  test("keeps champion rank, win rate, and pick rate public", () => {
    const publicChampions = readJson("public/data/champions.json") as {
      champions: Array<Record<string, unknown>>;
    };

    expect(publicChampions.champions.length).toBeGreaterThan(100);
    for (const champion of publicChampions.champions) {
      expect(champion).toHaveProperty("rank");
      expect(champion).toHaveProperty("win_rate");
      expect(champion).toHaveProperty("pick_rate");
      expect(champion.champion_key).toMatch(/^\d+$/);
    }
    expect(new Set(publicChampions.champions.map((champion) => champion.champion_key)).size)
      .toBe(publicChampions.champions.length);
  });

  test("member overlay sync is a separate package and does not loosen website public catalogs", () => {
    const syncSource = readFileSync(
      path.join(ROOT, "overlay/scripts/sync-data.mjs"),
      "utf-8",
    );
    const publicAugments = readJson("public/data/augments.json") as {
      augments: Array<Record<string, unknown>>;
    };
    const publicCombos = readJson("public/data/combos.json") as {
      combos: Array<Record<string, unknown>>;
    };

    expect(syncSource).toContain('"data", "internal"');
    expect(publicAugments.augments.every((augment) => !("win_rate" in augment))).toBe(true);
    expect(publicCombos.combos.every((combo) => combo.tier === "S")).toBe(true);
  });

  test("publishes only sanitized localized augment descriptions", () => {
    const publicAugments = readJson("public/data/augments.json") as {
      augments: Array<Record<string, unknown>>;
    };

    expect(publicAugments.augments.length).toBeGreaterThan(0);
    let localizedCount = 0;
    for (const augment of publicAugments.augments) {
      expect(augment.effectTextByLocale).toBeUndefined();
      const localizedDescriptions = [
        augment.description_zh_TW,
        augment.description_zh_CN,
        augment.description_ja,
        augment.description_ko,
      ];
      const hasDescriptions = localizedDescriptions.every((value) => typeof value === "string");
      const hasNoDescriptions = localizedDescriptions.every((value) => value === undefined);
      expect(hasDescriptions || hasNoDescriptions, `${augment.slug}.description_<locale>`).toBe(true);
      if (hasDescriptions) {
        localizedCount += 1;
        for (const description of localizedDescriptions) {
          expect(String(description), `${augment.slug}.description_<locale>`).not.toMatch(/<[^>]+>/);
        }
      }
    }
    expect(localizedCount).toBeGreaterThan(200);
  });

  test("bounds the PBE preview to active public events without raw lineage or history", () => {
    const preview = readJson("public/data/pbe-preview.json") as {
      branch?: string;
      lane?: string;
      status?: string;
      events?: Array<Record<string, unknown>>;
    };
    const forbiddenPreviewKeys = new Set([
      "comparison",
      "lifecycle",
      "first_seen_cycle",
      "last_seen_cycle",
      "last_seen_at",
      "observed_cycles",
      "landed_at",
      "source_version",
      "entities",
      "history",
      "provenance",
      "dataValues",
      "calculations",
      "modelWeights",
      "scoreBreakdown",
    ]);
    const publicFiles = readdirSync(path.join(ROOT, "public", "data"));
    const publicLoader = readFileSync(path.join(ROOT, "src/lib/data/public-loader.ts"), "utf-8");
    const publicApi = readFileSync(path.join(ROOT, "src/lib/api/public-catalog.ts"), "utf-8");
    const previewComponent = readFileSync(
      path.join(ROOT, "src/components/patch-notes/PbePreview.tsx"),
      "utf-8",
    );

    expect(preview.branch).toBe("pbe");
    expect(preview.lane).toBe("preview");
    expect(["fresh", "stale", "unavailable", "not_yet_confirmed"]).toContain(preview.status);
    expect(collectForbiddenKeys(preview, forbiddenPreviewKeys)).toEqual([]);
    expect(
      publicFiles.filter((name) =>
        name.startsWith("cdragon-") || name === "patch-events.json" || name === "pbe-preview-history.json",
      ),
    ).toEqual([]);
    expect(publicLoader).not.toContain("pbe-preview.json");
    expect(publicApi).not.toContain("pbe-preview");
    expect(previewComponent).not.toContain("use client");

    for (const event of preview.events ?? []) {
      expect(event.branch).toBe("pbe");
      expect(event.lane).toBe("preview");
      expect(event.landed).toBe(false);
    }
  });
});
