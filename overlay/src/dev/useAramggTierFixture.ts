/**
 * DEVELOPMENT-ONLY React hook that loads the ARAMGG source and resolves each
 * Mayhem augment identity to a canonical ARAMGG record. Owns the live fetch,
 * the transparent dev cache (used only as a fallback AFTER ≥1 successful
 * fetch), force-refresh, and per-augment match logging.
 *
 * It NEVER produces synthetic statistics: an augment that does not resolve to a
 * live ARAMGG stat is simply absent from `resolvedBySlug` (diagnosed by the
 * debug panel, never faked).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAramggRaws,
  normalizeIconBase,
  parseAramggSource,
  resolveAugmentId,
  resolveOcrTitle,
  type AramggRaws,
  type AramggSource,
  type AramggStat,
  type RiotTitleRejection,
  type RiotTitleResolution,
} from "./aramggSource";
import { ChampionDatasetCache } from "./championDataset";
import {
  resolvedStatToAramggStat,
  selectChampionSlotStat,
  type ChampionAugmentDataset,
} from "./championStats";
import type { AramggFixtureCard } from "./tierFixture";

/** Minimal Mayhem augment identity the resolver needs (structural). */
export interface MayhemAugmentIdentity {
  slug: string;
  icon?: string;
  name_zh_CN?: string;
}

/**
 * Staged identity resolution for ONE OCR card title. The stages are explicit
 * so diagnostics can distinguish "Riot identity unresolved" from "Riot
 * identity resolved but ARAMGG record missing". The card icon is never
 * consulted — quest cards replace or obscure it.
 */
export type SlotAramggResolution =
  | {
      kind: "matched"; // champion-specific stat for the current champion
      riot: RiotTitleResolution;
      stat: AramggStat;
      localSlug: string | null;
    }
  | {
      kind: "no-data"; // COMPLETE champion dataset has no row → NO CHAMP DATA
      riot: RiotTitleResolution;
      localSlug: string | null;
    }
  | {
      kind: "loading"; // champion dataset still loading / partial (absence unproven)
      riot: RiotTitleResolution;
      localSlug: string | null;
    }
  | {
      kind: "error"; // champion dataset fetch failed → DATA ERROR (never global)
      riot: RiotTitleResolution;
      localSlug: string | null;
    }
  | {
      kind: "unmatched"; // Riot identity unresolved (rejection carries stage/reason)
      rejection: RiotTitleRejection;
    };

export interface AramggFixtureState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** True when the ready source came from the dev cache, not a live fetch. */
  fromCache: boolean;
  patch: string | null;
  fetchedAt: number | null;
  sourceUrls: AramggSource["sourceUrls"] | null;
  /** slug → resolved record, only for augments matched to a LIVE stat. */
  resolvedBySlug: Map<string, AramggFixtureCard>;
  /**
   * OCR title → staged canonical resolution (zh-TW Riot catalog → numeric ID →
   * ARAMGG stats). Null until the source is ready.
   */
  resolveSlotTitle: ((ocrTitle: string) => SlotAramggResolution) | null;
  /** Current champion-dataset publication ownership. */
  championRequestId: number;
  championPatch: string | null;
  /** Load status of the current champion's complete dataset (drives slot states). */
  championDataStatus: "idle" | "loading" | "ready" | "error";
  /** Completeness of the active champion dataset, or null when none is active. */
  championCompleteness: "partial" | "complete" | null;
  /** Augment rows loaded for the active champion dataset (diagnostic). */
  championLoadedCount: number | null;
  refresh: () => void;
}

// v2: raws now include the Riot zh-TW catalog; older cached shapes must not
// be parsed (they would silently lose the canonical zh-TW bridge).
const CACHE_KEY = "mayhem-aramgg-fixture-cache-v2";

interface CacheEntry {
  raws: AramggRaws;
  fetchedAt: number;
}

function readCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed?.raws || typeof parsed.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* dev cache is best-effort; ignore quota/serialization errors */
  }
}

export function useAramggTierFixture(
  enabled: boolean,
  augments: MayhemAugmentIdentity[] | undefined,
  championKey: string | null,
): AramggFixtureState {
  const [source, setSource] = useState<AramggSource | null>(null);
  const [status, setStatus] = useState<AramggFixtureState["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      setStatus("loading");
      setError(null);
      try {
        const raws = await fetchAramggRaws();
        const parsed = parseAramggSource(raws, Date.now());
        if (cancelled) return;
        writeCache({ raws, fetchedAt: parsed.fetchedAt });
        setSource(parsed);
        setFromCache(false);
        setStatus("ready");
      } catch (liveError) {
        if (cancelled) return;
        // Transparent fallback: only a cache written by a PRIOR successful
        // fetch. Labeled `fromCache` so the UI never presents it as live.
        const cached = readCache();
        if (cached) {
          try {
            const parsed = parseAramggSource(cached.raws, cached.fetchedAt);
            if (cancelled) return;
            setSource(parsed);
            setFromCache(true);
            setStatus("ready");
            return;
          } catch {
            /* fall through to error */
          }
        }
        setSource(null);
        setError(liveError instanceof Error ? liveError.message : "ARAMGG load failed");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce]);

  // ─── Champion-FIRST dataset: the current champion's OWN augment table from
  // /champion-stats/{championKey}. Loaded once per (championKey, patch) and
  // guarded so a superseded champion's response can never publish. This — not
  // `top_champions` — is the source of every CHAMP-labeled statistic.
  const championCacheRef = useRef<ChampionDatasetCache | null>(null);
  const championRequestIdRef = useRef(0);
  const [championRequestId, setChampionRequestId] = useState(0);
  const [championDataset, setChampionDataset] = useState<ChampionAugmentDataset | null>(null);
  // Load status of the CURRENT champion's complete dataset. Drives the explicit
  // loading / data-error slot states — there is no global fallback to hide them.
  const [championDataStatus, setChampionDataStatus] =
    useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    const requestId = (championRequestIdRef.current += 1);
    setChampionRequestId(requestId);
    if (!enabled || !source || !championKey) {
      setChampionDataStatus("idle");
      return;
    }
    if (!championCacheRef.current) championCacheRef.current = new ChampionDatasetCache();
    let cancelled = false;
    // A new champion starts loading: never keep showing the previous champion's
    // rows. Absence during loading is `loading`, never NO CHAMP DATA / global.
    setChampionDataStatus("loading");
    void championCacheRef.current
      .get(championKey, source.patch)
      .then((ds) => {
        // Publish only when this request is still the newest (ownership current).
        if (cancelled || championRequestIdRef.current !== requestId) return;
        setChampionDataset(ds);
        setChampionDataStatus("ready");
      })
      .catch((err) => {
        if (cancelled || championRequestIdRef.current !== requestId) return;
        // Champion-data failure is explicit (diagnosed, never faked): the slot
        // shows DATA ERROR — it must NEVER fall back to a global value.
        setChampionDataStatus("error");
        console.info(
          `[aramgg-fixture] champion dataset load failed for ${championKey}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, source, championKey]);

  // Resolve one canonical augment ID to its stat + provenance:
  //   champion dataset row → CHAMP; else explicit global fallback → GLOBAL;
  //   else null → NO CHAMP DATA. A global value is NEVER labeled CHAMP.
  // A dataset for a superseded champion is invalidated the instant the champion
  // changes: only a dataset whose championId matches the CURRENT champion may
  // back a CHAMP statistic — no cascading setState needed to clear it.
  const activeChampionDataset =
    championDataStatus === "ready" &&
    championDataset && championKey && championDataset.championId === championKey &&
      championDataset.patch === source?.patch
      ? championDataset
      : null;

  // Champion-ONLY statistic selection. There is no global fallback: an augment
  // absent from the CURRENT champion's complete table resolves to an explicit
  // non-stat state (loading / no-champ-data / error), never a global value.
  type SlotStatStatus =
    | { status: "resolved"; stat: AramggStat }
    | { status: "loading" }
    | { status: "no-champ-data" }
    | { status: "error" };

  const selectSlotStat = useCallback(
    (augmentId: string): SlotStatStatus => {
      const decided = selectChampionSlotStat(championDataStatus, activeChampionDataset, augmentId);
      if (decided.status === "resolved") {
        return { status: "resolved", stat: resolvedStatToAramggStat(decided.stat) };
      }
      return decided;
    },
    [championDataStatus, activeChampionDataset],
  );

  const resolvedBySlug = useMemo(() => {
    const map = new Map<string, AramggFixtureCard>();
    if (!source || !augments) return map;
    for (const a of augments) {
      const res = resolveAugmentId(
        { iconBase: normalizeIconBase(a.icon), localizedName: a.name_zh_CN },
        source.catalog,
      );
      if (res.augmentId === null) continue;
      const slot = selectSlotStat(res.augmentId);
      if (slot.status !== "resolved") continue;
      if (res.method === "localized-name") {
        // Explicitly log the last-resort match path (requirement).
        console.info(
          `[aramgg-fixture] localized-name fallback: "${a.slug}" → augmentId ${res.augmentId}`,
        );
      }
      map.set(a.slug, { slug: a.slug, stat: slot.stat, method: res.method });
    }
    return map;
  }, [source, augments, selectSlotStat]);

  // augmentId → local slug (unique inversions only) so a canonical Riot match
  // can be labeled with the local catalog slug when one exists.
  const localSlugByAugmentId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const [slug, card] of resolvedBySlug) {
      map.set(card.stat.augmentId, map.has(card.stat.augmentId) ? null : slug);
    }
    return map;
  }, [resolvedBySlug]);

  const resolveSlotTitle = useMemo(() => {
    if (!source) return null;
    return (ocrTitle: string): SlotAramggResolution => {
      const riot = resolveOcrTitle(ocrTitle, source.titleIndex);
      if (riot.augmentId === null) {
        return { kind: "unmatched", rejection: riot };
      }
      if (riot.method === "riot-zh-cn-exact") {
        // Explicitly-logged last resort: Traditional OCR resolved only via the
        // Simplified catalog name.
        console.info(
          `[aramgg-fixture] zh-CN last-resort title match: "${ocrTitle}" → augmentId ${riot.augmentId}`,
        );
      }
      const localSlug = localSlugByAugmentId.get(riot.augmentId) ?? null;
      const slot = selectSlotStat(riot.augmentId);
      switch (slot.status) {
        case "resolved":
          return { kind: "matched", riot, stat: slot.stat, localSlug };
        case "no-champ-data":
          return { kind: "no-data", riot, localSlug };
        case "error":
          return { kind: "error", riot, localSlug };
        case "loading":
          return { kind: "loading", riot, localSlug };
      }
    };
  }, [source, localSlugByAugmentId, selectSlotStat]);

  return {
    status,
    error,
    fromCache,
    patch: source?.patch ?? null,
    fetchedAt: source?.fetchedAt ?? null,
    sourceUrls: source?.sourceUrls ?? null,
    resolvedBySlug,
    resolveSlotTitle,
    championRequestId,
    championPatch: activeChampionDataset?.patch ?? source?.patch ?? null,
    championDataStatus,
    championCompleteness: activeChampionDataset?.completeness ?? null,
    championLoadedCount: activeChampionDataset?.loadedCount ?? null,
    refresh,
  };
}
