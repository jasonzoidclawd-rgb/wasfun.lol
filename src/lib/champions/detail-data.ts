import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeAugmentSet } from "@/lib/data/augment-set";
import { augmentStatsEnabled, stripAugmentStats } from "@/lib/stats/kill-switch";
import type { ScoredAugment } from "@/lib/scoring/oracle-score";
import type {
  AbilityProfile,
  ChampionBaseStats,
  ChampionTag,
  PoolRules,
} from "@/lib/types";

export interface ChampionDetailChampion {
  slug: string;
  name: string;
  title?: string;
  tier: string | null;
  rank: number | null;
  win_rate: number | null;
  pick_rate: number | null;
  tags: string[];
  classes?: string[];
  last_changed?: string;
  icon: string;
  baseStats?: ChampionBaseStats;
  kit_tags?: ChampionTag[];
}

export interface ChampionDetailAugment extends ScoredAugment {
  slug: string;
  name: string;
  rarity: "prismatic" | "gold" | "silver";
  win_rate: number | null;
  icon: string;
  set?: string;
  wikiSet?: string;
  wikiDescription?: string;
  kit_tags?: ChampionTag[];
}

export interface ChampionDetailCombo {
  champion: string;
  augment: string;
  augmentSlug?: string;
  tier: "S" | "A" | "B" | "C";
  ref?: string;
}

export interface ChampionDetailData {
  champions: ChampionDetailChampion[];
  augments: ChampionDetailAugment[];
  combos: ChampionDetailCombo[];
  poolRules: PoolRules;
  patch: string;
  abilities: Record<string, AbilityProfile>;
}

export type ChampionDetailDataSource = "public" | "member";

async function readJson<T>(base: string, filename: string): Promise<T> {
  return JSON.parse(await readFile(path.join(base, filename), "utf-8")) as T;
}

export async function loadChampionDetailData(
  source: ChampionDetailDataSource,
): Promise<ChampionDetailData> {
  const base =
    source === "member"
      ? path.join(process.cwd(), "data", "internal")
      : path.join(process.cwd(), "public", "data");

  const [championsData, augmentsData, combosData, poolRules] = await Promise.all([
    readJson<{ champions: ChampionDetailChampion[]; patch?: string }>(
      base,
      "champions.json",
    ),
    readJson<{ augments: ChampionDetailAugment[] }>(base, "augments.json"),
    readJson<{ combos: ChampionDetailCombo[] }>(base, "combos.json"),
    readJson<PoolRules>(base, "pool-rules.json"),
  ]);

  let abilities: Record<string, AbilityProfile> = {};
  try {
    abilities = (
      await readJson<{ profiles?: Record<string, AbilityProfile> }>(
        base,
        "abilities.json",
      )
    ).profiles ?? {};
  } catch {
    // abilities.json is optional during early generation; callers hide ability UI.
  }

  const statsOn = augmentStatsEnabled();
  return {
    champions: championsData.champions,
    augments: augmentsData.augments.map((augment) => {
      const row = { ...augment, set: normalizeAugmentSet(augment.set, augment.wikiSet) };
      return statsOn ? row : stripAugmentStats(row);
    }),
    combos: combosData.combos,
    poolRules,
    patch: championsData.patch ?? "",
    abilities,
  };
}
