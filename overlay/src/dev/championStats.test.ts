/**
 * Champion-FIRST augment dataset model (PR #46 corrected requirement).
 *
 * Source-backed fixtures: the exact rows ARAMGG embeds in the server-rendered
 * champion page flight payload at https://aramgg.com/en/champion-stats/{id}
 * (captured 2026-07-20, patch 16.14 / site "26.14"). Each `augments` entry is
 * keyed by the canonical numeric ARAMGG augment ID — the same join key the
 * catalog and global stats already use — and carries THAT champion's own tier,
 * win rate, pick rate and rank. This is NOT the sparse `top_champions` list; it
 * is the champion's complete published augment table.
 */
import { describe, expect, it } from "vitest";
import {
  extractChampionFlightObject,
  lookupChampionAugmentStat,
  parseChampionAugmentDataset,
  resolvedStatToAramggStat,
  selectAugmentStat,
  selectChampionSlotStat,
  type ChampionAugmentDataset,
} from "./championStats";

// ─── Real ARAMGG rows, verbatim from /en/champion-stats/56 (Nocturne) ───
// Verified against the rendered page: e.g. augment 1006 shows tier 1, 48.0096%.
const NOCTURNE_RAW = {
  championId: "56",
  tier: "4",
  win_rate: "0.464797",
  num_win_games: "18782",
  num_games: "40409",
  pick_rate: "0.002942",
  augments: {
    "1006": { tier: "1", rank: "26", num_win_games: "1809", win_rate: "0.480096", total: "136", num_games: "3768", pick_rate: "0.093247" },
    "1038": { tier: "2", rank: "15", num_win_games: "326", win_rate: "0.501538", total: "136", num_games: "650", pick_rate: "0.016086" },
    "1041": { tier: "1", rank: "5", num_win_games: "201", win_rate: "0.537433", total: "136", num_games: "374", pick_rate: "0.009255" },
    "1062": { tier: "1", rank: "4", num_win_games: "352", win_rate: "0.541538", total: "136", num_games: "650", pick_rate: "0.016086" },
  },
} as const;

// ─── Real ARAMGG rows, verbatim from /en/champion-stats/103 (Ahri) ───
const AHRI_RAW = {
  championId: "103",
  tier: "2",
  win_rate: "0.520904",
  num_win_games: "58771",
  num_games: "112825",
  pick_rate: "0.008215",
  augments: {
    "1006": { tier: "3", rank: "53", num_win_games: "2300", win_rate: "0.516854", total: "148", num_games: "4450", pick_rate: "0.02" },
    "1038": { tier: "2", rank: "8", num_win_games: "500", win_rate: "0.557659", total: "148", num_games: "897", pick_rate: "0.01" },
    "1041": { tier: "3", rank: "81", num_win_games: "300", win_rate: "0.5", total: "148", num_games: "600", pick_rate: "0.01" },
  },
} as const;

function nocturne(): ChampionAugmentDataset {
  return parseChampionAugmentDataset(NOCTURNE_RAW, {
    championId: "56",
    patch: "16.14",
    source: "https://aramgg.com/en/champion-stats/56",
  });
}
function ahri(): ChampionAugmentDataset {
  return parseChampionAugmentDataset(AHRI_RAW, {
    championId: "103",
    patch: "16.14",
    source: "https://aramgg.com/en/champion-stats/103",
  });
}

describe("parseChampionAugmentDataset — champion-first table", () => {
  it("keys by championId 56 and exposes Nocturne's own augment rows", () => {
    const ds = nocturne();
    expect(ds.championId).toBe("56");
    expect(ds.patch).toBe("16.14");
    expect(ds.source).toContain("/champion-stats/56");
    expect([...ds.statsByAugmentId.keys()].sort()).toEqual(["1006", "1038", "1041", "1062"]);
  });

  it("reproduces the exact tier, win rate, pick rate and rank from the source", () => {
    const stat = lookupChampionAugmentStat(nocturne(), "1006");
    expect(stat).not.toBeNull();
    expect(stat!.championId).toBe("56");
    expect(stat!.augmentId).toBe("1006");
    expect(stat!.tier).toBe(1);
    expect(stat!.tierLetter).toBe("S+");
    expect(stat!.rawWinRate).toBe("0.480096");
    expect(stat!.winRatePercent).toBe("48.0096"); // exact decimal shift, no float
    expect(stat!.rawPickRate).toBe("0.093247");
    expect(stat!.pickRatePercent).toBe("9.3247");
    expect(stat!.rank).toBe(26);
    expect(stat!.numGames).toBe("3768");
    expect(stat!.patch).toBe("16.14");
  });
});

describe("same augment id, different champion → different champion-specific value", () => {
  it("returns Nocturne's row from Nocturne, Ahri's row from Ahri", () => {
    const fromNocturne = lookupChampionAugmentStat(nocturne(), "1006")!;
    const fromAhri = lookupChampionAugmentStat(ahri(), "1006")!;
    // Same canonical augment id...
    expect(fromNocturne.augmentId).toBe(fromAhri.augmentId);
    // ...but genuinely different champion-specific statistics.
    expect(fromNocturne.tier).toBe(1);
    expect(fromNocturne.winRatePercent).toBe("48.0096");
    expect(fromAhri.tier).toBe(3);
    expect(fromAhri.winRatePercent).toBe("51.6854");
    expect(fromNocturne.championId).toBe("56");
    expect(fromAhri.championId).toBe("103");
  });
});

describe("champion-only selection — no global fallback exists", () => {
  it("resolves the champion's own row for a present augment (never a global value)", () => {
    const sel = selectAugmentStat(nocturne(), "1006");
    expect(sel.kind).toBe("resolved");
    if (sel.kind !== "resolved") throw new Error("unreachable");
    expect(sel.stat.label).toBe("CHAMP");
    expect(sel.stat.championId).toBe("56");
    expect(sel.stat.winRatePercent).toBe("48.0096");
    expect(sel.stat.tier).toBe(1);
  });

  it("COMPLETE dataset + absent augment → NO CHAMP DATA (never global)", () => {
    const sel = selectAugmentStat(nocturne(), "9999"); // nocturne() defaults to complete
    expect(sel.kind).toBe("no-champ-data");
  });

  it("PARTIAL dataset + absent augment → partial-pending, NOT no-champ-data", () => {
    const partial = parseChampionAugmentDataset(NOCTURNE_RAW, {
      championId: "56",
      patch: "16.14",
      source: "https://aramgg.com/en/champion-stats/56",
      completeness: "partial",
    });
    const sel = selectAugmentStat(partial, "9999");
    expect(sel.kind).toBe("partial-pending");
  });

  it("PARTIAL dataset + present augment may still resolve the champion row", () => {
    const partial = parseChampionAugmentDataset(NOCTURNE_RAW, {
      championId: "56",
      patch: "16.14",
      source: "https://aramgg.com/en/champion-stats/56",
      completeness: "partial",
    });
    const sel = selectAugmentStat(partial, "1006");
    expect(sel.kind).toBe("resolved");
  });

  it("parseChampionAugmentDataset defaults to complete and reports loadedCount", () => {
    const ds = nocturne();
    expect(ds.completeness).toBe("complete");
    expect(ds.loadedCount).toBe(4);
  });

  it("rejects a complete source with zero usable augment rows as an integrity error", () => {
    expect(() =>
      parseChampionAugmentDataset({
        augments: {
          "not-an-augment-id": { tier: "1", win_rate: "0.5" },
          "1001": null,
          "1002": { tier: "1" },
          "1003": { tier: "1", win_rate: "not-a-rate" },
          "1004": { tier: "not-a-tier", win_rate: "0.5" },
        },
      }, {
        championId: "56",
        patch: "16.14",
        source: "https://aramgg.com/data/champion-augments/56.json",
        completeness: "complete",
      }),
    ).toThrow(/complete.*zero usable/i);
  });
});

describe("selectChampionSlotStat — the four badge states, never global", () => {
  function partial(): ChampionAugmentDataset {
    return parseChampionAugmentDataset(NOCTURNE_RAW, {
      championId: "56",
      patch: "16.14",
      source: "https://aramgg.com/en/champion-stats/56",
      completeness: "partial",
    });
  }

  it("fetch error → error, regardless of any dataset", () => {
    expect(selectChampionSlotStat("error", nocturne(), "1006").status).toBe("error");
    expect(selectChampionSlotStat("error", null, "1006").status).toBe("error");
  });

  it("no active dataset yet (idle/loading) → loading", () => {
    expect(selectChampionSlotStat("loading", null, "1006").status).toBe("loading");
    expect(selectChampionSlotStat("idle", null, "1006").status).toBe("loading");
  });

  it("ready + complete + present → resolved with the champion row", () => {
    const s = selectChampionSlotStat("ready", nocturne(), "1006");
    expect(s.status).toBe("resolved");
    if (s.status !== "resolved") throw new Error("unreachable");
    expect(s.stat.winRatePercent).toBe("48.0096");
    expect(s.stat.championId).toBe("56");
  });

  it("ready + complete + absent → no-champ-data (never a global value)", () => {
    expect(selectChampionSlotStat("ready", nocturne(), "9999").status).toBe("no-champ-data");
  });

  it("ready + PARTIAL + absent → loading (absence unproven, keep loading)", () => {
    expect(selectChampionSlotStat("ready", partial(), "9999").status).toBe("loading");
  });

  it("a partial dataset resolving to complete flips absence to no-champ-data", () => {
    // Same augment (9999) absent in both; partial keeps loading, complete decides.
    expect(selectChampionSlotStat("ready", partial(), "9999").status).toBe("loading");
    expect(selectChampionSlotStat("ready", nocturne(), "9999").status).toBe("no-champ-data");
  });

  it("takes no global argument — a global record cannot influence the outcome", () => {
    // The function's only inputs are load status, the champion dataset and the
    // augment id. There is structurally no channel for a global value.
    expect(selectChampionSlotStat.length).toBe(3);
  });
});

describe("resolvedStatToAramggStat — always champion provenance", () => {
  it("maps a resolved selection to provenance 'champion' with championId", () => {
    const sel = selectAugmentStat(nocturne(), "1006");
    if (sel.kind !== "resolved") throw new Error("unreachable");
    const stat = resolvedStatToAramggStat(sel.stat);
    expect(stat.provenance).toBe("champion");
    expect(stat.championId).toBe("56");
    expect(stat.tierLetter).toBe("S+");
    expect(stat.grade).toBe("hot");
    expect(stat.rawWinRate).toBe("0.480096");
  });
});

describe("extractChampionFlightObject — parse the embedded flight payload", () => {
  it("extracts the augments object from an escaped Next.js flight string", () => {
    // Representative escaped push, as it appears inside the server-rendered HTML.
    const html =
      'self.__next_f.push([1,"31:T660c,{\\"augments\\":{\\"1006\\":{\\"tier\\":\\"1\\",\\"rank\\":\\"26\\",\\"win_rate\\":\\"0.480096\\",\\"num_games\\":\\"3768\\",\\"pick_rate\\":\\"0.093247\\"}},\\"tier\\":\\"4\\",\\"win_rate\\":\\"0.464797\\"}"])';
    const obj = extractChampionFlightObject(html) as { augments: Record<string, unknown> };
    expect(obj.augments["1006"]).toMatchObject({ tier: "1", win_rate: "0.480096" });
  });

  it("extracts from a raw (unescaped) RSC flight stream too", () => {
    const rsc = '31:T660c,{"augments":{"1006":{"tier":"1","rank":"26","win_rate":"0.480096"}},"tier":"4"}\n';
    const obj = extractChampionFlightObject(rsc) as { augments: Record<string, unknown> };
    expect(obj.augments["1006"]).toMatchObject({ tier: "1", win_rate: "0.480096" });
  });

  it("returns null when there is no augments block", () => {
    expect(extractChampionFlightObject("no flight data here")).toBeNull();
  });
});
