import { useCallback } from "react";
import type { AramggFixtureCard } from "./tierFixture";

export interface MayhemAugmentIdentity {
  slug: string;
  icon?: string;
  name_zh_CN?: string;
}

export type SlotAramggResolution =
  | {
      kind: "matched";
      riot: { augmentId: string; canonicalName: string | null; zhTwName: string | null; method: string; confidence: number };
      stat: AramggFixtureCard["stat"];
      localSlug: string | null;
    }
  | {
      kind: "no-data";
      riot: { augmentId: string; canonicalName: string | null; zhTwName: string | null; method: string; confidence: number };
      localSlug: string | null;
    }
  | {
      kind: "loading";
      riot: { augmentId: string; canonicalName: string | null; zhTwName: string | null; method: string; confidence: number };
      localSlug: string | null;
    }
  | {
      kind: "error";
      riot: { augmentId: string; canonicalName: string | null; zhTwName: string | null; method: string; confidence: number };
      localSlug: string | null;
    }
  | {
      kind: "unmatched";
      rejection: { augmentId: null; reason: string; detail?: string };
    };

export interface AramggFixtureState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  fromCache: boolean;
  patch: string | null;
  fetchedAt: number | null;
  sourceUrls: { stats: string; catalog: string; catalogZhTw?: string } | null;
  resolvedBySlug: Map<string, AramggFixtureCard>;
  resolveSlotTitle: ((ocrTitle: string) => SlotAramggResolution) | null;
  championRequestId: number;
  championPatch: string | null;
  championDataStatus: "idle" | "loading" | "ready" | "error";
  championCompleteness: "partial" | "complete" | null;
  championLoadedCount: number | null;
  refresh: () => void;
}

export function useAramggTierFixture(
  _enabled: boolean,
  _augments: MayhemAugmentIdentity[] | undefined,
  _championKey: string | null,
): AramggFixtureState {
  void _enabled;
  void _augments;
  void _championKey;
  const refresh = useCallback(() => {}, []);
  return {
    status: "idle",
    error: null,
    fromCache: false,
    patch: null,
    fetchedAt: null,
    sourceUrls: null,
    resolvedBySlug: new Map(),
    resolveSlotTitle: null,
    championRequestId: 0,
    championPatch: null,
    championDataStatus: "idle",
    championCompleteness: null,
    championLoadedCount: null,
    refresh,
  };
}
