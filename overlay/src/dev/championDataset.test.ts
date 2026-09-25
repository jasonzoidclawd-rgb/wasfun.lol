/**
 * Complete per-champion augment-file fetch adapter + champion-id/patch cache +
 * ownership token (PR #46 Sections 3–4). The overlay reads the AUTHORITATIVE
 * complete file `/data/champion-augments/{id}.json` (every augment the champion
 * has data for) — NOT the champion page's ~60-augment subset. The dataset is
 * fetched ONCE when the final champion becomes known, cached by (championId,
 * patch), and a stale response from a superseded champion can never publish.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ChampionDatasetCache,
  championOwnershipCurrent,
  loadChampionAugmentDataset,
  parseChampionAugmentsFile,
  type ChampionOwnershipToken,
} from "./championDataset";
import { selectChampionSlotStat, type ChampionAugmentDataset } from "./championStats";

// The complete file is a list of [championId, statsJSONString] pairs, exactly
// as ARAMGG serves `/data/champion-augments/{id}.json`.
function fileFor(championId: string, winRate: string): string {
  const inner = JSON.stringify({
    augments: {
      "1006": { tier: "1", rank: "26", win_rate: winRate, num_games: "3768", pick_rate: "0.093247" },
    },
    tier: "4",
    win_rate: "0.464797",
  });
  return JSON.stringify([[championId, inner]]);
}

function emptyFileFor(championId: string): string {
  return JSON.stringify([[championId, JSON.stringify({ augments: {} })]]);
}

function okFetch(body: string): typeof fetch {
  return vi.fn(async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

describe("parseChampionAugmentsFile — [id, jsonString] list", () => {
  it("extracts the matching champion's augments object", () => {
    const obj = parseChampionAugmentsFile(fileFor("142", "0.42575"), "142") as {
      augments: Record<string, unknown>;
    };
    expect(obj.augments["1006"]).toMatchObject({ tier: "1", win_rate: "0.42575" });
  });

  it("returns null when no entry matches the champion id", () => {
    expect(parseChampionAugmentsFile(fileFor("103", "0.5"), "142")).toBeNull();
  });

  it("returns null on malformed text instead of throwing", () => {
    expect(parseChampionAugmentsFile("not json", "142")).toBeNull();
  });
});

describe("loadChampionAugmentDataset — fetch + parse the complete file", () => {
  it("resolves the champion's complete augment table, marked complete", async () => {
    const fetchImpl = okFetch(fileFor("56", "0.480096"));
    const ds = await loadChampionAugmentDataset(fetchImpl, "56", "16.14");
    expect(ds.championId).toBe("56");
    expect(ds.source).toContain("/data/champion-augments/56.json");
    expect(ds.completeness).toBe("complete");
    expect(ds.loadedCount).toBe(1);
    expect(ds.statsByAugmentId.get("1006")!.winRatePercent).toBe("48.0096");
  });

  it("throws explicitly when the file carries no matching augments block", async () => {
    const fetchImpl = okFetch("[]");
    await expect(loadChampionAugmentDataset(fetchImpl, "56", "16.14")).rejects.toThrow();
  });

  it("rejects complete zero-row data before it can publish no-champ-data", async () => {
    let dataset: ChampionAugmentDataset | null = null;
    let status: "ready" | "error" = "ready";
    try {
      dataset = await loadChampionAugmentDataset(okFetch(emptyFileFor("56")), "56", "16.14");
    } catch {
      status = "error";
    }

    expect(status).toBe("error");
    expect(dataset).toBeNull();
    expect(selectChampionSlotStat(status, dataset, "1006").status).toBe("error");
  });

  it("throws explicitly on an HTTP error (offline/failure is never silent)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(loadChampionAugmentDataset(fetchImpl, "56", "16.14")).rejects.toThrow();
  });
});

describe("ChampionDatasetCache — one fetch per (championId, patch)", () => {
  it("does not re-fetch for the same champion and patch", async () => {
    const fetchImpl = okFetch(fileFor("56", "0.480096"));
    const cache = new ChampionDatasetCache(fetchImpl);
    const a = await cache.get("56", "16.14");
    const b = await cache.get("56", "16.14");
    expect(a).toBe(b); // same cached instance
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent in-flight requests for the same key", async () => {
    const fetchImpl = okFetch(fileFor("56", "0.480096"));
    const cache = new ChampionDatasetCache(fetchImpl);
    const [a, b] = await Promise.all([cache.get("56", "16.14"), cache.get("56", "16.14")]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches a new dataset when the champion changes", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new Response(fileFor(url.includes("/103") ? "103" : "56", "0.480096"), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const cache = new ChampionDatasetCache(fetchImpl);
    await cache.get("56", "16.14");
    await cache.get("103", "16.14");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fetches again when the patch changes for the same champion", async () => {
    const fetchImpl = okFetch(fileFor("56", "0.480096"));
    const cache = new ChampionDatasetCache(fetchImpl);
    await cache.get("56", "16.14");
    await cache.get("56", "16.15");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not cache an invalid complete dataset and retries the same key successfully", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(emptyFileFor("56"), { status: 200 }))
      .mockResolvedValueOnce(new Response(fileFor("56", "0.480096"), { status: 200 })) as unknown as typeof fetch;
    const cache = new ChampionDatasetCache(fetchImpl);

    await expect(cache.get("56", "16.14")).rejects.toThrow(/complete.*zero usable/i);
    expect(cache.has("56", "16.14")).toBe(false);
    expect(cache.peek("56", "16.14")).toBeNull();

    const recovered = await cache.get("56", "16.14");
    expect(recovered.loadedCount).toBe(1);
    expect(recovered.statsByAugmentId.get("1006")?.winRatePercent).toBe("48.0096");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("championOwnershipCurrent — stale response cannot publish", () => {
  const base: ChampionOwnershipToken = {
    gameEpoch: 1,
    championGeneration: 4,
    championId: "56",
    requestId: 7,
    patch: "16.14",
  };

  it("permits a publish only when every ownership field still matches", () => {
    expect(championOwnershipCurrent(base, { ...base })).toBe(true);
  });

  it("rejects an old champion response after a champion change", () => {
    // Response captured for champion 56 generation 4; current is champion 103 gen 5.
    expect(
      championOwnershipCurrent(base, { ...base, championId: "103", championGeneration: 5 }),
    ).toBe(false);
  });

  it("rejects a response from a superseded request id", () => {
    expect(championOwnershipCurrent(base, { ...base, requestId: 8 })).toBe(false);
  });

  it("rejects a response from an older patch", () => {
    expect(championOwnershipCurrent(base, { ...base, patch: "16.15" })).toBe(false);
  });

  it("rejects a response after a foreground/game epoch change", () => {
    expect(championOwnershipCurrent(base, { ...base, gameEpoch: 2 })).toBe(false);
  });
});
