import { describe, expect, it } from "vitest";
import type { OfferState } from "./offerLifecycle";
import type { IdentityRecord } from "./surfaceGeometry";

type SlotStat = {
  canonicalAugmentId: string;
  status: "loading" | "no-data" | "resolved";
  tier?: string;
  winRate?: string;
};

type RefreshResult = {
  changed: boolean;
  republish: boolean;
  identityRecords: Array<IdentityRecord<SlotStat> | null>;
  offer: OfferState<SlotStat>;
};

type RefreshSameOfferData = (input: {
  identityRecords: Array<IdentityRecord<SlotStat> | null>;
  offer: OfferState<SlotStat>;
  resolveByCanonicalId: (
    canonicalAugmentId: string,
    regionIndex: number,
  ) => { canonicalAugmentId: string; resolution: SlotStat } | null;
}) => RefreshResult;

function refreshBoundary(): RefreshSameOfferData {
  const modules = import.meta.glob("./sameOfferDataRefresh.ts", { eager: true }) as Record<
    string,
    { refreshSameOfferData?: RefreshSameOfferData }
  >;
  const refresh = modules["./sameOfferDataRefresh.ts"]?.refreshSameOfferData;
  expect(
    typeof refresh,
    "same-offer data recovery needs one executable refreshSameOfferData boundary",
  ).toBe("function");
  return refresh as RefreshSameOfferData;
}

const ids = ["1051", "2016", "1237"] as const;
const fingerprints = ["fp-left", "fp-middle", "fp-right"] as const;
const titles = ["疾速追擊", "不祥契約", "靈光一閃"] as const;
const slotGenerations = [9, 4, 7] as const;

function visibleOffer(resolutions: SlotStat[]): OfferState<SlotStat> {
  return {
    generation: 41,
    latched: true,
    screenEmptyPasses: 0,
    surfaceVisible: true,
    slots: ids.map((_, regionIndex) => ({
      regionIndex,
      fingerprint: fingerprints[regionIndex],
      title: titles[regionIndex],
      resolution: resolutions[regionIndex],
      validated: true,
    })),
  };
}

function identityRecords(resolutions: SlotStat[]): Array<IdentityRecord<SlotStat>> {
  return ids.map((augmentId, regionIndex) => ({
    fingerprint: fingerprints[regionIndex],
    resolution: resolutions[regionIndex],
    resolvedAt: 1_000,
    championGeneration: 6,
    augmentId,
    ocrTitle: titles[regionIndex],
    foregroundEpoch: 3,
    gameEpoch: 8,
    offerGeneration: 41,
    slotGeneration: slotGenerations[regionIndex],
    ocrRunId: 12 + regionIndex,
    championRequestId: 20,
    championPatch: "26.13",
    conflictCount: 0,
  }));
}

describe("refreshSameOfferData", () => {
  it("atomically refreshes all three visible slots without replacing same-offer identity", () => {
    const initial = ids.map((canonicalAugmentId, index) => ({
      canonicalAugmentId,
      status: index === 1 ? "no-data" as const : "loading" as const,
    }));
    const offer = visibleOffer(initial);
    const records = identityRecords(initial);
    const calls: Array<[string, number]> = [];

    const result = refreshBoundary()({
      identityRecords: records,
      offer,
      resolveByCanonicalId: (canonicalAugmentId, regionIndex) => {
        calls.push([canonicalAugmentId, regionIndex]);
        return {
          canonicalAugmentId,
          resolution: {
            canonicalAugmentId,
            status: "resolved",
            tier: ["S", "A", "B"][regionIndex],
            winRate: ["52.0%", "50.8%", "49.6%"][regionIndex],
          },
        };
      },
    });

    expect(calls).toEqual(ids.map((id, index) => [id, index]));
    expect(result.changed).toBe(true);
    expect(result.republish).toBe(true);
    expect(result.identityRecords.map((record) => record?.resolution?.status)).toEqual([
      "resolved",
      "resolved",
      "resolved",
    ]);
    expect(result.offer.slots.map((slot) => slot.resolution)).toEqual(
      result.identityRecords.map((record) => record?.resolution),
    );
    expect(result.offer).toMatchObject({
      generation: 41,
      latched: true,
      screenEmptyPasses: 0,
      surfaceVisible: true,
    });
    expect(result.offer.slots.map(({ fingerprint, title }) => ({ fingerprint, title }))).toEqual(
      offer.slots.map(({ fingerprint, title }) => ({ fingerprint, title })),
    );
    expect(
      result.identityRecords.map((record) => ({
        augmentId: record?.augmentId,
        fingerprint: record?.fingerprint,
        offerGeneration: record?.offerGeneration,
        slotGeneration: record?.slotGeneration,
        ocrRunId: record?.ocrRunId,
      })),
    ).toEqual(
      records.map((record) => ({
        augmentId: record.augmentId,
        fingerprint: record.fingerprint,
        offerGeneration: record.offerGeneration,
        slotGeneration: record.slotGeneration,
        ocrRunId: record.ocrRunId,
      })),
    );
    expect(offer.slots.map((slot) => slot.resolution?.status)).toEqual([
      "loading",
      "no-data",
      "loading",
    ]);
  });

  it("rejects a refreshed statistic whose canonical id conflicts with the current slot", () => {
    const initial = ids.map((canonicalAugmentId) => ({
      canonicalAugmentId,
      status: "loading" as const,
    }));
    const offer = visibleOffer(initial);
    const records = identityRecords(initial);

    const result = refreshBoundary()({
      identityRecords: records,
      offer,
      resolveByCanonicalId: (canonicalAugmentId, regionIndex) => regionIndex === 1
        ? {
            canonicalAugmentId: "9999",
            resolution: { canonicalAugmentId: "9999", status: "resolved", tier: "S" },
          }
        : {
            canonicalAugmentId,
            resolution: { canonicalAugmentId, status: "resolved", tier: "A" },
          },
    });

    expect(result.identityRecords[1]).toEqual(records[1]);
    expect(result.offer.slots[1]).toEqual(offer.slots[1]);
    expect(result.identityRecords[1]?.augmentId).toBe("2016");
    expect(result.offer.slots[1].resolution?.canonicalAugmentId).toBe("2016");
    expect(result.identityRecords[0]?.resolution?.status).toBe("resolved");
    expect(result.identityRecords[2]?.resolution?.status).toBe("resolved");
  });

  it("reports no change and no republish when the derived content is already current", () => {
    const current = ids.map((canonicalAugmentId, index) => ({
      canonicalAugmentId,
      status: "resolved" as const,
      tier: ["S", "A", "B"][index],
      winRate: ["52.0%", "50.8%", "49.6%"][index],
    }));
    const offer = visibleOffer(current);
    const records = identityRecords(current);

    const result = refreshBoundary()({
      identityRecords: records,
      offer,
      resolveByCanonicalId: (canonicalAugmentId, regionIndex) => ({
        canonicalAugmentId,
        resolution: current[regionIndex],
      }),
    });

    expect(result.changed).toBe(false);
    expect(result.republish).toBe(false);
    expect(result.identityRecords).toEqual(records);
    expect(result.offer).toEqual(offer);
  });
});
