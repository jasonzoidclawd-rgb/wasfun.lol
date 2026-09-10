/**
 * Source-backed regression for the controlled Zoe offers of 2026-07-21
 * (12:13:43 and 12:18:xx), locking the CHAMPION-ONLY statistics policy.
 *
 * Root cause the controlled tests exposed: the overlay loaded Zoe's table from
 * the champion PAGE flight payload, which embeds only a ~60-augment subset. Any
 * offered augment outside that subset fell through to the GLOBAL value — wrong.
 * The authoritative COMPLETE file `/data/champion-augments/142.json` (136 rows,
 * captured 2026-07-21, patch 16.14 / site "26.14") carries every Zoe row.
 *
 * Verified champion-specific values (from the complete file, reproduced below):
 *
 *   title        id    Zoe complete            old GLOBAL bug   corrected badge
 *   奪命飛踢     2006  tier 4 (B) / 0.42575    S · 58.0%        B · 42.6%
 *   基本功夫     1004  tier 3 (A) / 0.459799   (same, S global) A · 46.0%
 *   劍舞之心     1006  tier 5 (C) / 0.399317   C · 48.1%        C · 39.9%
 *   裂地龍魂     1057  tier 4 (B) / 0.424...   B · 49.6%        B · 42.4%
 *   飛影跑法     1073  tier 2 (S) / 0.449...   S · 44.9%        S · 44.9% (was already champ)
 *   因心成體     1056  tier 4 (B) / 0.440...   S · 53.7%        B · 44.0%
 *
 * The global record must NEVER appear. Absence from a COMPLETE table is
 * NO CHAMP DATA; absence from a PARTIAL table keeps loading. Endpoint:
 * https://aramgg.com/data/champion-augments/142.json
 */
import { describe, expect, it } from "vitest";
import {
  buildRiotTitleIndex,
  resolveOcrTitle,
  type RiotTitleResolution,
} from "./aramggSource";
import {
  parseChampionAugmentDataset,
  resolvedStatToAramggStat,
  selectAugmentStat,
  type ChampionAugmentDataset,
} from "./championStats";
import { compactWinRateFromFraction } from "../winRateFormat";

// ─── Minimal source-backed catalog (verbatim display names) ───
const ZH_TW_CATALOG = {
  "1004": { displayName: "基本功夫", name: "ARAM_BacktoBasics" },
  "1006": { displayName: "劍舞之心", name: "ARAM_BladeWaltz" },
  "1056": { displayName: "因心成體", name: "ARAM_ScopedWeapons" },
  "1057": { displayName: "裂地龍魂", name: "ARAM_Earthwake" },
  "1073": { displayName: "飛影跑法", name: "ARAM_Slipstream" },
  "2006": { displayName: "奪命飛踢", name: "ARAM_Dropkick" },
} as const;
const ZH_CN_CATALOG = {
  "2006": { displayName: "飞身踢", name: "ARAM_Dropkick" },
} as const;

// ─── Zoe's COMPLETE augment table (verbatim rows from the authoritative file) ───
const ZOE_COMPLETE_RAW = {
  championId: "142",
  tier: "5",
  win_rate: "0.450172",
  augments: {
    "2006": { tier: "4", rank: "97", win_rate: "0.42575", num_games: "1266" },
    "1004": { tier: "3", rank: "42", win_rate: "0.459799", num_games: "398" },
    "1006": { tier: "5", rank: "123", win_rate: "0.399317", num_games: "879" },
    "1057": { tier: "4", rank: "100", win_rate: "0.424", num_games: "375" },
    "1073": { tier: "2", rank: "49", win_rate: "0.449261", num_games: "10288" },
    "1056": { tier: "4", rank: "77", win_rate: "0.440411", num_games: "1653" },
  },
} as const;

function zoeComplete(): ChampionAugmentDataset {
  return parseChampionAugmentDataset(ZOE_COMPLETE_RAW, {
    championId: "142",
    patch: "16.14",
    source: "https://aramgg.com/data/champion-augments/142.json",
    completeness: "complete",
  });
}

/** OCR title → canonical id → champion-only selection → badge. No global input exists. */
function publishSlot(ocrTitle: string, dataset: ChampionAugmentDataset) {
  const index = buildRiotTitleIndex(ZH_TW_CATALOG, ZH_CN_CATALOG);
  const riot = resolveOcrTitle(ocrTitle, index);
  if (riot.augmentId === null) throw new Error(`title "${ocrTitle}" did not resolve: ${riot.reason}`);
  const sel = selectAugmentStat(dataset, riot.augmentId);
  if (sel.kind !== "resolved") {
    return { canonicalAugmentId: riot.augmentId, kind: sel.kind, badge: null as string | null };
  }
  const stat = resolvedStatToAramggStat(sel.stat);
  return {
    canonicalAugmentId: riot.augmentId,
    statisticsAugmentId: stat.augmentId,
    provenance: stat.provenance,
    kind: "resolved" as const,
    badge: `${stat.tierLetter} · ${compactWinRateFromFraction(stat.rawWinRate)}`,
    riot: riot as RiotTitleResolution,
  };
}

describe("Zoe offers — champion-specific badges only (source-backed complete data)", () => {
  it("奪命飛踢 (2006) renders Zoe's B · 42.6%, NEVER the global S · 58.0%", () => {
    const p = publishSlot("奪命飛踢", zoeComplete());
    expect(p.canonicalAugmentId).toBe("2006");
    expect(p.provenance).toBe("champion");
    expect(p.badge).toBe("B · 42.6%");
    expect(p.badge).not.toBe("S · 58.0%"); // the removed global fallback value
  });

  it("基本功夫 (1004) renders Zoe's A · 46.0%", () => {
    const p = publishSlot("基本功夫", zoeComplete());
    expect(p.canonicalAugmentId).toBe("1004");
    expect(p.badge).toBe("A · 46.0%");
  });

  it("劍舞之心 (1006) renders Zoe's C · 39.9%, NEVER the global C · 48.1%", () => {
    const p = publishSlot("劍舞之心", zoeComplete());
    expect(p.canonicalAugmentId).toBe("1006");
    expect(p.badge).toBe("C · 39.9%");
    expect(p.badge).not.toBe("C · 48.1%");
  });

  it("因心成體 (1056) renders Zoe's B · 44.0%, NEVER the global S · 53.7% (wrong tier too)", () => {
    const p = publishSlot("因心成體", zoeComplete());
    expect(p.canonicalAugmentId).toBe("1056");
    expect(p.badge).toBe("B · 44.0%");
    expect(p.badge).not.toBe("S · 53.7%");
  });

  it("裂地龍魂 (1057) renders Zoe's B · 42.4%, NEVER the global B · 49.6%", () => {
    const p = publishSlot("裂地龍魂", zoeComplete());
    expect(p.badge).toBe("B · 42.4%");
    expect(p.badge).not.toBe("B · 49.6%");
  });

  it("飛影跑法 (1073) renders Zoe's S · 44.9% (already champion-specific, unchanged)", () => {
    const p = publishSlot("飛影跑法", zoeComplete());
    expect(p.badge).toBe("S · 44.9%");
  });

  it("every published slot's statistics id equals its resolved canonical id", () => {
    for (const t of ["奪命飛踢", "基本功夫", "劍舞之心", "裂地龍魂", "飛影跑法", "因心成體"]) {
      const p = publishSlot(t, zoeComplete());
      if (p.kind !== "resolved") throw new Error(`${t} did not resolve`);
      expect(p.statisticsAugmentId).toBe(p.canonicalAugmentId);
      expect(p.provenance).toBe("champion");
    }
  });

  it("an augment absent from Zoe's COMPLETE table is NO CHAMP DATA, never global", () => {
    // 9999 is not in Zoe's table; there is no global fallback to substitute.
    const index = buildRiotTitleIndex(
      { "9999": { displayName: "未知增幅", name: "ARAM_Unknown" } },
      {},
    );
    const riot = resolveOcrTitle("未知增幅", index);
    if (riot.augmentId === null) throw new Error("fixture title should resolve");
    const sel = selectAugmentStat(zoeComplete(), riot.augmentId);
    expect(sel.kind).toBe("no-champ-data");
  });
});
