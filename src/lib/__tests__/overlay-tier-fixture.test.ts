import { describe, expect, test } from "vitest";
import {
  disabledMember,
  memberRecommendationsVisible,
} from "../../../overlay/src/auth/member";
import { formatWinRate, tierForGrade } from "../../../overlay/src/model/tier";
import {
  buildAramggDecisionResult,
  aramggStatScopeLabel,
  isTierFixtureEnabled,
  tierFixtureEnabledFrom,
  type AramggFixtureCard,
} from "../../../overlay/src/dev/tierFixture";
import {
  buildCatalogIndex,
  buildRiotTitleIndex,
  decimalShiftPercent,
  loadAramggSource,
  numericTierToGrade,
  numericTierToLetter,
  parseAramggSource,
  parseNumericTier,
  parseStatsList,
  resolveAugmentId,
  resolveOcrTitle,
  type AramggRaws,
  type AramggStat,
} from "../../../overlay/src/dev/aramggSource";
import {
  geometryPreviewEnabledFrom,
  resolveOverlayFixtureMode,
  type FixtureModeInput,
} from "../../../overlay/src/dev/fixtureMode";
import { localOverlayAuthorized } from "../../../overlay/src/augmentOverlayGate";

// ─── Fixtures modeling the real ARAMGG shapes ───

const CATALOG = {
  // unambiguous icon
  "1001": { name: "ARAM_Alpha", displayName: "阿尔法", iconLarge: "Alpha_large.png" },
  // 1002 & 1003 share an icon base → ambiguous unless localized name breaks it
  "1002": { name: "ARAM_Beta", displayName: "贝塔", iconLarge: "Shared_large.png" },
  "1003": { name: "ARAM_Gamma", displayName: "伽马", iconLarge: "Shared_large.png" },
  // duplicate display names → ambiguous localized-name lookup
  "1004": { name: "ARAM_Delta1", displayName: "重复", iconLarge: "D1_large.png" },
  "1005": { name: "ARAM_Delta2", displayName: "重复", iconLarge: "D2_large.png" },
  // Mayhem carries a "MayhemAugment" suffix ARAMGG omits
  "1006": { name: "ARAM_Warlock", displayName: "术士", iconLarge: "WarlockJuicebox_large.png" },
};

// Riot-localized zh-TW catalog (same numeric IDs / canonical ARAM_* names as
// the zh_cn file, displayName in Traditional Chinese). 2100 mirrors the REAL
// live-failure augment: 疾速追擊 (Pursuit of Haste, ARAM_SpecializedRecursion),
// whose icon is a GENERIC gold ability icon shared by many augments — identity
// must come from the zh-TW title alone (quest cards also obscure the icon).
const CATALOG_ZH_TW = {
  "2100": {
    name: "ARAM_SpecializedRecursion",
    displayName: "疾速追擊",
    iconLarge: "GenericAbilityAugmentIcon_Gold_large.png",
  },
  // Riot identity resolves but ARAMGG has NO stat record (distinct state).
  "2101": {
    name: "ARAM_NoStats",
    displayName: "無數據增幅",
    iconLarge: "GenericAbilityAugmentIcon_Gold_large.png",
  },
  // Two entries share a zh-TW display name → ambiguous, must be rejected.
  "2102": {
    name: "ARAM_Dup1",
    displayName: "同名增幅",
    iconLarge: "GenericAbilityAugmentIcon_Gold_large.png",
  },
  "2103": {
    name: "ARAM_Dup2",
    displayName: "同名增幅",
    iconLarge: "GenericAbilityAugmentIcon_Gold_large.png",
  },
  // zh-TW name deliberately far from the zh-CN "阿尔法" so the zh-CN exact
  // last-resort path is reachable.
  "1001": { name: "ARAM_Alpha", displayName: "阿爾法泰坦", iconLarge: "Alpha_large.png" },
};

const STATS_RAW = [
  ["1001", JSON.stringify({
    win_rate: "0.563213",
    num_games: "988166",
    pick_rate: "0.008409",
    tier: "2",
    top_champions: [
      {
        champion_rank: "1",
        champion_id: "30",
        win_rate: "0.533",
        num_games: "20000",
        pick_rate: "0.01",
        tier: "1",
      },
      {
        champion_rank: "2",
        champion_id: "54",
        win_rate: "0.49",
        num_games: "13595",
        pick_rate: "0.009",
        tier: "2",
      },
      { champion_rank: "bad", champion_id: "not-numeric", win_rate: 0.5 },
    ],
    augment_stage_stats: [
      { augment_stage: "1", win_rate: "0.51", num_games: "123" },
    ],
  })],
  // length-5 entry: blob at index 1, trailing metadata (mirrors observed data)
  ["1002", JSON.stringify({ win_rate: "0.5", num_games: "60000", tier: "1" }), "m1", "m2", "m3"],
  ["1006", JSON.stringify({ win_rate: "0.641955", num_games: "1903216", pick_rate: "0.02", tier: "1" })],
  // 疾速追擊 — the real ARAMGG record (id 2100, tier 2 → S).
  ["2100", JSON.stringify({ win_rate: "0.537058", num_games: "79794", pick_rate: "0.01", tier: "2" })],
  ["1009", JSON.stringify({ win_rate: "0.4", num_games: "500", tier: "9" })], // bad tier → skipped
  ["1010", 12345], // no string blob → skipped
  "not-an-array", // skipped
];

describe("overlay ARAMGG tier fixture (dev-only)", () => {
  describe("disabled by default / production unchanged", () => {
    test("pure predicate is false with no flag", () => {
      expect(tierFixtureEnabledFrom({ dev: true, flag: undefined })).toBe(false);
      expect(tierFixtureEnabledFrom({ dev: true, flag: "0" })).toBe(false);
    });
    test("production build (dev=false) is inert even with the flag set", () => {
      expect(tierFixtureEnabledFrom({ dev: false, flag: "1" })).toBe(false);
    });
    test("only dev + flag === '1' enables; every other value is off", () => {
      expect(tierFixtureEnabledFrom({ dev: true, flag: "1" })).toBe(true);
      for (const flag of ["0", "", "true", "yes", "01", " 1"]) {
        expect(tierFixtureEnabledFrom({ dev: true, flag })).toBe(false);
      }
    });
    test("live wrapper is disabled in the ambient vitest env", () => {
      expect(isTierFixtureEnabled()).toBe(false);
    });
    test("production win-rate formatting still rounds to one decimal", () => {
      expect(formatWinRate(68.99)).toBe("69.0% WR");
      expect(formatWinRate(51.913)).toBe("51.9% WR");
      expect(formatWinRate(50)).toBe("50.0% WR");
      expect(formatWinRate(null)).toBe("WR —");
    });
    test("fixture enablement never fabricates a member entitlement", () => {
      const unauthenticated = disabledMember("unauthenticated");

      expect(tierFixtureEnabledFrom({ dev: true, flag: "1" })).toBe(true);
      expect(memberRecommendationsVisible(false, unauthenticated)).toBe(false);
      expect(memberRecommendationsVisible(true, unauthenticated)).toBe(false);
    });
    test("only the explicit flag authorizes local overlay content in dev", () => {
      // A plain `npm run tauri dev` launch (flag unset, member unauthenticated)
      // must expose no tiers, win rates, scope labels, or fallback data.
      const unauthenticated = memberRecommendationsVisible(
        true,
        disabledMember("unauthenticated"),
      );

      expect(localOverlayAuthorized({
        devBuild: true,
        tierFixtureEnabled: tierFixtureEnabledFrom({ dev: true, flag: undefined }),
        memberCoachEnabled: unauthenticated,
      })).toBe(false);
      expect(localOverlayAuthorized({
        devBuild: true,
        tierFixtureEnabled: tierFixtureEnabledFrom({ dev: true, flag: "1" }),
        memberCoachEnabled: unauthenticated,
      })).toBe(true);
      expect(localOverlayAuthorized({
        devBuild: false,
        tierFixtureEnabled: tierFixtureEnabledFrom({ dev: false, flag: "1" }),
        memberCoachEnabled: unauthenticated,
      })).toBe(false);
    });
  });

  describe("exact win-rate via string decimal shift (no IEEE-754 artifacts)", () => {
    test.each([
      ["0.563213", "56.3213"],
      ["0.5", "50"],
      ["0.5000", "50.00"],
      ["1", "100"],
      ["0", "0"],
      ["0.641955", "64.1955"],
    ])("%s → %s", (input, expected) => {
      expect(decimalShiftPercent(input)).toBe(expected);
    });
    test("never introduces a float artifact the way ×100 would", () => {
      expect(decimalShiftPercent("0.563213")).toBe("56.3213");
      expect(decimalShiftPercent("0.563213")).not.toContain("0000000");
      // documents the artifact we deliberately avoid
      expect(String(0.563213 * 100)).not.toBe("56.3213");
    });
    test.each(["", "abc", "-0.5", "1.2.3", "1e3", ".5", "0."])(
      "rejects malformed fraction %s",
      (bad) => {
        expect(() => decimalShiftPercent(bad)).toThrow();
      },
    );
  });

  describe("tier mapping 1→S+ … 5→C", () => {
    test.each([
      ["1", "S+", "hot"],
      ["2", "S", "strong"],
      ["3", "A", "steady"],
      ["4", "B", "average"],
      ["5", "C", "weak"],
    ] as const)("tier %s", (tier, letter, grade) => {
      expect(numericTierToLetter(tier)).toBe(letter);
      expect(numericTierToGrade(tier)).toBe(grade);
      // the render path shows tierForGrade(grade) — must equal the letter
      expect(tierForGrade(numericTierToGrade(tier))).toBe(letter);
    });
    test.each(["0", "6", "x", "", " ", "1.0", "-1"])("rejects malformed tier %s", (bad) => {
      expect(() => parseNumericTier(bad)).toThrow();
    });
  });

  describe("parse nested statsJSONString", () => {
    test("double-parses, handles variable-length entries, skips malformed", () => {
      const { stats, skipped } = parseStatsList(STATS_RAW);
      expect(stats.get("1001")?.winRatePercent).toBe("56.3213");
      expect(stats.get("1001")?.tier).toBe(2);
      expect(stats.get("1001")?.tierLetter).toBe("S");
      expect(stats.get("1002")?.winRatePercent).toBe("50"); // length-5 entry
      expect(stats.get("1006")?.numGames).toBe("1903216");
      expect(stats.has("1009")).toBe(false); // bad tier
      expect(stats.has("1010")).toBe(false); // no blob
      expect(skipped).toBeGreaterThanOrEqual(3);
    });
    test("parses real-shaped top_champions and skips malformed children", () => {
      const { stats, skippedChampionStats } = parseStatsList(STATS_RAW);
      const global = stats.get("1001");
      expect(global).toMatchObject({
        provenance: "global",
        championId: null,
        winRatePercent: "56.3213",
      });
      expect(global?.topChampionsById.get("30")).toMatchObject({
        provenance: "champion",
        championId: "30",
        championRank: "1",
        winRatePercent: "53.3",
        tierLetter: "S+",
      });
      expect(global?.topChampionsById.get("54")).toMatchObject({
        provenance: "champion",
        championId: "54",
        winRatePercent: "49",
        tierLetter: "S",
      });
      expect(global?.topChampionsById.has("not-numeric")).toBe(false);
      expect(skippedChampionStats).toBe(1);
    });
    test("selects a champion row by numeric key; a missing champion has no row (no global fallback)", () => {
      // Champion-only contract: badges come from a champion's own row. A missing
      // champion resolves to ABSENCE (→ NO CHAMP DATA), never a global-fallback
      // number. The former global-fallback selectors were removed with that
      // policy change (see aramggSource.ts) — this pins the no-fallback lookup.
      const { stats } = parseStatsList(STATS_RAW);
      const global = stats.get("1001")!;
      expect(global.topChampionsById.get("30")).toMatchObject({
        provenance: "champion",
        championId: "30",
        winRatePercent: "53.3",
      });
      expect(global.topChampionsById.get("999")).toBeUndefined();
    });
    test("changing champion selects each augment's own champion row without retaining stale rows", () => {
      const { stats } = parseStatsList(STATS_RAW);
      const karthus1001 = stats.get("1001")!.topChampionsById.get("30");
      const malphite1001 = stats.get("1001")!.topChampionsById.get("54");

      expect(karthus1001).toMatchObject({ provenance: "champion", championId: "30" });
      expect(malphite1001).toMatchObject({ provenance: "champion", championId: "54" });
      // Distinct rows per champion — one champion's stat never aliases another's.
      expect(malphite1001).not.toBe(karthus1001);
      // Every champion row is champion-specific: a champion-54 lookup never
      // returns champion 30's row.
      for (const [, stat] of stats) {
        const row54 = stat.topChampionsById.get("54");
        if (row54) expect(row54.championId).toBe("54");
      }
    });
    test("visible scope labels match the champion row or the global row", () => {
      const { stats } = parseStatsList(STATS_RAW);
      const global = stats.get("1001")!;
      expect(aramggStatScopeLabel(global.topChampionsById.get("30")!)).toBe("CHAMP");
      expect(aramggStatScopeLabel(global)).toBe("GLOBAL");
    });
    test("throws on a non-array payload (never fabricates)", () => {
      expect(() => parseStatsList({} as unknown)).toThrow();
    });
  });

  describe("canonical-ID matching priority (no silent ambiguous match)", () => {
    const index = buildCatalogIndex(CATALOG);

    test("priority 1: numeric canonical augment ID", () => {
      expect(resolveAugmentId({ numericId: "1001" }, index)).toEqual({
        augmentId: "1001",
        method: "canonical-name",
      });
    });
    test("priority 2: language-independent canonical (ARAM_*) name", () => {
      expect(resolveAugmentId({ canonicalName: "ARAM_Gamma" }, index)).toEqual({
        augmentId: "1003",
        method: "canonical-name",
      });
    });
    test("priority 2: unambiguous CDragon icon base", () => {
      expect(resolveAugmentId({ iconBase: "alpha" }, index)).toEqual({
        augmentId: "1001",
        method: "cdragon-icon",
      });
    });
    test("icon 'MayhemAugment' suffix still resolves via normalization", () => {
      expect(resolveAugmentId({ iconBase: "warlockjuicebox" }, index)).toEqual({
        augmentId: "1006",
        method: "cdragon-icon",
      });
    });
    test("ambiguous icon is rejected without a tie-break", () => {
      const r = resolveAugmentId({ iconBase: "shared" }, index);
      expect(r.augmentId).toBeNull();
      expect((r as { reason: string }).reason).toBe("ambiguous-icon");
    });
    test("ambiguous icon disambiguated by localized name", () => {
      expect(
        resolveAugmentId({ iconBase: "shared", localizedName: "贝塔" }, index),
      ).toEqual({ augmentId: "1002", method: "cdragon-icon+zh-tiebreak" });
    });
    test("priority 3: localized display-name last resort", () => {
      expect(resolveAugmentId({ localizedName: "阿尔法" }, index)).toEqual({
        augmentId: "1001",
        method: "localized-name",
      });
    });
    test("ambiguous localized name is rejected", () => {
      const r = resolveAugmentId({ localizedName: "重复" }, index);
      expect(r.augmentId).toBeNull();
      expect((r as { reason: string }).reason).toBe("ambiguous-name");
    });
    test("no match yields unmatched (never a guess)", () => {
      const r = resolveAugmentId({ iconBase: "nope", localizedName: "无" }, index);
      expect(r.augmentId).toBeNull();
      expect((r as { reason: string }).reason).toBe("unmatched");
    });
  });

  describe("Riot zh-TW title bridge (quest augment identity)", () => {
    const index = buildRiotTitleIndex(CATALOG_ZH_TW, CATALOG);

    test("疾速追擊: exact zh-TW OCR title → canonical numeric ID 2100", () => {
      const riot = resolveOcrTitle("疾速追擊", index);
      expect(riot).toMatchObject({
        augmentId: "2100",
        canonicalName: "ARAM_SpecializedRecursion",
        zhTwName: "疾速追擊",
        method: "riot-zh-tw-exact",
        confidence: 1,
      });
    });

    test("resolution is icon-independent: the shared generic gold icon plays no role", () => {
      // 2100 and 2101 share GenericAbilityAugmentIcon_Gold — icon-based
      // resolution would be ambiguous. The title bridge never consults the
      // icon (resolveOcrTitle takes no icon input), so BOTH resolve uniquely
      // — exactly the quest-card case where the icon is obscured anyway.
      expect(resolveOcrTitle("疾速追擊", index).augmentId).toBe("2100");
      expect(resolveOcrTitle("無數據增幅", index).augmentId).toBe("2101");
    });

    test("疾速追击 (one-character Simplified drift) resolves via unambiguous zh-TW fuzzy", () => {
      const riot = resolveOcrTitle("疾速追击", index);
      expect(riot).toMatchObject({
        augmentId: "2100",
        method: "riot-zh-tw-fuzzy",
        confidence: 0.9,
      });
    });

    test("an ambiguous zh-TW name is rejected, never guessed", () => {
      const rejection = resolveOcrTitle("同名增幅", index);
      expect(rejection.augmentId).toBeNull();
      expect((rejection as { reason: string }).reason).toBe("ambiguous-zh-tw-name");
    });

    test("zh-CN exact name is a logged LAST RESORT with reduced confidence", () => {
      // "阿尔法" appears only in the zh_cn catalog; no zh-TW name is within
      // one-character drift, so the Simplified exact path is the only match.
      const riot = resolveOcrTitle("阿尔法", index);
      expect(riot).toMatchObject({
        augmentId: "1001",
        method: "riot-zh-cn-exact",
        confidence: 0.8,
      });
    });

    test("an unknown title is rejected as riot-catalog-unmatched", () => {
      const rejection = resolveOcrTitle("不存在的增幅名", index);
      expect(rejection.augmentId).toBeNull();
      expect((rejection as { reason: string }).reason).toBe("riot-catalog-unmatched");
    });

    test("an empty/whitespace title is rejected as empty-title", () => {
      for (const empty of ["", "   ", null, undefined]) {
        const rejection = resolveOcrTitle(empty, index);
        expect(rejection.augmentId).toBeNull();
        expect((rejection as { reason: string }).reason).toBe("empty-title");
      }
    });

    test("'Riot resolved, no ARAMGG record' is distinguishable from 'unresolved'", () => {
      const source = parseAramggSource(
        {
          stats: STATS_RAW,
          catalog: CATALOG,
          catalogZhTw: CATALOG_ZH_TW,
          changelog: { latest: "16.13" },
        },
        0,
      );
      // 疾速追擊: identity resolved AND a live stat record exists.
      const haste = resolveOcrTitle("疾速追擊", source.titleIndex);
      expect(haste.augmentId).toBe("2100");
      expect(source.statsById.get("2100")?.winRatePercent).toBe("53.7058");
      expect(source.statsById.get("2100")?.tierLetter).toBe("S");
      // 無數據增幅: identity resolved but NO stat record — a different state
      // from a catalog-unmatched title, and diagnosed as such.
      const noData = resolveOcrTitle("無數據增幅", source.titleIndex);
      expect(noData.augmentId).toBe("2101");
      expect(source.statsById.has("2101")).toBe(false);
    });

    test("parseAramggSource throws when the zh-TW catalog has zero titles", () => {
      expect(() =>
        parseAramggSource(
          {
            stats: STATS_RAW,
            catalog: CATALOG,
            catalogZhTw: {},
            changelog: { latest: "16.13" },
          },
          0,
        ),
      ).toThrow(/zero localized titles/);
    });
  });

  describe("decision result uses ONLY ARAMGG stats (no synthetic/local fallback)", () => {
    const stat = (over: Partial<AramggStat>): AramggStat => ({
      augmentId: "1001",
      rawWinRate: "0.563213",
      winRatePercent: "56.3213",
      numGames: "988166",
      pickRate: "0.008409",
      tier: 2,
      tierLetter: "S",
      grade: "strong",
      provenance: "global",
      championId: null,
      championRank: null,
      topChampionsById: new Map(),
      ...over,
    });
    const cards: AramggFixtureCard[] = [
      { slug: "alpha", stat: stat({}), method: "cdragon-icon" },
      {
        slug: "beta",
        stat: stat({
          augmentId: "1002",
          rawWinRate: "0.5",
          winRatePercent: "50",
          numGames: "600",
          tier: 1,
          tierLetter: "S+",
          grade: "hot",
        }),
        method: "cdragon-icon+zh-tiebreak",
      },
    ];

    test("winRateDisplayBySlug carries the exact string, not a rounded/float value", () => {
      const payload = buildAramggDecisionResult(cards, 1);
      expect(payload.winRateDisplayBySlug["alpha"]).toBe("56.3213");
      expect(payload.winRateDisplayBySlug["beta"]).toBe("50");
    });
    test("grade → tierForGrade reproduces the relabeled ARAMGG tier on every card", () => {
      const payload = buildAramggDecisionResult(cards, 1);
      for (const c of payload.result.candidates) {
        const row = payload.debugRows.find((d) => d.slug === c.augmentSlug)!;
        expect(tierForGrade(c.grade)).toBe(row.cardTier);
      }
    });
    test("confidence reflects real sample size (low below threshold)", () => {
      const payload = buildAramggDecisionResult(cards, 1);
      const alpha = payload.result.candidates.find((c) => c.augmentSlug === "alpha")!;
      const beta = payload.result.candidates.find((c) => c.augmentSlug === "beta")!;
      expect(alpha.confidence).toBe("high"); // 988166 games
      expect(beta.confidence).toBe("low"); // 600 games
    });
    test("debug rows expose full provenance for every rendered card", () => {
      const payload = buildAramggDecisionResult(cards, 1);
      expect(payload.debugRows).toHaveLength(2);
      expect(payload.debugRows[0]).toMatchObject({
        slug: "alpha",
        augmentId: "1001",
        method: "cdragon-icon",
        rawWinRate: "0.563213",
        winRatePercent: "56.3213",
        upstreamTier: 2,
        cardTier: "S",
        statProvenance: "global",
        championId: null,
      });
    });
    test("decision reasons and diagnostics label champion-specific provenance", () => {
      const payload = buildAramggDecisionResult([
        {
          slug: "alpha",
          stat: stat({ provenance: "champion", championId: "30", championRank: "1" }),
          method: "cdragon-icon",
        },
      ], 1);
      expect(payload.result.candidates[0].reasons).toContain("aramgg:scope-champion");
      expect(payload.debugRows[0]).toMatchObject({
        statProvenance: "champion",
        championId: "30",
      });
    });
  });

  describe("formatWinRate string passthrough (exact source, no float)", () => {
    test("passes the exact percentage string through verbatim", () => {
      expect(formatWinRate("56.3213")).toBe("56.3213% WR");
      expect(formatWinRate("50.00")).toBe("50.00% WR");
    });
    test("empty string renders the missing marker", () => {
      expect(formatWinRate("")).toBe("WR —");
    });
  });

  describe("loadAramggSource fails explicitly, never fakes", () => {
    const okResponse = (data: unknown) =>
      ({ ok: true, status: 200, json: async () => data }) as Response;

    const fakeFetch = (map: Record<string, unknown>): typeof fetch =>
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        const key = Object.keys(map).find((k) => url.includes(k));
        if (!key) return { ok: false, status: 404, json: async () => ({}) } as Response;
        return okResponse(map[key]);
      }) as typeof fetch;

    test("parses a full live payload (all four files) through the dev proxy paths", async () => {
      const source = await loadAramggSource(
        fakeFetch({
          "augments-stats-raw.json": STATS_RAW,
          "aram-mayhem-augments.zh_cn.json": CATALOG,
          "aram-mayhem-augments.zh_tw.json": CATALOG_ZH_TW,
          "augments-changelog/index.json": { versions: ["16.13"], latest: "16.13" },
        }),
      );
      expect(source.patch).toBe("16.13");
      expect(source.statsById.get("1001")?.winRatePercent).toBe("56.3213");
      expect(source.titleIndex.byZhTwName.has("疾速追擊")).toBe(true);
      expect(source.sourceUrls.stats).toBe("https://aramgg.com/data/augments-stats-raw.json");
      expect(source.sourceUrls.catalogZhTw).toBe(
        "https://aramgg.com/data/aram-mayhem-augments.zh_tw.json",
      );
    });
    test("throws (does not fabricate) when a file 404s", async () => {
      await expect(
        loadAramggSource(fakeFetch({ "aram-mayhem-augments.zh_cn.json": CATALOG })),
      ).rejects.toThrow(/HTTP 404/);
    });
    test("throws when stats parse to zero valid records", () => {
      const raws: AramggRaws = {
        stats: ["garbage"],
        catalog: CATALOG,
        catalogZhTw: CATALOG_ZH_TW,
        changelog: { latest: "16.13" },
      };
      expect(() => parseAramggSource(raws, 0)).toThrow(/zero valid records/);
    });
  });
});

// ─── Release-blocking regressions from the 12:20–12:22 live test ───
//
// The reported defects (synthetic B/C/A badges over Finder/Safari, stale S
// badges lingering, injected records over real cards, non-recovery on refocus,
// a persistent empty translucent rectangle) all traced to auto-injected
// geometry firing whenever OCR dropped below three cards while forcing
// gameWindowForeground/phase. `resolveOverlayFixtureMode` is the pure state machine
// that replaces that logic; these tests pin every reported failure path.
describe("overlay fixture STATE MACHINE — release-blocking regressions", () => {
  const base: FixtureModeInput = {
    tierFixtureOn: true,
    previewOn: false,
    gameWindowForeground: true,
    phase: "augment_selection",
    offerActive: true,
    aramggReady: true,
  };
  const kind = (o: Partial<FixtureModeInput> = {}) =>
    resolveOverlayFixtureMode({ ...base, ...o }).kind;

  // 1. focus → blur → focus with the SAME offer
  test("focus→blur→focus (same offer): real → hidden → real recovers", () => {
    expect(kind({ gameWindowForeground: true })).toBe("real-offer");
    expect(kind({ gameWindowForeground: false })).toBe("hidden"); // blur hides everything
    expect(kind({ gameWindowForeground: true })).toBe("real-offer"); // refocus recovers
  });

  // 2. focus → blur → focus with a CHANGED offer (OCR mid-rescan on refocus)
  test("focus→blur→focus (changed offer): no badges until the new offer latches", () => {
    expect(kind({ gameWindowForeground: false })).toBe("hidden");
    // refocused but the new offer has not latched yet → diagnostic, not stale
    // badges from the prior offer (blur reset the offer state)
    expect(kind({ gameWindowForeground: true, offerActive: false })).toBe("ocr-unavailable");
    // the new offer latches → per-slot badges
    expect(kind({ gameWindowForeground: true, offerActive: true })).toBe("real-offer");
  });

  // 3. OCR failure while League remains visible/focused
  test("OCR failure while League focused → diagnostic, never synthetic", () => {
    expect(kind({ offerActive: false })).toBe("ocr-unavailable");
    // ARAMGG not ready is still a diagnostic, never a geometry/preview fallback
    expect(kind({ offerActive: false, aramggReady: false })).toBe("ocr-unavailable");
  });

  // 4. no synthetic fallback in an active game
  test("active game (in_game) never injects geometry", () => {
    expect(kind({ phase: "in_game", offerActive: false })).toBe("hidden");
    // even with the preview flag on, a running game (non-idle) suppresses preview
    expect(kind({ phase: "in_game", previewOn: true, gameWindowForeground: false })).toBe("hidden");
  });

  // 5. no badges outside League (unfocused or not detected)
  test("League unfocused/idle hides all in-game surfaces", () => {
    expect(kind({ gameWindowForeground: false, phase: "augment_selection" })).toBe("hidden");
    expect(kind({ gameWindowForeground: false, phase: "idle" })).toBe("hidden");
    expect(kind({ gameWindowForeground: true, phase: "idle" })).toBe("hidden");
    expect(kind({ gameWindowForeground: false, phase: "client_found" })).toBe("hidden");
  });

  // 6. stale-offer invalidation: with no LATCHED offer there are never real
  // badges. (Per-slot safety within a latched offer — a slot never shows stale
  // or invented data — is the offerLifecycle contract, pinned in
  // overlay/src/offerLifecycle.test.ts.)
  test("no latched offer is never rendered as real badges", () => {
    expect(kind({ offerActive: false })).not.toBe("real-offer");
  });

  // 7 & 9. single overlay surface / no duplicate layers: the resolver returns
  // exactly ONE mode, and real-offer vs preview are mutually exclusive because
  // preview requires League to be entirely absent.
  test("real-offer and preview are mutually exclusive (no duplicate layers)", () => {
    // preview flag + focused real offer → real-offer wins, no preview overlay
    expect(
      kind({ previewOn: true, gameWindowForeground: true, phase: "augment_selection" }),
    ).toBe("real-offer");
    // preview flag + League entirely absent → preview only
    expect(
      kind({
        tierFixtureOn: false,
        previewOn: true,
        gameWindowForeground: false,
        phase: "idle",
      }),
    ).toBe("preview");
  });

  // 8. no orphaned/synthetic surface: geometry preview requires its OWN flag AND
  // League entirely absent, and never fabricates stats.
  test("geometry preview requires its own flag AND League absent", () => {
    const preview = (o: Partial<FixtureModeInput>) =>
      kind({ tierFixtureOn: false, previewOn: true, ...o });
    // tier fixture alone (no preview flag) never previews, even idle+unfocused
    expect(kind({ previewOn: false, gameWindowForeground: false, phase: "idle" })).toBe("hidden");
    // preview flag but League focused → suppressed
    expect(preview({ gameWindowForeground: true, phase: "idle" })).toBe("hidden");
    // preview flag but a game is running (non-idle) → suppressed
    expect(preview({ gameWindowForeground: false, phase: "in_game" })).toBe("hidden");
    // preview flag + League absent (idle + unfocused) + ARAMGG ready → preview
    expect(preview({ gameWindowForeground: false, phase: "idle", aramggReady: true })).toBe("preview");
    // ARAMGG not ready → hidden, never synthetic stats
    expect(preview({ gameWindowForeground: false, phase: "idle", aramggReady: false })).toBe("hidden");
  });

  // 10. dummy P:50% removed — ARAMGG-backed candidates carry probability 0 (the
  // badge suppresses the `P:` span entirely for fixture-backed candidates).
  test("ARAMGG-backed candidates carry NO fabricated pick probability", () => {
    const card: AramggFixtureCard = {
      slug: "alpha",
      method: "cdragon-icon",
      stat: {
        augmentId: "1001",
        rawWinRate: "0.563213",
        winRatePercent: "56.3213",
        numGames: "988166",
        pickRate: "0.008409",
        tier: 2,
        tierLetter: "S",
        grade: "strong",
        provenance: "global",
        championId: null,
        championRank: null,
        topChampionsById: new Map(),
      },
    };
    const payload = buildAramggDecisionResult([card], 1);
    expect(payload.result.candidates[0].probability.withNormalRerolls).toBe(0);
    expect(payload.result.candidates[0].probability.initialThree).toBe(0);
  });

  // 11. atomic update: the badge layer requires a LATCHED offer; every slot in
  // it comes from ONE offer generation (applyScanToOffer returns a complete
  // snapshot — publish can never mix generations).
  test("real badges require a latched offer (atomic per-generation publish)", () => {
    expect(kind({ offerActive: true })).toBe("real-offer");
    expect(kind({ offerActive: false })).toBe("ocr-unavailable");
  });

  // preview enable predicate: dev build AND explicit flag=1 (separate from the
  // tier-fixture flag).
  test("geometryPreviewEnabledFrom requires dev build AND flag=1", () => {
    expect(geometryPreviewEnabledFrom({ dev: true, flag: "1" })).toBe(true);
    expect(geometryPreviewEnabledFrom({ dev: false, flag: "1" })).toBe(false);
    expect(geometryPreviewEnabledFrom({ dev: true, flag: undefined })).toBe(false);
    expect(geometryPreviewEnabledFrom({ dev: true, flag: "0" })).toBe(false);
  });
});
